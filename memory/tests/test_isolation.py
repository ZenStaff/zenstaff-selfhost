"""Tenant isolation and API contract tests.

Both companies deliberately use the SAME supplier name, so any leak through name matching,
full-text search or vector search would show up.
"""

from __future__ import annotations

import asyncio

import pytest

from .conftest import ADMIN

pytestmark = pytest.mark.asyncio


async def build_world(env):
    a, ha = await env.company("Brutăria Dulce")
    b, hb = await env.company("Cafeneaua Boema")
    s = env.seed

    ep_a = await s.episode(a, "Am hotărât să renunțăm la Furnizor Alfa SRL pentru făină.", "thr-a1", "2026-03-02")
    us_a = await s.entity(a, "Brutăria Dulce", "Organization", ep_a)
    alfa_a = await s.entity(a, "Furnizor Alfa SRL", "Organization", ep_a)
    client_a = await s.entity(a, "Hotel Central", "Organization", ep_a)
    old_price = await s.fact(a, alfa_a, us_a, "RELATES_TO", "Furnizor Alfa SRL vinde făina cu 3,10 lei/kg", ep_a, "2026-01-10", invalid_at="2026-03-01")
    new_price = await s.fact(a, alfa_a, us_a, "RELATES_TO", "Furnizor Alfa SRL vinde făina cu 3,60 lei/kg din martie", ep_a, "2026-03-01")
    dec_a = await s.fact(a, us_a, alfa_a, "Decision", "Brutăria Dulce renunță la Furnizor Alfa SRL pentru făină", ep_a, "2026-03-02", decided_by="Ioana", decision_date="2026-03-02", status="active")
    prom_a = await s.fact(a, us_a, client_a, "Promise", "Brutăria Dulce livrează 200 de cozonaci la Hotel Central până pe 20 decembrie", ep_a, "2026-03-02", promised_by="Mihai", promised_to="Hotel Central", due_date="2026-12-20", status="open")
    late_a = await s.fact(a, us_a, client_a, "Promise", "Brutăria Dulce trimite oferta de Paște la Hotel Central până pe 15 martie", ep_a, "2026-03-02", promised_by="Mihai", promised_to="Hotel Central", due_date="2026-03-15", status="open")

    ep_b = await s.episode(b, "Am semnat contract nou cu Furnizor Alfa SRL pentru cafea.", "thr-b1", "2026-02-05")
    us_b = await s.entity(b, "Cafeneaua Boema", "Organization", ep_b)
    alfa_b = await s.entity(b, "Furnizor Alfa SRL", "Organization", ep_b)
    dec_b = await s.fact(b, us_b, alfa_b, "Decision", "Cafeneaua Boema semnează contract pe 12 luni cu Furnizor Alfa SRL pentru cafea", ep_b, "2026-02-05", decided_by="Andrei", status="active")
    prom_b = await s.fact(b, alfa_b, us_b, "PROMISED", "Furnizor Alfa SRL livrează boabele de cafea la Cafeneaua Boema în fiecare luni", ep_b, "2026-02-05", promised_by="Furnizor Alfa SRL", status="open")

    return dict(
        a=a, ha=ha, b=b, hb=hb, alfa_a=alfa_a, alfa_b=alfa_b, client_a=client_a,
        old_price=old_price, new_price=new_price, dec_a=dec_a, prom_a=prom_a, late_a=late_a,
        dec_b=dec_b, prom_b=prom_b, ep_a=ep_a,
    )


def ids(items):
    return {x["id"] for x in items}


async def test_requires_valid_key(env):
    w = await build_world(env)
    assert (await env.client.get("/v1/search", params={"q": "Alfa"})).status_code == 401
    assert (await env.client.get("/v1/search", params={"q": "Alfa"}, headers={"Authorization": "Bearer zm_nope"})).status_code == 401
    # a company key is not an admin key
    assert (await env.client.get("/admin/usage", headers=w["ha"])).status_code == 401
    assert (await env.client.post("/admin/companies", json={"name": "x"}, headers=w["ha"])).status_code == 401


async def test_search_never_crosses_companies(env):
    w = await build_world(env)
    for q in ("Furnizor Alfa SRL", "ce am hotărât cu furnizorul Alfa?", "cafea contract", "cozonaci Hotel Central"):
        ra = (await env.client.get("/v1/search", params={"q": q, "limit": 50}, headers=w["ha"])).json()
        rb = (await env.client.get("/v1/search", params={"q": q, "limit": 50}, headers=w["hb"])).json()
        a_ids = {w[k].uuid for k in ("old_price", "new_price", "dec_a", "prom_a", "late_a")}
        b_ids = {w[k].uuid for k in ("dec_b", "prom_b")}
        assert ids(ra["facts"]) <= a_ids, (q, ra["facts"])
        assert ids(rb["facts"]) <= b_ids, (q, rb["facts"])
        assert w["alfa_b"].uuid not in ids(ra["entities"])
        assert w["alfa_a"].uuid not in ids(rb["entities"])
        # the internal group id never leaks
        assert w["a"]["group_id"] not in str(ra) and w["b"]["group_id"] not in str(ra)
    # sanity: both companies DO find their own data
    ra = (await env.client.get("/v1/search", params={"q": "Furnizor Alfa SRL"}, headers=w["ha"])).json()
    rb = (await env.client.get("/v1/search", params={"q": "Furnizor Alfa SRL"}, headers=w["hb"])).json()
    assert ra["facts"] and rb["facts"]


