"""Enterprise isolation tier (dedicated graph store + migration), per-company encryption with
rotation and crypto-shredding, and the hash-chained audit log."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest
from graphiti_core.nodes import EpisodeType, EpisodicNode

from app.crypto import CompanyCipher, KeyStore, KeyUnavailable, MasterKeys, current_cipher, is_encrypted, new_master_key

from .conftest import ADMIN, STORE2_URI
from .test_isolation import build_world, ids

ADM = {"Authorization": f"Bearer {ADMIN}"}
needs_store2 = pytest.mark.skipif(not STORE2_URI, reason="needs NEO4J_URI_2 (scripts/test.sh starts it)")


async def views(env, h) -> dict:
    out = {}
    for q in ("Furnizor Alfa SRL", "cozonaci Hotel Central", "preț făină"):
        r = (await env.client.get("/v1/search", params={"q": q, "limit": 20}, headers=h)).json()
        # sets, not order: BM25 statistics are per store, so ranks may shift after a move
        out[q] = sorted(ids(r["facts"])), sorted(ids(r["entities"]))
    out["decisions"] = (await env.client.get("/v1/decisions", params={"include_superseded": "true"}, headers=h)).json()["decisions"]
    out["promises"] = (await env.client.get("/v1/promises", headers=h)).json()["promises"]
    out["me"] = (await env.client.get("/v1/me", headers=h)).json()["graph"]
    return out


async def group_count(engine, g: str) -> int:
    return (await engine.scoped(g, "MATCH (n) WHERE n.group_id = $g RETURN count(n) AS c"))[0]["c"]


# ---- Enterprise tier ---------------------------------------------------------------------------


@needs_store2
@pytest.mark.asyncio
async def test_migrate_to_dedicated_and_back(env):
    w = await build_world(env)
    a, ha, hb = w["a"], w["ha"], w["hb"]
    before_a, before_b = await views(env, ha), await views(env, hb)
    await env.register_store2(a)
    e2 = await env.store2_engine()

    r = await env.client.post(f"/admin/companies/{a['id']}/migrate", json={"to": "dedicated", "store_id": "st_test01"}, headers=ADM)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["verified"] and rep["source"]["sha256"] == rep["target"]["sha256"] and rep["tier"] == "enterprise"
    assert rep["source"]["nodes"] == rep["source_nodes_deleted"] > 0
    assert env.store.get_company(a["id"])["tier"] == "enterprise"
    # the shared graph no longer holds A; the dedicated one holds only A
    assert await group_count(env.engine, a["group_id"]) == 0
    assert await group_count(e2, a["group_id"]) == rep["source"]["nodes"]
    assert await group_count(e2, w["b"]["group_id"]) == 0
    # same answers from the new store, B untouched
    assert await views(env, ha) == before_a
    assert await views(env, hb) == before_b
    me = (await env.client.get("/v1/me", headers=ha)).json()
    assert me["tier"] == "enterprise"

    # GDPR erasure runs against the dedicated store
    f = await env.client.delete(f"/v1/entities/{w['client_a'].uuid}", headers=ha)
    assert f.status_code == 200 and f.json()["facts_deleted"] == 2

    # an unregister is refused while routed
    assert (await env.client.delete("/admin/stores/st_test01", headers=ADM)).status_code == 409

    back = await env.client.post(f"/admin/companies/{a['id']}/migrate", json={"to": "shared"}, headers=ADM)
    assert back.status_code == 200 and back.json()["verified"], back.text
    assert await group_count(e2, a["group_id"]) == 0
    assert env.store.get_company(a["id"])["tier"] == "standard"
    after = await views(env, ha)
    assert after["decisions"] == before_a["decisions"]
    assert ids(after["promises"]) == ids(before_a["promises"]) - {w["prom_a"].uuid, w["late_a"].uuid}
    u = await env.client.delete("/admin/stores/st_test01", headers=ADM)
    assert u.status_code == 200 and u.json()["nodes_left"] == 0


@needs_store2
@pytest.mark.asyncio
async def test_ingest_goes_to_the_dedicated_store(env, monkeypatch):
    w = await build_world(env)
    await env.register_store2(w["a"])
    r = await env.client.post(f"/admin/companies/{w['a']['id']}/migrate", json={"to": "dedicated", "store_id": "st_test01"}, headers=ADM)
    assert r.status_code == 200
    dedicated = await env.router.engine_for_store("st_test01")
    calls = []

    async def to_dedicated(group_id, *a, **k):
        calls.append(("dedicated", group_id))
        return "gep-1"

    async def to_shared(group_id, *a, **k):
        calls.append(("shared", group_id))
        return "gep-2"

    monkeypatch.setattr(dedicated, "ingest", to_dedicated)
    monkeypatch.setattr(env.engine, "ingest", to_shared)
    for h in (w["ha"], w["hb"]):
        resp = await env.client.post("/v1/episodes", headers=h, json={
            "summary": "Am hotărât să schimbăm furnizorul de ambalaje cu Beta Pack din aprilie.",
            "source": {"thread_id": "t-route", "timestamp": "2026-04-01T10:00:00Z"}})
        assert resp.status_code == 202, resp.text
    await env.app.state.worker.drain()
    assert sorted(calls) == sorted([("dedicated", w["a"]["group_id"]), ("shared", w["b"]["group_id"])])


@needs_store2
@pytest.mark.asyncio
async def test_migration_refuses_a_target_that_already_has_the_group(env):
    w = await build_world(env)
    await env.register_store2(w["a"])
    e2 = await env.store2_engine()
    # someone else's leftover node with A's group in the target: never overwritten, never deleted
    await e2.driver.execute_query("CREATE (:Entity {uuid: 'stray-1', group_id: $g, name: 'stray'})", g=w["a"]["group_id"])
    before = await views(env, w["ha"])
    r = await env.client.post(f"/admin/companies/{w['a']['id']}/migrate", json={"to": "dedicated", "store_id": "st_test01"}, headers=ADM)
    assert r.status_code == 409 and "already holds" in r.text
    assert env.store.get_company(w["a"]["id"])["store_id"] is None
    assert await group_count(e2, w["a"]["group_id"]) == 1
    assert await views(env, w["ha"]) == before


@needs_store2
@pytest.mark.asyncio
async def test_a_store_serves_only_its_company(env):
    w = await build_world(env)
    await env.register_store2(w["a"])
    r = await env.client.post(f"/admin/companies/{w['b']['id']}/migrate", json={"to": "dedicated", "store_id": "st_test01"}, headers=ADM)
    assert r.status_code == 409
    # registering needs a reachable store (a wrong password would also fail the ping, but trips
    # Neo4j's auth rate limit for the other tests)
    bad = await env.client.post("/admin/stores", headers=ADM, json={
        "store_id": "st_test02", "company_id": w["b"]["id"], "uri": "bolt://test-zen-memory-nowhere:7687", "password": "x" * 20})
    assert bad.status_code in (502, 500)
    assert env.keys.get_secret("store:st_test02") is None


@needs_store2
@pytest.mark.asyncio
async def test_delete_enterprise_company_empties_and_orphans_its_store(env):
    w = await build_world(env)
    await env.register_store2(w["a"])
    await env.client.post(f"/admin/companies/{w['a']['id']}/migrate", json={"to": "dedicated", "store_id": "st_test01"}, headers=ADM)
    e2 = await env.store2_engine()
    r = await env.client.delete(f"/admin/companies/{w['a']['id']}", headers=ADM)
    assert r.status_code == 200 and r.json()["graph_nodes_deleted"] > 0 and r.json()["data_keys_destroyed"] >= 1
    assert await group_count(e2, w["a"]["group_id"]) == 0
    assert env.store.get_graph_store("st_test01")["status"] == "orphaned"
    assert (await env.client.delete("/admin/stores/st_test01", headers=ADM)).status_code == 200


# ---- encryption ---------------------------------------------------------------------------------


def _raw_episode_row(env, episode_id: str) -> dict:
    con = sqlite3.connect(env.store._conn.execute("PRAGMA database_list").fetchone()[2])
    con.row_factory = sqlite3.Row
    return dict(con.execute("SELECT * FROM episodes WHERE id=?", (episode_id,)).fetchone())


@pytest.mark.asyncio
async def test_episode_rows_are_encrypted_at_rest(env, monkeypatch):
    a, ha = await env.company("Firma Cripto")

    monkeypatch.setattr(env.app.state.worker, "enqueue", lambda company, ep: None)
    r = await env.client.post("/v1/episodes", headers=ha, json={
        "summary": "Am hotărât contract nou cu Furnizor Secret SRL la 4,20 lei/kg.",
        "source": {"thread_id": "thr-secret", "user": "maria", "title": "Negociere Secret SRL", "timestamp": "2026-04-01T10:00:00Z"}})
    assert r.status_code == 202
    raw = _raw_episode_row(env, r.json()["episode_id"])
    for col in ("summary", "source_json", "reason"):
        assert is_encrypted(raw[col]), (col, raw[col])
        assert "Secret" not in raw[col] and "maria" not in raw[col]
    st = (await env.client.get(f"/v1/episodes/{r.json()['episode_id']}", headers=ha)).json()
    assert st["source"]["user"] == "maria" and st["source"]["title"] == "Negociere Secret SRL"
    # the worker gets plaintext
    pending = env.store.pending_episodes()
    assert pending[0]["summary"].startswith("Am hotărât contract nou")


@pytest.mark.asyncio
async def test_graph_episode_text_is_encrypted_and_decrypted_for_context(env):
    a, _ = await env.company("Firma Graf")
    cipher = env.keys.cipher(a["id"])
    g = env.seed.g
    ep = EpisodicNode(name="Negociere Secret SRL", group_id=a["group_id"], source=EpisodeType.text,
                      source_description="thread x; user maria", content="Ioana a hotărât prețul de 4,20 lei/kg la Secret SRL.",
                      valid_at=datetime(2026, 4, 1, tzinfo=timezone.utc), created_at=datetime(2026, 4, 1, tzinfo=timezone.utc))
    token = current_cipher.set(cipher)
    try:
        await g._process_episode_data(ep, [], [], datetime.now(timezone.utc), a["group_id"])
        rows = await env.raw("MATCH (e:Episodic {uuid: $u}) RETURN e.content AS c, e.name AS n, e.source_description AS s", u=ep.uuid)
        assert all(is_encrypted(rows[0][k]) for k in ("c", "n", "s")), rows
        assert "Secret" not in str(rows[0])
        back = await g.retrieve_episodes(datetime(2026, 5, 1, tzinfo=timezone.utc), last_n=5, group_ids=[a["group_id"]])
        assert [e.content for e in back] == ["Ioana a hotărât prețul de 4,20 lei/kg la Secret SRL."]
        assert back[0].name == "Negociere Secret SRL"
    finally:
        current_cipher.reset(token)
    # without the company's key (another company's cipher), Graphiti would see nothing
    other = env.keys.cipher((await env.company("Alta"))[0]["id"])
    token = current_cipher.set(other)
    try:
        back = await g.retrieve_episodes(datetime(2026, 5, 1, tzinfo=timezone.utc), last_n=5, group_ids=[a["group_id"]])
        assert [e.content for e in back] == [""]
    finally:
        current_cipher.reset(token)


def test_ciphertext_is_bound_to_company_field_and_record():
    ks = KeyStore(":memory:", MasterKeys("k1:" + new_master_key()))
    ca, cb = ks.cipher("co_a"), ks.cipher("co_b")
    ct = ca.encrypt("secret text", "ep.summary", "ep_1")
    assert ca.decrypt(ct, "ep.summary", "ep_1") == "secret text"
    for c, purpose, rec in ((cb, "ep.summary", "ep_1"), (ca, "ep.reason", "ep_1"), (ca, "ep.summary", "ep_2")):
        with pytest.raises(Exception):
            c.decrypt(ct, purpose, rec)
    assert CompanyCipher("co_x").encrypt("plain", "p", "r") == "plain"  # encryption off: pass-through


@pytest.mark.asyncio
async def test_key_rotation_reencrypts_everything(env):
    w = await build_world(env)
    a, ha = w["a"], w["ha"]
    cipher = env.keys.cipher(a["id"])
    # one encrypted graph episode written through the hooks
    g = env.seed.g
    ep = EpisodicNode(name="t", group_id=a["group_id"], source=EpisodeType.text, source_description="d",
                      content="conținut confidențial", valid_at=datetime(2026, 4, 1, tzinfo=timezone.utc))
    token = current_cipher.set(cipher)
    try:
        await g._process_episode_data(ep, [], [], datetime.now(timezone.utc), a["group_id"])
    finally:
        current_cipher.reset(token)
    before = await views(env, ha)
    r = await env.client.post(f"/admin/companies/{a['id']}/keys/rotate", headers=ADM)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active_version"] == 2 and body["old_versions_destroyed"] == 1
    assert body["graph_episodes_reencrypted"] >= 2  # the hook-written one + the seeded plaintext ones
    assert env.keys.key_versions(a["id"]) == [{"version": 2, "kek_id": "t1"}]
    rows = await env.raw("MATCH (e:Episodic {group_id: $g}) RETURN e.uuid AS u, e.content AS c", g=a["group_id"])
    assert rows and all(r["c"].startswith("zmenc1:2:") for r in rows)
    texts = {t["uuid"]: t["content"] for t in await env.engine.episode_texts(a["group_id"], env.keys.cipher(a["id"]))}
    assert texts[ep.uuid] == "conținut confidențial"
    assert await views(env, ha) == before  # sources (encrypted rows) still attach


@pytest.mark.asyncio
async def test_crypto_shredding_makes_copies_unreadable(env, tmp_path):
    a, ha = await env.company("Firma Șters")
    cipher = env.keys.cipher(a["id"])
    ct = cipher.encrypt("date confidențiale", "graph.episode.content", "u1")
    r = await env.client.delete("/v1/company", headers={**ha, "X-Confirm-Delete": a["id"]})
    assert r.status_code == 200 and r.json()["data_keys_destroyed"] == 1
    assert not env.keys.has_key(a["id"])
    # a copy of the ciphertext (e.g. from a graph backup) cannot be decrypted any more
    with pytest.raises(KeyUnavailable):
        env.keys.cipher(a["id"], create=False).decrypt(ct, "graph.episode.content", "u1")
    # and the key file holds no trace of the wrapped key
    raw = (tmp_path / "keys.sqlite3").read_bytes()
    assert a["id"].encode() not in raw


def test_master_key_rotation_rewraps(tmp_path):
    path = str(tmp_path / "k.sqlite3")
    k1, k2 = new_master_key(), new_master_key()
    ks = KeyStore(path, MasterKeys(f"old:{k1}"))
    ct = ks.cipher("co_a").encrypt("x", "p", "r")
    ks.put_secret("store:st_1", "pw-1234567890abcdef")
    ks2 = KeyStore(path, MasterKeys(f"old:{k1},new:{k2}", "new"))
    assert ks2.rewrap_all() == {"data_keys_rewrapped": 1, "secrets_rewrapped": 1, "kek_id": "new"}
    ks3 = KeyStore(path, MasterKeys(f"new:{k2}"))  # old master key removed from the env
    assert ks3.check_all() == 2
    assert ks3.cipher("co_a").decrypt(ct, "p", "r") == "x"
    assert ks3.get_secret("store:st_1") == "pw-1234567890abcdef"
    with pytest.raises(KeyUnavailable):
        KeyStore(path, MasterKeys(f"other:{new_master_key()}")).check_all()
    with pytest.raises(KeyUnavailable):
        KeyStore(path, MasterKeys("")).check_all()


# ---- audit log ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_every_call_is_audited_and_the_chain_verifies(env):
    a, ha = await env.company("Firma Audit")
    await env.client.get("/v1/search", params={"q": "secret supplier text"}, headers=ha)
    await env.client.get("/v1/me", headers={"Authorization": "Bearer zm_wrong"})
    await env.client.get("/admin/usage", headers=ADM)
    await env.client.get("/healthz")
    rows = [dict(r) for r in env.audit._conn.execute("SELECT * FROM audit ORDER BY seq")]
    assert [r["action"] for r in rows] == ["admin_create_company", "search", "me", "admin_usage"]
    s = rows[1]
    key_id = env.store._q("SELECT id FROM api_keys WHERE company_id=?", (a["id"],))[0]["id"]
    assert (s["company_id"], s["key_id"], s["auth"], s["route"], s["status"], s["ip"]) == (a["id"], key_id, "company", "/v1/search", 200, "203.0.113.7")
    assert "secret" not in str(rows)  # query strings are never logged
    assert rows[2]["auth"] == "invalid" and rows[2]["status"] == 401 and rows[2]["company_id"] is None
    assert rows[3]["auth"] == "admin"
    v = (await env.client.get("/admin/audit/verify", headers=ADM)).json()
    assert v["ok"] and v["rows"] == 4


@pytest.mark.asyncio
async def test_audit_log_is_append_only_and_tamper_evident(env):
    for _ in range(3):
        await env.client.get("/admin/usage", headers=ADM)
    con = env.audit._conn
    with pytest.raises(sqlite3.DatabaseError):
        con.execute("UPDATE audit SET status=200 WHERE seq=2")
    with pytest.raises(sqlite3.DatabaseError):
        con.execute("DELETE FROM audit WHERE seq=2")
    head = env.audit.head()
    # an attacker with file access drops the triggers and edits a row: the chain shows it
    con.execute("DROP TRIGGER audit_no_update")
    con.execute("UPDATE audit SET ip='10.0.0.1' WHERE seq=2")
    v = env.audit.verify()
    assert not v["ok"] and v["bad_seq"] == 2
    con.execute("DROP TRIGGER audit_no_delete")
    con.execute("DELETE FROM audit WHERE seq=2")
    assert env.audit.verify()["error"].startswith("row 2 missing")
    # removing the tail is caught against an anchor recorded earlier
    con.execute("DELETE FROM audit WHERE seq>=2")
    assert env.audit.verify()["ok"]
    t = env.audit.verify(anchor_seq=head["seq"], anchor_hash=head["hash"])
    assert not t["ok"] and "truncated" in t["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("encrypted", [False, True])
async def test_extraction_prompt_gets_the_decrypted_previous_episode(env, encrypted):
    """The real add_episode path: the context Graphiti reads back for the second episode is the
    first episode's plaintext (stored encrypted), exactly as without encryption, and no
    ciphertext reaches an LLM prompt."""
    from app.engine import MemoryEngine, ZenGraphiti
    from app.embedder import NoRerank
    from app.llm import FakeLLM

    prompts: list[str] = []

    class RecordingLLM(FakeLLM):
        async def _generate_response(self, messages, *args, **kwargs):
            prompts.append("\n".join(str(getattr(m, "content", m)) for m in messages))
            raise RuntimeError("stop after the first extraction prompt")

    a, _ = await env.company("Firma Context")
    cipher = env.keys.cipher(a["id"]) if encrypted else CompanyCipher(a["id"])
    g = ZenGraphiti.create(env.engine.driver, RecordingLLM(), env.seed.g.embedder, NoRerank(), profile="v2")
    eng = MemoryEngine(g)
    first = EpisodicNode(name="oferta", group_id=a["group_id"], source=EpisodeType.text, source_description="eval",
                         content="Oferta de la Legume Fresh: roșii 8 lei/kg.",
                         valid_at=datetime(2026, 2, 10, tzinfo=timezone.utc), created_at=datetime(2026, 2, 10, tzinfo=timezone.utc))
    token = current_cipher.set(cipher)
    try:
        await g._process_episode_data(first, [], [], datetime.now(timezone.utc), a["group_id"])
    finally:
        current_cipher.reset(token)
    seen: list = []
    orig = g.retrieve_episodes

    async def spy(*args, **kwargs):
        eps = await orig(*args, **kwargs)
        seen.append([(e.content, e.name) for e in eps])
        return eps

    g.retrieve_episodes = spy
    with pytest.raises(Exception):
        await eng.ingest(a["group_id"], "scumpire", "Legume Fresh a scumpit roșiile la 11 lei/kg.",
                         datetime(2026, 3, 10, tzinfo=timezone.utc), "eval", cipher=cipher)
    assert prompts, "no extraction prompt was sent"
    assert seen == [[("Oferta de la Legume Fresh: roșii 8 lei/kg.", "oferta")]], seen
    assert "zmenc1:" not in prompts[0]
