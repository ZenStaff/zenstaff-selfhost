"""Per-company quotas: 429 bodies, admin overrides, monthly alerts (log + webhook)."""

from __future__ import annotations

import logging

import pytest

from .conftest import ADMIN

pytestmark = pytest.mark.asyncio
ADM = {"Authorization": f"Bearer {ADMIN}"}


def episode(n: int, thread: str = "thr-q") -> dict:
    return {
        "summary": f"Am hotărât să comandăm {n} kg de făină de la furnizorul Moara Verde, la 3,25 lei/kg.",
        "source": {"thread_id": f"{thread}-{n}", "timestamp": "2026-11-02T10:00:00Z"},
    }


@pytest.fixture
def no_ingest(env, monkeypatch):
    async def fake_ingest(group_id, name, body, reference_time, source_description, **kw):
        return "graph-ep"

    monkeypatch.setattr(env.engine, "ingest", fake_ingest)


async def test_episodes_per_day_429_and_isolation(env, no_ingest):
    a, ha = await env.company("Firma A")
    b, hb = await env.company("Firma B")
    r = await env.client.put(f"/admin/companies/{a['id']}/limits", json={"episodes_per_day": 2}, headers=ADM)
    assert r.status_code == 200, r.text
    assert r.json()["quotas"]["episodes_per_day"] == {**r.json()["quotas"]["episodes_per_day"], "limit": 2, "source": "override"}
    for n in (1, 2):
        assert (await env.client.post("/v1/episodes", json=episode(n), headers=ha)).status_code == 202
    r = await env.client.post("/v1/episodes", json=episode(3), headers=ha)
    assert r.status_code == 429
    body = r.json()
    assert body["error"] == "quota_exceeded" and body["quota"] == "episodes_per_day"
    assert body["limit"] == 2 and body["used"] == 2
    assert body["resets_at"].endswith("+00:00") and "T00:00:00" in body["resets_at"]
    assert int(r.headers["Retry-After"]) > 0 and "per day" in body["message"]
    # a duplicate of an accepted summary is still answered (costs nothing)
    r = await env.client.post("/v1/episodes", json=episode(1), headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "duplicate"
    # the other company is not affected
    assert (await env.client.post("/v1/episodes", json=episode(1, "thr-b"), headers=hb)).status_code == 202
    await env.app.state.worker.drain()


async def test_monthly_tokens_alerts_and_429(env, no_ingest, monkeypatch, caplog):
    a, ha = await env.company("Firma Tokens")
    quotas = env.app.state.quotas
    sent = []

    async def fake_post(payload):
        sent.append(payload)

    quotas.webhook_url = "http://hooks.invalid/zen"
    monkeypatch.setattr(quotas, "_post", fake_post)
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 1000}, headers=ADM)

    caplog.set_level(logging.WARNING, logger="zen-memory.quotas")
    env.store.record_usage(a["id"], None, "extract", "claude-haiku-5-5", 1, 700, 50)
    quotas.after_usage(a)
    assert sent == [] and not any("QUOTA ALERT" in m for m in caplog.messages)
    env.store.record_usage(a["id"], None, "extract", "claude-haiku-5-5", 1, 40, 20, cache_read=10)  # 820 = 82%
    quotas.after_usage(a)
    quotas.after_usage(a)  # once per threshold and month
    await quotas.drain()
    assert [p["threshold_percent"] for p in sent] == [80]
    assert sent[0]["company_id"] == a["id"] and sent[0]["used"] == 820 and sent[0]["limit"] == 1000
    assert any("QUOTA ALERT" in m and "80%" in m for m in caplog.messages)

    env.store.record_usage(a["id"], None, "extract", "claude-haiku-5-5", 1, 200, 0)  # 1020
    quotas.after_usage(a)
    await quotas.drain()
    assert [p["threshold_percent"] for p in sent] == [80, 100]
    r = await env.client.post("/v1/episodes", json=episode(1), headers=ha)
    assert r.status_code == 429 and r.json()["quota"] == "ingest_tokens_per_month"
    assert r.json()["used"] == 1020 and r.json()["resets_at"].startswith(("20",))
    st = (await env.client.get(f"/admin/companies/{a['id']}/limits", headers=ADM)).json()
    assert [x["threshold"] for x in st["quotas"]["alerts"]] == [80, 100]
    me = (await env.client.get("/v1/me", headers=ha)).json()
    assert me["quotas"]["ingest_tokens_per_month"]["used"] == 1020 and "alerts" not in me["quotas"]