async def test_superseded_fact_has_valid_to(env):
    w = await build_world(env)
    r = (await env.client.get("/v1/search", params={"q": "preț făină Furnizor Alfa", "limit": 20}, headers=w["ha"])).json()
    by_id = {f["id"]: f for f in r["facts"]}
    old, new = by_id[w["old_price"].uuid], by_id[w["new_price"].uuid]
    assert old["valid_to"] is not None and old["current"] is False
    assert new["valid_to"] is None and new["current"] is True
    assert old["sources"] and old["sources"][0]["thread_id"] == "thr-a1"
    r2 = (await env.client.get("/v1/search", params={"q": "preț făină Furnizor Alfa", "include_superseded": "false"}, headers=w["ha"])).json()
    assert w["old_price"].uuid not in ids(r2["facts"])


async def test_entity_read_and_delete_are_scoped(env):
    w = await build_world(env)
    own = await env.client.get(f"/v1/entities/{w['alfa_a'].uuid}", headers=w["ha"])
    assert own.status_code == 200
    timeline = own.json()["timeline"]
    assert ids(timeline) == {w[k].uuid for k in ("old_price", "new_price", "dec_a")}
    # B cannot read, nor delete, A's entity even with the exact id
    assert (await env.client.get(f"/v1/entities/{w['alfa_a'].uuid}", headers=w["hb"])).status_code == 404
    assert (await env.client.delete(f"/v1/entities/{w['alfa_a'].uuid}", headers=w["hb"])).status_code == 404
    assert (await env.client.get(f"/v1/entities/{w['alfa_a'].uuid}", headers=w["ha"])).status_code == 200


async def test_decisions_and_promises(env):
    w = await build_world(env)
    da = (await env.client.get("/v1/decisions", headers=w["ha"])).json()["decisions"]
    db_ = (await env.client.get("/v1/decisions", headers=w["hb"])).json()["decisions"]
    assert ids(da) == {w["dec_a"].uuid} and ids(db_) == {w["dec_b"].uuid}
    assert da[0]["owner"] == "Ioana" and da[0]["status"] == "active"

    pa = (await env.client.get("/v1/promises", headers=w["ha"])).json()["promises"]
    assert ids(pa) == {w["prom_a"].uuid, w["late_a"].uuid}
    by = {p["id"]: p for p in pa}
    assert by[w["prom_a"].uuid]["due_date"] == "2026-12-20" and by[w["prom_a"].uuid]["status"] == "open"
    assert by[w["late_a"].uuid]["status"] == "overdue"
    overdue = (await env.client.get("/v1/promises", params={"status": "overdue"}, headers=w["ha"])).json()["promises"]
    assert ids(overdue) == {w["late_a"].uuid}
    pb = (await env.client.get("/v1/promises", headers=w["hb"])).json()["promises"]
    assert ids(pb) == {w["prom_b"].uuid}


async def test_client_cannot_choose_group_or_company(env):
    w = await build_world(env)
    body = {"summary": "Am hotărât să schimbăm furnizorul de ambalaje cu Beta Pack din aprilie.",
            "source": {"thread_id": "t1", "timestamp": "2026-04-01T10:00:00Z"}}
    for extra in ({"group_id": w["b"]["group_id"]}, {"company_id": w["b"]["id"]}):
        r = await env.client.post("/v1/episodes", json={**body, **extra}, headers=w["ha"])
        assert r.status_code == 422, r.text
    r = await env.client.post("/v1/episodes", json={**body, "source": {**body["source"], "group_id": w["b"]["group_id"]}}, headers=w["ha"])
    assert r.status_code == 422
    # query-string group ids are ignored: still only A's facts
    r = (await env.client.get("/v1/search", params={"q": "cafea", "group_id": w["b"]["group_id"], "group_ids": w["b"]["group_id"]}, headers=w["ha"])).json()
    assert not ({w["dec_b"].uuid, w["prom_b"].uuid} & ids(r["facts"]))


