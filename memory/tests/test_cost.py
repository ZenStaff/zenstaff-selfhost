"""Ingest cost controls (2026-11-14): context window of previous episodes, batched edge
resolution (one LLM call per episode, contradiction candidates that share an entity), the open
promises the review sees, static prompt blocks in the cached system prompt, 1-hour cache
pricing, and episodes stopped by the monthly quota kept and retried instead of dropped."""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest
from graphiti_core.edges import EntityEdge

from app.db import Store
from app.llm import CACHE_WRITE_1H_X, UsageMeter, cache_layout, call_cost, current_meter
from app.resolve import resolve_edges_batched
from app.review import _open_promises

from .conftest import ADMIN, dt
from .test_quota_reservations import costly_ingest, episode

ADM = {"Authorization": f"Bearer {ADMIN}"}


def test_static_blocks_go_to_the_cached_system_prompt():
    content = (
        "<ENTITY TYPES>\n[{\"id\": 0, \"name\": \"Person\"}]\n</ENTITY TYPES>\n\n"
        "<PREVIOUS MESSAGES>\n[\"ieri\"]\n</PREVIOUS MESSAGES>\n\n"
        "<CURRENT MESSAGE>\nAna a hotărât X.\n</CURRENT MESSAGE>\n\n"
        + "Extract the entities. " * 40
        + "\n<EXAMPLE>\nInput: Bob. Output: Bob\n</EXAMPLE>\n"
    )
    system, convo = cache_layout("You extract entities.", [{"role": "user", "content": content}])
    assert "<EXAMPLE>" in system and "<ENTITY TYPES>" in system and "Extract the entities." in system
    user = convo[0]["content"]
    assert "<CURRENT MESSAGE>" in user and "<PREVIOUS MESSAGES>" in user
    assert "<EXAMPLE>" not in user and "<ENTITY TYPES>" not in user and "Extract the entities." not in user
    # the system prompt is the same for another episode (cacheable)
    other = content.replace("Ana a hotărât X.", "Ion a promis Y.").replace("ieri", "azi")
    assert cache_layout("You extract entities.", [{"role": "user", "content": other}])[0] == system


def test_one_hour_cache_writes_cost_twice_the_input_price():
    base = call_cost("claude-haiku-5-5", 0, 0, cache_write=1_000_000)
    one_hour = call_cost("claude-haiku-5-5", 0, 0, cache_write=1_000_000, cache_write_1h=1_000_000)
    assert base == pytest.approx(0.125) and one_hour == pytest.approx(0.10 * CACHE_WRITE_1H_X)
    m = UsageMeter()
    m.add(0, 0, model="claude-haiku-5-5", cache_write=1000, cache_write_1h=400, step="x")
    assert m.cost_usd == pytest.approx((600 * 0.125 + 400 * 0.2) / 1e6)


async def test_previous_episodes_are_capped_and_trimmed(env):
    a, _ = await env.company("Firma Context")
    for i in range(6):
        await env.seed.episode(a, f"Episodul {i}: " + "text lung despre furnizori și prețuri " * 30, f"t{i}", f"2026-03-0{i + 1}T10:00:00")
    g = env.engine.g
    try:
        g.previous_episodes, g.previous_episode_chars = 2, 120
        eps = await g.retrieve_episodes(dt("2026-03-09T00:00:00"), last_n=10, group_ids=[a["group_id"]])
        assert len(eps) == 2
        assert all(len(e.content) <= 130 and e.content.endswith("[...]") for e in eps)
        assert {e.content.split(":")[0] for e in eps} == {"Episodul 4", "Episodul 5"}  # the latest ones
        g.previous_episodes = 0
        assert await g.retrieve_episodes(dt("2026-03-09T00:00:00"), last_n=10, group_ids=[a["group_id"]]) == []
    finally:
        g.previous_episodes, g.previous_episode_chars = None, None
    assert len(await g.retrieve_episodes(dt("2026-03-09T00:00:00"), last_n=10, group_ids=[a["group_id"]])) == 6


