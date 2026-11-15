"""Monthly token quota with reservations (no overshoot, also under concurrency); the
searches-per-minute counter persisted in SQLite (survives a restart)."""

from __future__ import annotations

import asyncio
import threading

import pytest

from app.db import Store
from app.quotas import QuotaExceeded, Quotas

from .conftest import ADMIN

pytestmark = pytest.mark.asyncio
ADM = {"Authorization": f"Bearer {ADMIN}"}
CALL_TEXT = "x" * 4000  # one fake LLM call = 4000 // 4 + 20 = 1020 tokens, estimated exactly


def episode(n: int, thread: str = "thr-r") -> dict:
    return {
        "summary": f"Am hotărât să comandăm {n} kg de făină de la furnizorul Moara Verde, la 3,25 lei/kg.",
        "source": {"thread_id": f"{thread}-{n}", "timestamp": "2026-11-02T10:00:00Z"},
    }


@pytest.fixture
def no_ingest_slow(env, monkeypatch):
    """Ingests that wait until the test lets them finish (their reservations stay held)."""
    go = asyncio.Event()

    async def fake_ingest(group_id, name, body, reference_time, source_description, **kw):
        await go.wait()
        return "graph-ep"

    monkeypatch.setattr(env.engine, "ingest", fake_ingest)
    return go


def costly_ingest(env, calls: int, fail: bool = False):
    """A fake ingest that spends `calls` x 1020 tokens through the (fake) LLM client, like Graphiti."""
    llm = env.engine.g.llm_client

    async def ingest(group_id, name, body, reference_time, source_description, **kw):
        for _ in range(calls):
            await llm.complete_json(CALL_TEXT, "", step="test.extract")
            await asyncio.sleep(0)
        if fail:
            raise RuntimeError("extraction blew up")
        return "graph-ep"

    return ingest


async def test_reservation_settles_with_actual_usage(env, monkeypatch):
    a, ha = await env.company("Firma Settle")
    monkeypatch.setattr(env.engine, "ingest", costly_ingest(env, 3))
    r = await env.client.post("/v1/episodes", json=episode(1), headers=ha)
    assert r.status_code == 202
    gate = r.json()["gate"]["input_tokens"] + r.json()["gate"]["output_tokens"]
    await env.app.state.worker.drain()
    assert env.store.tokens_since(a["id"], 0) == gate + 3 * 1020
    assert env.store.reserved_tokens(a["id"]) == 0
    st = (await env.client.get("/v1/me", headers=ha)).json()["quotas"]["ingest_tokens_per_month"]
    assert st["used"] == gate + 3 * 1020 and st["reserved"] == 0


async def test_reservation_released_on_failure(env, monkeypatch):
    a, ha = await env.company("Firma Fail")
    monkeypatch.setattr(env.engine, "ingest", costly_ingest(env, 2, fail=True))
    r = await env.client.post("/v1/episodes", json=episode(1), headers=ha)
    assert r.status_code == 202
    await env.app.state.worker.drain()
    ep = (await env.client.get(f"/v1/episodes/{r.json()['episode_id']}", headers=ha)).json()
    assert ep["status"] == "failed" and "blew up" in ep["error"]
    assert env.store.reserved_tokens(a["id"]) == 0
    gate = r.json()["gate"]["input_tokens"] + r.json()["gate"]["output_tokens"]
    assert env.store.tokens_since(a["id"], 0) == gate + 2 * 1020  # the tokens spent still count