async def test_ingest_writes_only_into_callers_group(env, monkeypatch):
    w = await build_world(env)
    calls = []

    async def fake_ingest(group_id, name, body, reference_time, source_description, **kw):
        calls.append(group_id)
        return "graph-ep-" + group_id[-6:]

    monkeypatch.setattr(env.engine, "ingest", fake_ingest)
    r = await env.client.post("/v1/episodes", headers=w["ha"], json={
        "summary": "Am promis clientului Hotel Central că livrăm 50 kg de pâine integrală până vineri, 10 aprilie.",
        "source": {"thread_id": "thr-a2", "user": "mihai", "machine": "pc-birou", "timestamp": "2026-04-06T16:00:00Z"}})
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "accepted"
    await env.app.state.worker.drain()
    assert calls == [w["a"]["group_id"]]
    ep_id = r.json()["episode_id"]
    st = (await env.client.get(f"/v1/episodes/{ep_id}", headers=w["ha"])).json()
    assert st["status"] == "done" and st["source"]["machine"] == "pc-birou"
    # B cannot see A's episode
    assert (await env.client.get(f"/v1/episodes/{ep_id}", headers=w["hb"])).status_code == 404
    # same summary again is a duplicate, not a second ingest
    r2 = await env.client.post("/v1/episodes", headers=w["ha"], json={
        "summary": "Am promis clientului Hotel Central că livrăm 50 kg de pâine integrală până vineri, 10 aprilie.",
        "source": {"thread_id": "thr-a2", "timestamp": "2026-04-06T16:00:00Z"}})
    assert r2.json()["status"] == "duplicate"
    assert calls == [w["a"]["group_id"]]


async def test_novelty_gate_skips_small_talk(env, monkeypatch):
    w = await build_world(env)

    async def boom(*a, **k):
        raise AssertionError("must not ingest")

    monkeypatch.setattr(env.engine, "ingest", boom)
    r = await env.client.post("/v1/episodes", headers=w["ha"], json={
        "summary": "Utilizatorul a întrebat cum se schimbă tema aplicației în modul întunecat; i s-a explicat din setări.",
        "source": {"thread_id": "thr-a3", "timestamp": "2026-04-07T09:00:00Z"}})
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    r = await env.client.post("/v1/episodes", headers=w["ha"], json={"summary": "ok, mersi", "source": {"thread_id": "thr-a4", "timestamp": "2026-04-07T09:00:00Z"}})
    assert r.json()["status"] == "skipped" and r.json()["gate"]["used_llm"] is False
    usage = (await env.client.get("/admin/usage", headers={"Authorization": f"Bearer {ADMIN}"})).json()["companies"]
    ua = next(u for u in usage if u["company_id"] == w["a"]["id"])
    ub = next(u for u in usage if u["company_id"] == w["b"]["id"])
    assert ua["episodes_skipped"] == 2 and ua["llm_calls"] == 1 and ua["input_tokens"] > 0
    assert ub["llm_calls"] == 0


async def test_forget_entity_gdpr(env):
    w = await build_world(env)
    r = await env.client.delete(f"/v1/entities/{w['client_a'].uuid}", headers=w["ha"])
    assert r.status_code == 200
    body = r.json()
    assert body["facts_deleted"] == 2 and body["episodes_redacted"] == 1
    assert (await env.client.get(f"/v1/entities/{w['client_a'].uuid}", headers=w["ha"])).status_code == 404
    pa = (await env.client.get("/v1/promises", headers=w["ha"])).json()["promises"]
    assert pa == []
    rows = await env.raw("MATCH (e:Episodic {uuid: $u}) RETURN e.content AS c", u=w["ep_a"].uuid)
    assert rows[0]["c"].startswith("[redacted")
    # B untouched
    assert len((await env.client.get("/v1/promises", headers=w["hb"])).json()["promises"]) == 1


async def test_delete_company_removes_only_that_company(env):
    w = await build_world(env)
    bad = await env.client.delete("/v1/company", headers=w["ha"])
    assert bad.status_code == 400
    r = await env.client.delete("/v1/company", headers={**w["ha"], "X-Confirm-Delete": w["a"]["id"]})
    assert r.status_code == 200 and r.json()["graph_nodes_deleted"] >= 4
    rows = await env.raw("MATCH (n) WHERE n.group_id = $g RETURN count(n) AS c", g=w["a"]["group_id"])
    assert rows[0]["c"] == 0
    assert (await env.client.get("/v1/me", headers=w["ha"])).status_code == 401
    me_b = (await env.client.get("/v1/me", headers=w["hb"])).json()
    assert me_b["graph"]["facts"] == 2 and me_b["graph"]["entities"] == 2


async def test_concurrent_requests_stay_isolated(env):
    w = await build_world(env)

    async def ask(h):
        return (await env.client.get("/v1/search", params={"q": "Furnizor Alfa SRL", "limit": 50}, headers=h)).json()

    results = await asyncio.gather(*[ask(w["ha"] if i % 2 == 0 else w["hb"]) for i in range(20)])
    a_ids = {w[k].uuid for k in ("old_price", "new_price", "dec_a", "prom_a", "late_a")}
    b_ids = {w[k].uuid for k in ("dec_b", "prom_b")}
    for i, r in enumerate(results):
        assert ids(r["facts"]) <= (a_ids if i % 2 == 0 else b_ids)