async def test_alert_logged_when_gate_usage_crosses(env, no_ingest, caplog):
    a, ha = await env.company("Firma Gate")
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 10_000}, headers=ADM)
    env.store.record_usage(a["id"], None, "extract", "claude-haiku-5-5", 1, 7_990, 0)  # 79.9%
    caplog.set_level(logging.WARNING, logger="zen-memory.quotas")
    r = await env.client.post("/v1/episodes", json=episode(7), headers=ha)  # fake gate bills ~100 tokens
    assert r.status_code == 202
    assert any("QUOTA ALERT" in m and "80%" in m for m in caplog.messages)
    await env.app.state.worker.drain()


async def test_no_overshoot_when_the_reservation_does_not_fit(env, no_ingest):
    a, ha = await env.company("Firma Mica")
    # the quota could absorb the gate, but not the reserved estimate of gate + ingest: 429 up front
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"ingest_tokens_per_month": 50}, headers=ADM)
    r = await env.client.post("/v1/episodes", json=episode(7), headers=ha)
    assert r.status_code == 429 and r.json()["quota"] == "ingest_tokens_per_month"
    assert env.store.tokens_since(a["id"], 0) == 0 and env.store.reserved_tokens(a["id"]) == 0


async def test_searches_per_minute(env):
    a, ha = await env.company("Firma Search")
    b, hb = await env.company("Firma Search B")
    await env.client.put(f"/admin/companies/{a['id']}/limits", json={"searches_per_minute": 2}, headers=ADM)
    for _ in range(2):
        assert (await env.client.get("/v1/search", params={"q": "făină"}, headers=ha)).status_code == 200
    r = await env.client.get("/v1/search", params={"q": "făină"}, headers=ha)
    assert r.status_code == 429 and r.json()["quota"] == "searches_per_minute"
    assert 0 < r.json()["retry_after_seconds"] <= 61
    assert (await env.client.get("/v1/search", params={"q": "făină"}, headers=hb)).status_code == 200


async def test_admin_limits_api(env):
    a, ha = await env.company("Firma Admin")
    url = f"/admin/companies/{a['id']}/limits"
    # company keys cannot touch limits
    assert (await env.client.get(url, headers=ha)).status_code == 401
    assert (await env.client.put(url, json={"episodes_per_day": 1}, headers=ha)).status_code == 401
    st = (await env.client.get(url, headers=ADM)).json()
    assert all(v["source"] == "default" for k, v in st["quotas"].items() if k != "alerts")
    assert st["defaults"]["episodes_per_day"] == st["quotas"]["episodes_per_day"]["limit"]
    r = await env.client.put(url, json={"episodes_per_day": 5, "searches_per_minute": 0}, headers=ADM)
    q = r.json()["quotas"]
    assert q["episodes_per_day"]["limit"] == 5 and q["searches_per_minute"]["limit"] == 0
    assert q["ingest_tokens_per_month"]["source"] == "default"
    # partial update keeps the other overrides; null goes back to the default
    q = (await env.client.put(url, json={"episodes_per_day": None}, headers=ADM)).json()["quotas"]
    assert q["episodes_per_day"]["source"] == "default" and q["searches_per_minute"]["source"] == "override"
    assert (await env.client.put(url, json={"episodes_per_day": -1}, headers=ADM)).status_code == 422
    assert (await env.client.put(url, json={"bogus": 1}, headers=ADM)).status_code == 422
    q = (await env.client.delete(url, headers=ADM)).json()["quotas"]
    assert q["searches_per_minute"]["source"] == "default"
    assert (await env.client.get("/admin/companies/co_nope/limits", headers=ADM)).status_code == 404