class StubLLM:
    """Answers the batched resolution call and records what it was sent."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    async def complete_json(self, system, user, max_tokens=300, *, step=""):
        self.calls.append((step, user))
        return self.answer(user)


async def test_batched_resolution_is_one_call_with_candidates_that_share_an_entity(env):
    a, _ = await env.company("Firma Resolve")
    ep_old = await env.seed.episode(a, "vechi", "t-old", "2026-03-01T10:00:00")
    spiga = await env.seed.entity(a, "Brutăria Spiga", "Organization")
    moara = await env.seed.entity(a, "Moara Verde", "Organization")
    ioana = await env.seed.entity(a, "Ioana", "Person")
    vreme = await env.seed.entity(a, "Cluj", "Organization")
    alta = await env.seed.entity(a, "Ploiești", "Organization")
    price = await env.seed.fact(a, moara, spiga, "SUPPLIES", "Moara Verde livrează făina T650 la 3,10 lei/kg", ep_old, "2026-03-01")
    unrelated = await env.seed.fact(a, vreme, alta, "RELATES_TO", "Făina T650 la Cluj și Ploiești costă 3,10 lei/kg", ep_old, "2026-03-01")
    ep_new = await env.seed.episode(a, "nou", "t-new", "2026-03-16T10:00:00")
    g = env.engine.g

    def edge(src, dst, fact, dated=True):
        return EntityEdge(group_id=a["group_id"], source_node_uuid=src.uuid, target_node_uuid=dst.uuid, name="RELATES_TO",
                          fact=fact, episodes=[ep_new.uuid], created_at=dt("2026-03-16"),
                          valid_at=dt("2026-03-16") if dated else None)

    new_price = edge(moara, spiga, "Din 1 aprilie Moara Verde livrează făina T650 la 3,60 lei/kg")
    same = edge(moara, spiga, "Moara Verde livrează făina T650 la 3,10 lei/kg")  # verbatim: no model
    undated = edge(ioana, spiga, "Ioana este administratorul Brutăriei Spiga", dated=False)

    def answer(user):
        stored = user.split("<STORED FACTS>\n")[1].split("\n</STORED FACTS>")[0].splitlines()
        n_price = next(int(line.split(".")[0]) for line in stored if "3,10 lei/kg" in line and "Moara" in line)
        return {"facts": [
            {"id": 0, "duplicate_of": [], "contradicts": [n_price, 99]},
            {"id": 2, "valid_at": "2026-03-16T00:00:00Z", "invalid_at": None},
        ]}

    stub = StubLLM(answer)
    clients = g.clients.model_copy(update={"llm_client": stub})
    invalidated_by: dict = {}
    resolved, invalidated, new = await resolve_edges_batched(
        clients, [new_price, same, undated], ep_new, [spiga, moara, ioana], {}, {}, invalidated_by, max_candidates=5)
    assert len(stub.calls) == 1 and stub.calls[0][0] == "zm.resolve_edges"
    sent = stub.calls[0][1]
    assert "Cluj și Ploiești" not in sent  # shares no entity with any new fact: never a candidate
    assert [e.uuid for e in new] == [new_price.uuid, undated.uuid]
    assert any(e.uuid == price.uuid for e in resolved)  # the verbatim restatement reuses the stored fact
    assert [e.uuid for e in invalidated] == [price.uuid] and invalidated_by == {price.uuid: [new_price.uuid]}
    assert undated.valid_at == dt("2026-03-16")
    assert unrelated.uuid not in {e.uuid for e in resolved + invalidated}


async def test_resolution_survives_a_failed_call(env):
    a, _ = await env.company("Firma Resolve Fail")
    ep = await env.seed.episode(a, "nou", "t-f", "2026-03-16T10:00:00")
    x = await env.seed.entity(a, "Ana", "Person")
    y = await env.seed.entity(a, "Firma Y", "Organization")

    class Broken:
        async def complete_json(self, *a, **k):
            raise RuntimeError("down")

    g = env.engine.g
    clients = g.clients.model_copy(update={"llm_client": Broken()})
    e = EntityEdge(group_id=a["group_id"], source_node_uuid=x.uuid, target_node_uuid=y.uuid, name="RELATES_TO",
                   fact="Ana lucrează la Firma Y", episodes=[ep.uuid], created_at=dt("2026-03-16"))
    resolved, invalidated, new = await resolve_edges_batched(clients, [e], ep, [x, y], {}, {}, {})
    assert [r.uuid for r in new] == [e.uuid] and invalidated == []


async def test_review_sees_only_open_promises_about_the_episode_entities(env):
    a, _ = await env.company("Firma Promisiuni")
    ep = await env.seed.episode(a, "vechi", "t-p", "2026-03-01T10:00:00")
    ana = await env.seed.entity(a, "Ana", "Person")
    client = await env.seed.entity(a, "Client X", "Organization")
    ion = await env.seed.entity(a, "Ion", "Person")
    other = await env.seed.entity(a, "Furnizor Z", "Organization")
    p1 = await env.seed.fact(a, ana, client, "Promise", "Ana a promis oferta clientului X până pe 5 martie", ep, "2026-03-01")
    await env.seed.fact(a, ion, other, "Promise", "Ion a promis plata furnizorului Z până pe 9 martie", ep, "2026-03-01")
    rows = await _open_promises(env.engine.driver, a["group_id"], set(), {ana.uuid})
    assert [r["uuid"] for r in rows] == [p1.uuid]
    assert await _open_promises(env.engine.driver, a["group_id"], set(), set()) == []


async def test_quota_stopped_ingest_is_deferred_and_retried_when_the_quota_has_room(env, monkeypatch):
    a, ha = await env.company("Firma Amanata")
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 3_000}, headers=ADM)
    monkeypatch.setattr(env.engine, "ingest", costly_ingest(env, 4))  # 4 x 1020 tokens > 3,000
    r = await env.client.post("/v1/episodes", json=episode(1), headers=ha)
    assert r.status_code == 202
    await env.app.state.worker.drain()
    ep = env.store.get_episode(a["id"], r.json()["episode_id"])
    assert ep["status"] == "deferred" and ep["error"].startswith("quota_exceeded")
    assert ep["summary"]  # kept for the retry
    assert env.store.reserved_tokens(a["id"]) == 0
    # still full (here: the limit lowered below what is already used): stays deferred, postponed
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 1_000}, headers=ADM)
    assert env.app.state.retry_deferred(time.time() + 1) == 0
    assert env.store.get_episode(a["id"], ep["id"])["status"] == "deferred"
    # the limit is raised (or the month resets): re-queued and ingested
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 0}, headers=ADM)
    assert env.app.state.retry_deferred(time.time() + 3600) == 1
    await env.app.state.worker.drain()
    done = env.store.get_episode(a["id"], ep["id"])
    assert done["status"] == "done" and done["summary"] is None
    assert env.store.reserved_tokens(a["id"]) == 0


def test_old_quota_failures_become_deferred_on_start(tmp_path):
    path = str(tmp_path / "db.sqlite3")
    s = Store(path)
    co = s.create_company("Firma Veche", "k-" + uuid.uuid4().hex)
    co = co[0] if isinstance(co, tuple) else co
    ep = s.insert_episode(co["id"], "k1", "queued", None, {"thread_id": "t"}, "2026-11-09T10:00:00+00:00", "Am hotărât X.")
    s.mark_failed(ep["id"], "quota_exceeded: Quota exceeded: 3,000,000 LLM tokens per month")
    other = s.insert_episode(co["id"], "k2", "queued", None, {"thread_id": "t"}, "2026-11-09T10:00:00+00:00", "Am hotărât Y.")
    s.mark_failed(other["id"], "RuntimeError: boom")
    s2 = Store(path)
    assert s2.get_episode(co["id"], ep["id"])["status"] == "deferred"
    assert s2.get_episode(co["id"], other["id"])["status"] == "failed"
    assert [e["id"] for e in s2.deferred_episodes(time.time())] == [ep["id"]]


def test_quota_alert_in_the_mail_channel_shape():
    from app.quotas import Quotas

    msg = Quotas.as_subject_body({"event": "quota_threshold", "quota": "ingest_tokens_per_month", "threshold_percent": 80,
                                  "company_id": "pe_1", "company_name": "Memoria lui Alex", "period": "2026-11",
                                  "used": 2_400_000, "limit": 3_000_000, "at": "2026-11-09T10:00:00+00:00"})
    assert set(msg) == {"subject", "body"}
    assert "Memoria lui Alex" in msg["subject"] and "80%" in msg["subject"] and "2,400,000" in msg["subject"]
    assert '"company_id": "pe_1"' in msg["body"]


async def test_budget_mode_keeps_only_essential_summaries_late_in_the_month(env, monkeypatch):
    import app.main as main_mod
    from app.gate import GateResult

    a, ha = await env.company("Firma Buget")
    kinds = {"value": ["fact"]}

    async def gate(llm, text, profile=None):
        return GateResult(True, "new information", list(kinds["value"]), True)

    monkeypatch.setattr(main_mod, "novelty_check", gate)
    monkeypatch.setattr(env.engine, "ingest", costly_ingest(env, 1))
    monkeypatch.setattr(env.app.state.quotas, "month_fraction_used", lambda cid: 0.75)

    def body(n):
        return {"summary": f"Furnizorul Moara Verde are sediul în Cluj, depozitul {n} e lângă gară.",
                "source": {"thread_id": f"t-budget-{n}", "timestamp": "2026-11-02T10:00:00Z"}}

    # off (default): a plain fact is ingested
    assert (await env.client.post("/v1/episodes", json=body(1), headers=ha)).status_code == 202
    # on, past 60%: a plain fact is skipped, a promise still goes in
    env.app.state.essential_only_percent = 60
    r = await env.client.post("/v1/episodes", json=body(2), headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "skipped" and "budget mode" in r.json()["reason"]
    kinds["value"] = ["promise", "fact"]
    assert (await env.client.post("/v1/episodes", json=body(3), headers=ha)).status_code == 202
    # on, but the month is young: everything as before
    kinds["value"] = ["fact"]
    monkeypatch.setattr(env.app.state.quotas, "month_fraction_used", lambda cid: 0.2)
    assert (await env.client.post("/v1/episodes", json=body(4), headers=ha)).status_code == 202
    await env.app.state.worker.drain()