async def test_skipped_summary_releases_the_reservation(env):
    a, ha = await env.company("Firma Skip")
    r = await env.client.post("/v1/episodes", json={"summary": "Am vorbit despre vreme și despre weekend, nimic important de reținut aici.",
                                                    "source": {"thread_id": "t-skip", "timestamp": "2026-11-02T10:00:00Z"}}, headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    assert env.store.reserved_tokens(a["id"]) == 0


async def test_concurrent_ingests_never_overshoot(env, monkeypatch):
    a, ha = await env.company("Firma Concurenta")
    b, hb = await env.company("Firma Vecina")
    limit = 12_000
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": limit}, headers=ADM)
    # each ingest really costs 4 x 1020 tokens, far more than its reservation estimate (~900): the
    # running jobs must extend their reservations and stop before the quota is crossed
    monkeypatch.setattr(env.engine, "ingest", costly_ingest(env, 4))
    rs = await asyncio.gather(*[env.client.post("/v1/episodes", json=episode(n), headers=ha) for n in range(12)])
    codes = [r.status_code for r in rs]
    assert codes.count(202) >= 1, codes
    assert all(r.json()["quota"] == "ingest_tokens_per_month" for r in rs if r.status_code == 429)
    await env.app.state.worker.drain()
    used = env.store.tokens_since(a["id"], 0)
    assert used <= limit, (used, limit)  # 12 x ~4.4K tokens wanted, never more than the quota spent
    assert env.store.reserved_tokens(a["id"]) == 0
    eps = [env.store.get_episode(a["id"], r.json()["episode_id"]) for r in rs if r.status_code == 202]
    stopped = [e for e in eps if e["status"] == "deferred"]  # kept for a retry when the quota has room
    assert all(e["error"].startswith("quota_exceeded") for e in stopped)
    assert any(e["status"] == "done" for e in eps)
    assert codes.count(429) + len(stopped) >= 1
    # whatever is left is less than one more ingest: the next summary is refused up front
    # unless its reservation fits (and then its ingest is stopped at the quota again)
    r = await env.client.post("/v1/episodes", json=episode(99), headers=ha)
    assert r.status_code in (202, 429)
    await env.app.state.worker.drain()
    assert env.store.tokens_since(a["id"], 0) <= limit and env.store.reserved_tokens(a["id"]) == 0
    # the other company is unaffected
    assert (await env.client.post("/v1/episodes", json=episode(1, "thr-b"), headers=hb)).status_code == 202
    await env.app.state.worker.drain()


async def test_admission_reserves_atomically(env, no_ingest_slow):
    a, ha = await env.company("Firma Admitere")
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 2_000}, headers=ADM)
    rs = await asyncio.gather(*[env.client.post("/v1/episodes", json=episode(n), headers=ha) for n in range(8)])
    codes = [r.status_code for r in rs]
    # each request reserves ~874 tokens (gate + ingest estimate) before its gate runs and keeps
    # ~145 for the pending ingest: only a few fit in 2,000, whatever the interleaving
    assert 1 <= codes.count(202) <= 4 and codes.count(429) >= 4, codes
    status = (await env.client.get("/v1/me", headers=ha)).json()["quotas"]["ingest_tokens_per_month"]
    assert status["used"] + status["reserved"] <= 2_000
    no_ingest_slow.set()
    await env.app.state.worker.drain()
    assert env.store.reserved_tokens(a["id"]) == 0


async def test_reserve_is_atomic_across_threads_and_connections(tmp_path):
    path = str(tmp_path / "q.sqlite3")
    stores = [Store(path), Store(path)]  # two connections, like two API processes on one volume
    company, _ = stores[0].create_company("Firma Atomica")
    results: list[str | None] = []
    lock = threading.Lock()

    def worker(i: int):
        rid, _ = stores[i % 2].reserve_tokens(company["id"], 100, 1_000, 0.0)
        with lock:
            results.append(rid)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(1 for r in results if r) == 10
    assert stores[1].reserved_tokens(company["id"]) == 1_000


async def test_search_counter_survives_restart(env):
    a, ha = await env.company("Firma Restart")
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"searches_per_minute": 2}, headers=ADM)
    for _ in range(2):
        assert (await env.client.get("/v1/search", params={"q": "făină"}, headers=ha)).status_code == 200
    # a fresh process: new connection to the same database file, new Quotas object
    db_path = env.store._conn.execute("PRAGMA database_list").fetchone()[2]
    fresh = Quotas(Store(db_path), {"episodes_per_day": 0, "ingest_tokens_per_month": 0, "searches_per_minute": 120})
    with pytest.raises(QuotaExceeded) as e:
        fresh.check_search(a["id"])
    assert e.value.quota == "searches_per_minute" and e.value.used == 2
    assert fresh.status(a["id"])["searches_per_minute"]["used"] == 2
    r = await env.client.get("/v1/search", params={"q": "făină"}, headers=ha)
    assert r.status_code == 429 and 0 < r.json()["retry_after_seconds"] <= 61
