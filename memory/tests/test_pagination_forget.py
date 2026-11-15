"""Cursor pagination of /v1/decisions and /v1/promises; fuller GDPR erasure."""

from __future__ import annotations

import pytest

from .test_isolation import build_world, ids

pytestmark = pytest.mark.asyncio


async def test_promises_paginate_with_status_filter(env):
    w = await build_world(env)
    a, s = w["a"], env.seed
    ep = w["ep_a"]
    us = await s.entity(a, "Bistro Test", "Organization", ep)
    made = []
    for i in range(7):
        due = f"2026-01-{10 + i:02d}" if i % 2 else f"2027-01-{10 + i:02d}"  # odd = overdue
        made.append(await s.fact(a, us, w["client_a"], "Promise", f"Bistro Test trimite oferta {i}", ep,
                                 f"2026-02-{10 + i:02d}", promised_by="Mihai", due_date=due, status="open"))
    done = await s.fact(a, us, w["client_a"], "Promise", "Bistro Test a livrat mostrele", ep, "2026-02-01",
                        promised_by="Mihai", status="done", invalid_at="2026-02-05")

    seen, cursor, pages = [], None, 0
    while True:
        params = {"limit": 3, **({"cursor": cursor} if cursor else {})}
        r = (await env.client.get("/v1/promises", params=params, headers=w["ha"])).json()
        seen += r["promises"]
        pages += 1
        cursor = r["next_cursor"]
        if not cursor:
            break
    all_ids = [p["id"] for p in seen]
    assert len(all_ids) == len(set(all_ids)) == 7 + 1 + 2  # 2 promises from build_world
    assert pages == 4
    dates = [p["valid_from"] for p in seen]
    assert dates == sorted(dates, reverse=True)
    # a fulfilled promise keeps status "done" even though it is no longer current
    assert next(p for p in seen if p["id"] == done.uuid)["status"] == "done"

    overdue, cursor = [], None
    while True:
        r = (await env.client.get("/v1/promises", params={"status": "overdue", "limit": 2, **({"cursor": cursor} if cursor else {})}, headers=w["ha"])).json()
        assert all(p["status"] == "overdue" for p in r["promises"])
        overdue += r["promises"]
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert ids(overdue) == {made[i].uuid for i in (1, 3, 5)} | {w["late_a"].uuid}
    assert ids((await env.client.get("/v1/promises", params={"status": "done"}, headers=w["ha"])).json()["promises"]) == {done.uuid}
    assert (await env.client.get("/v1/promises", params={"cursor": "not-a-cursor"}, headers=w["ha"])).status_code == 400
    # B's pages never contain A's promises
    rb = (await env.client.get("/v1/promises", params={"limit": 500}, headers=w["hb"])).json()
    assert ids(rb["promises"]) == {w["prom_b"].uuid} and rb["next_cursor"] is None


async def test_decisions_paginate(env):
    w = await build_world(env)
    a, s, ep = w["a"], env.seed, w["ep_a"]
    for i in range(4):
        await s.fact(a, w["alfa_a"], w["client_a"], "Decision", f"Decizia {i}", ep, f"2026-04-0{i + 1}", decided_by="Ioana")
    r1 = (await env.client.get("/v1/decisions", params={"limit": 2}, headers=w["ha"])).json()
    r2 = (await env.client.get("/v1/decisions", params={"limit": 2, "cursor": r1["next_cursor"]}, headers=w["ha"])).json()
    r3 = (await env.client.get("/v1/decisions", params={"limit": 2, "cursor": r2["next_cursor"]}, headers=w["ha"])).json()
    got = [d["fact"] for d in r1["decisions"] + r2["decisions"] + r3["decisions"]]
    assert got[:4] == ["Decizia 3", "Decizia 2", "Decizia 1", "Decizia 0"] and len(got) == 5
    assert r3["next_cursor"] is None


async def test_forget_rewrites_facts_that_mention_the_person(env):
    w = await build_world(env)
    a, b, s, ep = w["a"], w["b"], env.seed, w["ep_a"]
    person = await s.entity(a, "Ana Popa", "Person", ep)
    other = await s.entity(a, "Ana Popescu", "Person", ep)
    touching = await s.fact(a, person, w["client_a"], "Promise", "Ana Popa trimite declarația D300", ep, "2026-03-01",
                            promised_by="Ana Popa", due_date="2026-03-25", status="open")
    # facts between OTHER entities that mention her by name (incl. without diacritics / other case)
    mention = await s.fact(a, w["alfa_a"], w["client_a"], "RELATES_TO",
                           "Furnizor Alfa SRL a trimis factura către ANA POPA pentru Hotel Central", ep, "2026-03-02")
    owner_only = await s.fact(a, w["alfa_a"], w["client_a"], "Decision", "Furnizorul a aprobat reducerea", ep, "2026-03-03",
                              decided_by="Ana Popa")
    similar = await s.fact(a, other, w["client_a"], "RELATES_TO", "Ana Popescu servește la Hotel Central", ep, "2026-03-04")
    ep_b = await s.episode(b, "Ana Popa e și clienta Cafenelei Boema.", "thr-b9", "2026-03-05")
    b_person = await s.entity(b, "Ana Popa", "Person", ep_b)
    b_fact = await s.fact(b, b_person, w["alfa_b"], "RELATES_TO", "Ana Popa cumpără cafea de la Furnizor Alfa SRL", ep_b, "2026-03-05")
    unrelated_ep = await s.episode(a, "Ana Popa a cerut factura pe email.", "thr-a9", "2026-03-06")  # no MENTIONS edge

    r = await env.client.delete(f"/v1/entities/{person.uuid}", headers=w["ha"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["facts_deleted"] == 1 and body["facts_rewritten"] == 2
    assert body["episodes_redacted"] >= 2  # the one linked by MENTIONS and the one that only contains the name

    rows = {x["uuid"]: x for x in await env.raw(
        "MATCH ()-[e:RELATES_TO]->() WHERE e.uuid IN $u RETURN e.uuid AS uuid, e.fact AS fact, e.decided_by AS by",
        u=[touching.uuid, mention.uuid, owner_only.uuid, similar.uuid, b_fact.uuid])}
    assert touching.uuid not in rows
    assert "popa" not in rows[mention.uuid]["fact"].lower() and "[șters la cerere]" in rows[mention.uuid]["fact"]
    assert rows[owner_only.uuid]["by"] == "[șters la cerere]"
    assert rows[similar.uuid]["fact"] == "Ana Popescu servește la Hotel Central"  # a different person
    assert rows[b_fact.uuid]["fact"].startswith("Ana Popa")  # other company untouched
    content = await env.raw("MATCH (e:Episodic {uuid: $u}) RETURN e.content AS c", u=unrelated_ep.uuid)
    assert content[0]["c"].startswith("[redacted")
    # the rewritten fact is no longer found by her name
    res = (await env.client.get("/v1/search", params={"q": "Ana Popa factura", "limit": 50}, headers=w["ha"])).json()
    assert not any("Ana Popa" in f["fact"] for f in res["facts"])


async def test_forget_catches_declined_forms(env):
    w = await build_world(env)
    a, s, ep = w["a"], env.seed, w["ep_a"]
    person = await s.entity(a, "Ana Popa", "Person", ep)
    ion = await s.entity(a, "Ion Pop", "Person", ep)
    dative = await s.fact(a, w["alfa_a"], w["client_a"], "RELATES_TO",
                          "Furnizor Alfa SRL i-a trimis factura Anei Popa pentru Hotel Central", ep, "2026-03-02")
    reversed_ = await s.fact(a, w["alfa_a"], w["client_a"], "RELATES_TO", "Contractul doamnei Popa Ana expiră în mai", ep, "2026-03-03")
    other = await s.fact(a, w["alfa_a"], w["client_a"], "RELATES_TO", "Anei Popescu i s-a trimis oferta; Anabela a confirmat", ep, "2026-03-04")
    pop = await s.fact(a, w["alfa_a"], w["client_a"], "RELATES_TO", "Banii lui Ion Pop au intrat; Ion Popescu așteaptă", ep, "2026-03-05")
    declined_ep = await s.episode(a, "I-am dat Anei Popa cheile de la depozit.", "thr-a10", "2026-03-06")
    queued = env.store.insert_episode(a["id"], "k-queued", "queued", None, {"thread_id": "thr-q"}, "2026-03-07T10:00:00+00:00",
                                      "Ioana i-a promis Anei Popa că îi trimite contractul mâine.")

    r = await env.client.delete(f"/v1/entities/{person.uuid}", headers=w["ha"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["facts_rewritten"] == 2 and body["queued_summaries_redacted"] == 1
    rows = {x["uuid"]: x["fact"] for x in await env.raw(
        "MATCH ()-[e:RELATES_TO]->() WHERE e.uuid IN $u RETURN e.uuid AS uuid, e.fact AS fact",
        u=[dative.uuid, reversed_.uuid, other.uuid, pop.uuid])}
    assert rows[dative.uuid] == "Furnizor Alfa SRL i-a trimis factura [șters la cerere] pentru Hotel Central"
    assert rows[reversed_.uuid] == "Contractul doamnei [șters la cerere] expiră în mai"
    assert rows[other.uuid] == "Anei Popescu i s-a trimis oferta; Anabela a confirmat"  # not her
    content = await env.raw("MATCH (e:Episodic {uuid: $u}) RETURN e.content AS c", u=declined_ep.uuid)
    assert content[0]["c"].startswith("[redacted")
    assert env.store.get_episode(a["id"], queued["id"])["summary"] == "Ioana i-a promis [șters la cerere] că îi trimite contractul mâine."

    r = await env.client.delete(f"/v1/entities/{ion.uuid}", headers=w["ha"])
    assert r.status_code == 200
    fact = (await env.raw("MATCH ()-[e:RELATES_TO {uuid: $u}]->() RETURN e.fact AS f", u=pop.uuid))[0]["f"]
    assert fact == "Banii lui [șters la cerere] au intrat; Ion Popescu așteaptă"
