"""Control-plane storage (SQLite): companies, API keys, episode jobs and token usage.

The knowledge graph itself lives in Neo4j. This file holds only what our API needs to decide
who is calling, what they sent and what it cost. Summaries are kept only until the episode is
ingested, then cleared (data minimisation, GDPR).

With encryption on (crypto.py), the raw content columns of `episodes` (summary, source_json,
reason) are stored encrypted with the company's data key; this class encrypts on write and
decrypts on read, so callers see plaintext.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at REAL NOT NULL,
  revoked_at REAL
);
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | running | done | skipped | failed
  reason TEXT,
  source_json TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  summary TEXT,                    -- cleared once ingested or skipped
  graph_episode_uuid TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL,
  error TEXT,
  UNIQUE (company_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS episodes_company ON episodes(company_id, created_at);
CREATE INDEX IF NOT EXISTS episodes_graph_uuid ON episodes(graph_episode_uuid);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  episode_id TEXT,
  stage TEXT NOT NULL,             -- gate | extract
  model TEXT NOT NULL,
  calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_company ON usage(company_id, created_at);
-- Per-company overrides of the quota defaults (NULL = use the default from the environment).
CREATE TABLE IF NOT EXISTS company_limits (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  episodes_per_day INTEGER,
  ingest_tokens_per_month INTEGER,
  searches_per_minute INTEGER,
  updated_at REAL NOT NULL
);
-- Monthly-quota alerts already sent (one per company, month and threshold).
CREATE TABLE IF NOT EXISTS quota_alerts (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  used INTEGER NOT NULL,
  quota INTEGER NOT NULL,
  sent_at REAL NOT NULL,
  PRIMARY KEY (company_id, period, threshold)
);
-- Searches of the last minute (searches_per_minute), so the counter survives restarts.
CREATE TABLE IF NOT EXISTS search_hits (
  company_id TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS search_hits_company ON search_hits(company_id, ts);
-- Monthly-token reservations: estimated tokens of an accepted summary, held from the quota check
-- until its ingest is settled with the real usage (or released on failure).
CREATE TABLE IF NOT EXISTS token_reservations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  episode_id TEXT,
  tokens INTEGER NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS token_reservations_company ON token_reservations(company_id);
CREATE INDEX IF NOT EXISTS token_reservations_episode ON token_reservations(episode_id);
-- Dedicated graph stores (Enterprise tier): one Neo4j per company, created by scripts/zm-admin.
-- The password is in keys.sqlite3, wrapped by the master key (secret id "store:<id>").
-- Personal memory (v4): a person's space is a row of `companies` with kind='person' (own group_id,
-- own data key, own keys, own quotas). Links say which companies the person works in (by the
-- hub); a detached link is kept as history so "delete what came from that company" still works.
CREATE TABLE IF NOT EXISTS person_links (
  person_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  linked_at REAL NOT NULL,
  detached_at REAL,
  PRIMARY KEY (person_id, company_id)
);
-- Consent records: every item that left a personal space for a company memory. Only ids and a
-- hash of the text, never the text itself.
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  mode TEXT NOT NULL,              -- manual (the person pressed "send") | company_rule
  item_kind TEXT NOT NULL,         -- fact | summary_part
  item_id TEXT,
  item_sha256 TEXT NOT NULL,
  actor_ref TEXT,                  -- hub user id of the person (manual) or of who set the rule
  company_episode_id TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS consents_person ON consents(person_id, created_at);
CREATE INDEX IF NOT EXISTS consents_company ON consents(company_id, created_at);
-- A company chat sent with the starter's personal key is split once; retries return the same parts.
CREATE TABLE IF NOT EXISTS split_requests (
  company_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  person_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (company_id, idempotency_key)
);
-- Zones (v4) inside a company: the company itself (its own group_id, ref 'company'), departments
-- ('team:<hub team id>') and projects ('project:<hub project id>'), each with its own graph group in
-- the company's store and under the company's data key. Synced from the hub.
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,              -- team | project
  name TEXT NOT NULL,
  parent_ref TEXT,                 -- a project's department
  group_id TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  archived_at REAL,                -- gone from the hub: kept, readable by admins only
  UNIQUE (company_id, ref)
);
-- Who may read which zones, per hub user (synced from the hub's roles: memorie:vede per scope).
CREATE TABLE IF NOT EXISTS members (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_ref TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  company_read INTEGER NOT NULL DEFAULT 0,
  zones_json TEXT NOT NULL DEFAULT '[]',
  synced_at REAL NOT NULL,
  PRIMARY KEY (company_id, user_ref)
);
-- Rules waiting for a person's confirmation (the text is encrypted with the space's data key).
CREATE TABLE IF NOT EXISTS pending_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zone_ref TEXT NOT NULL,
  text TEXT NOT NULL,
  source_json TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  proposed_by TEXT,
  status TEXT NOT NULL,            -- pending | confirmed | rejected
  decided_by TEXT,
  decided_at REAL,
  episode_id TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_rules_company ON pending_rules(company_id, status, created_at);
CREATE TABLE IF NOT EXISTS graph_stores (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  username TEXT NOT NULL,
  container TEXT,
  status TEXT NOT NULL,            -- ready | orphaned (its company was deleted; destroy it)
  created_at REAL NOT NULL
);
"""

# A reservation older than this is ignored (its job crashed without settling; the usage table
# has the real numbers anyway).
RESERVATION_TTL_S = 6 * 3600

# Columns added after v1; created on start if missing.
MIGRATIONS = [
    ("usage", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("usage", "cost_usd", "REAL"),
    # isolation tier: standard = shared graph (group_id), enterprise = dedicated graph store
    ("companies", "tier", "TEXT NOT NULL DEFAULT 'standard'"),
    ("companies", "store_id", "TEXT"),
    # personal memory: kind = company | person; owner_ref = the hub user id of a person
    ("companies", "kind", "TEXT NOT NULL DEFAULT 'company'"),
    ("companies", "owner_ref", "TEXT"),
    # company rule: decisions of company chats go to the company memory even when they look personal
    ("companies", "auto_promote_decisions", "INTEGER NOT NULL DEFAULT 0"),
    ("companies", "rule_set_by", "TEXT"),
    ("companies", "rule_set_at", "REAL"),
    # the company a personal episode came from (NULL = a Personal chat); ids only
    ("episodes", "origin_company_id", "TEXT"),
    # zones (v4): the graph group the episode goes to (NULL = the company's own group), its zone and trust
    ("episodes", "group_id", "TEXT"),
    ("episodes", "zone_ref", "TEXT"),
    ("episodes", "trust", "TEXT NOT NULL DEFAULT 'trusted'"),
    # keys bound to a hub user (v4): zone access is looked up by this
    ("api_keys", "user_ref", "TEXT"),
    # sensitive data in company/department/project chats: 'personal' (to the starter's personal
    # memory when they have one, else dropped) | 'drop'
    ("companies", "sensitive_policy", "TEXT NOT NULL DEFAULT 'personal'"),
    # status 'deferred': stopped by the monthly token quota, summary kept, re-queued by
    # IngestWorker.retry_deferred when the quota has room again (not before retry_after)
    ("episodes", "retry_after", "REAL"),
]

# Encrypted columns of `episodes` and their purpose labels (bound into the ciphertext).
EP_FIELDS = {"summary": "ep.summary", "source_json": "ep.source", "reason": "ep.reason"}


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_api_key() -> str:
    return "zm_" + secrets.token_urlsafe(32)


class Store:
    def __init__(self, path: str, keys=None):
        # keys: crypto.KeyStore (None = no encryption)
        self.keys = keys
        if path != ":memory:":
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        for table, col, decl in MIGRATIONS:
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS companies_person_owner ON companies(owner_ref) WHERE kind='person'")
        # Before 'deferred' existed, an ingest stopped by the quota was 'failed' for good, with its
        # summary still stored: those wait for the quota now like new ones.
        self._conn.execute(
            "UPDATE episodes SET status='deferred', retry_after=0 "
            "WHERE status='failed' AND error LIKE 'quota_exceeded%' AND summary IS NOT NULL")
        self._lock = threading.Lock()

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def _x(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            return self._conn.execute(sql, args).rowcount

    def _tx(self, fn):
        """Run fn(conn) in one IMMEDIATE transaction: atomic within this process (lock) and
        against other processes using the same file (SQLite write lock)."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                out = fn(self._conn)
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")
            return out

    # ---- companies and keys -------------------------------------------------------------

    def create_company(self, name: str, api_key: str | None = None) -> tuple[dict, str]:
        company_id = "co_" + uuid.uuid4().hex[:16]
        # group_id is what isolates the company inside the shared Graphiti graph.
        # It is derived server-side and never accepted from a client.
        group_id = "g_" + uuid.uuid4().hex
        now = time.time()
        self._x(
            "INSERT INTO companies(id, name, group_id, created_at) VALUES (?,?,?,?)",
            (company_id, name, group_id, now),
        )
        raw = self.add_key(company_id, api_key)
        return self.get_company(company_id), raw  # type: ignore[return-value]

    def add_key(self, company_id: str, raw: str | None = None) -> str:
        return self.add_key_with_id(company_id, raw)[1]

    def add_key_with_id(self, company_id: str, raw: str | None = None, user_ref: str | None = None) -> tuple[str, str]:
        """A new key for the company: (key id, raw key). Only the hash is stored. `user_ref` binds
        the key to a hub user (zone access is looked up by it)."""
        raw = raw or new_api_key()
        key_id = "k_" + uuid.uuid4().hex[:12]
        self._x(
            "INSERT INTO api_keys(id, company_id, key_hash, prefix, created_at, user_ref) VALUES (?,?,?,?,?,?)",
            (key_id, company_id, hash_key(raw), raw[:7], time.time(), user_ref),
        )
        return key_id, raw

    def revoke_key(self, company_id: str, key_id: str) -> int:
        """Revokes one key of the company (0 when it is not the company's or already revoked)."""
        return self._x(
            "UPDATE api_keys SET revoked_at=? WHERE company_id=? AND id=? AND revoked_at IS NULL",
            (time.time(), company_id, key_id),
        )

    def list_keys(self, company_id: str) -> list[dict]:
        return [dict(r) for r in self._q(
            "SELECT id, prefix, created_at, revoked_at, user_ref FROM api_keys WHERE company_id=? ORDER BY created_at",
            (company_id,),
        )]

    def revoke_keys(self, company_id: str) -> int:
        return self._x(
            "UPDATE api_keys SET revoked_at=? WHERE company_id=? AND revoked_at IS NULL",
            (time.time(), company_id),
        )

    def company_for_key(self, raw: str) -> dict | None:
        """The company of a live key, with the key's id as `key_id` (for the audit log)."""
        rows = self._q(
            "SELECT c.*, k.id AS key_id, k.user_ref AS key_user_ref FROM api_keys k JOIN companies c ON c.id = k.company_id "
            "WHERE k.key_hash=? AND k.revoked_at IS NULL",
            (hash_key(raw),),
        )
        return dict(rows[0]) if rows else None

    def get_company(self, company_id: str) -> dict | None:
        rows = self._q("SELECT * FROM companies WHERE id=?", (company_id,))
        return dict(rows[0]) if rows else None

    def list_companies(self, kind: str | None = None) -> list[dict]:
        if kind is None:
            return [dict(r) for r in self._q("SELECT * FROM companies ORDER BY created_at")]
        return [dict(r) for r in self._q("SELECT * FROM companies WHERE kind=? ORDER BY created_at", (kind,))]

    # ---- personal spaces ----------------------------------------------------------------

    def person_for_owner(self, owner_ref: str) -> dict | None:
        rows = self._q("SELECT * FROM companies WHERE kind='person' AND owner_ref=?", (owner_ref,))
        return dict(rows[0]) if rows else None

    def create_person(self, owner_ref: str) -> tuple[dict, bool]:
        """The person's space (created once per hub user): (row, created)."""
        existing = self.person_for_owner(owner_ref)
        if existing is not None:
            return existing, False
        pid = "pe_" + uuid.uuid4().hex[:16]
        self._x(
            "INSERT INTO companies(id, name, group_id, created_at, kind, owner_ref) VALUES (?,?,?,?,?,?)",
            (pid, "personal", "g_" + uuid.uuid4().hex, time.time(), "person", owner_ref),
        )
        return self.get_company(pid), True  # type: ignore[return-value]

    def link_person(self, person_id: str, company_id: str) -> None:
        self._x(
            "INSERT INTO person_links(person_id, company_id, linked_at) VALUES (?,?,?) "
            "ON CONFLICT(person_id, company_id) DO UPDATE SET detached_at=NULL",
            (person_id, company_id, time.time()),
        )

    def detach_person(self, person_id: str, company_id: str) -> int:
        return self._x("UPDATE person_links SET detached_at=? WHERE person_id=? AND company_id=? AND detached_at IS NULL",
                       (time.time(), person_id, company_id))

    def person_links(self, person_id: str) -> list[dict]:
        return [dict(r) for r in self._q("SELECT company_id, linked_at, detached_at FROM person_links WHERE person_id=? ORDER BY linked_at",
                                         (person_id,))]

    def person_linked(self, person_id: str, company_id: str) -> bool:
        return bool(self._q("SELECT 1 FROM person_links WHERE person_id=? AND company_id=? AND detached_at IS NULL",
                            (person_id, company_id)))

    def set_company_rule(self, company_id: str, auto_promote_decisions: bool, set_by: str | None) -> None:
        self._x("UPDATE companies SET auto_promote_decisions=?, rule_set_by=?, rule_set_at=? WHERE id=? AND kind='company'",
                (1 if auto_promote_decisions else 0, set_by, time.time(), company_id))

    def add_consent(self, *, person_id: str, company_id: str, mode: str, item_kind: str, item_id: str | None,
                    text: str, actor_ref: str | None, company_episode_id: str | None) -> dict:
        cid = "cs_" + uuid.uuid4().hex[:16]
        self._x(
            "INSERT INTO consents(id, person_id, company_id, mode, item_kind, item_id, item_sha256, actor_ref, "
            "company_episode_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (cid, person_id, company_id, mode, item_kind, item_id, hashlib.sha256(text.encode()).hexdigest(), actor_ref,
             company_episode_id, time.time()),
        )
        return dict(self._q("SELECT * FROM consents WHERE id=?", (cid,))[0])

    def set_consent_episode(self, consent_id: str, episode_id: str | None) -> None:
        self._x("UPDATE consents SET company_episode_id=? WHERE id=?", (episode_id, consent_id))

    def consents_for(self, *, person_id: str | None = None, company_id: str | None = None, limit: int = 200) -> list[dict]:
        if person_id is not None:
            rows = self._q("SELECT * FROM consents WHERE person_id=? ORDER BY created_at DESC LIMIT ?", (person_id, limit))
        else:
            rows = self._q("SELECT * FROM consents WHERE company_id=? ORDER BY created_at DESC LIMIT ?", (company_id, limit))
        return [dict(r) for r in rows]

    def promoted_items(self, person_id: str, item_ids: list[str]) -> dict[str, str]:
        """item id -> company id it was sent to (the latest), for showing "trimis în memoria firmei"."""
        if not item_ids:
            return {}
        marks = ",".join("?" for _ in item_ids)
        rows = self._q(f"SELECT item_id, company_id FROM consents WHERE person_id=? AND item_kind='fact' AND item_id IN ({marks}) "
                       f"ORDER BY created_at", (person_id, *item_ids))
        return {r["item_id"]: r["company_id"] for r in rows}

    # ---- zones and members -----------------------------------------------------------------

    def zones_of(self, company_id: str, include_archived: bool = False) -> list[dict]:
        sql = "SELECT * FROM zones WHERE company_id=?" + ("" if include_archived else " AND archived_at IS NULL") + " ORDER BY kind, name"
        return [dict(r) for r in self._q(sql, (company_id,))]

    def zone(self, company_id: str, ref: str) -> dict | None:
        rows = self._q("SELECT * FROM zones WHERE company_id=? AND ref=?", (company_id, ref))
        return dict(rows[0]) if rows else None

    def sync_access(self, company_id: str, zones: list[dict], members: list[dict]) -> dict:
        """Replace the company's zones and member access with the hub's view (one transaction)."""
        now = time.time()

        def run(c):
            seen = set()
            created = 0
            for z in zones:
                seen.add(z["ref"])
                row = c.execute("SELECT id FROM zones WHERE company_id=? AND ref=?", (company_id, z["ref"])).fetchone()
                if row is None:
                    c.execute("INSERT INTO zones(id, company_id, ref, kind, name, parent_ref, group_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                              ("zn_" + uuid.uuid4().hex[:16], company_id, z["ref"], z["kind"], z["name"], z.get("parent_ref"),
                               "g_" + uuid.uuid4().hex, now))
                    created += 1
                else:
                    c.execute("UPDATE zones SET name=?, parent_ref=?, archived_at=NULL WHERE id=?", (z["name"], z.get("parent_ref"), row["id"]))
            archived = 0
            for r in c.execute("SELECT id, ref FROM zones WHERE company_id=? AND archived_at IS NULL", (company_id,)).fetchall():
                if r["ref"] not in seen:
                    c.execute("UPDATE zones SET archived_at=? WHERE id=?", (now, r["id"]))
                    archived += 1
            c.execute("DELETE FROM members WHERE company_id=?", (company_id,))
            for m in members:
                c.execute("INSERT INTO members(company_id, user_ref, admin, company_read, zones_json, synced_at) VALUES (?,?,?,?,?,?)",
                          (company_id, m["user_ref"], 1 if m.get("admin") else 0, 1 if m.get("company") else 0,
                           json.dumps(sorted(set(m.get("zones") or []))), now))
            return {"zones_created": created, "zones_archived": archived, "members": len(members)}

        return self._tx(run)

    def member(self, company_id: str, user_ref: str) -> dict | None:
        rows = self._q("SELECT * FROM members WHERE company_id=? AND user_ref=?", (company_id, user_ref))
        if not rows:
            return None
        d = dict(rows[0])
        d["zones"] = json.loads(d.pop("zones_json"))
        return d

    def members_of(self, company_id: str) -> list[dict]:
        out = []
        for r in self._q("SELECT * FROM members WHERE company_id=? ORDER BY user_ref", (company_id,)):
            d = dict(r)
            d["zones"] = json.loads(d.pop("zones_json"))
            out.append(d)
        return out

    def set_sensitive_policy(self, company_id: str, policy: str) -> None:
        self._x("UPDATE companies SET sensitive_policy=? WHERE id=? AND kind='company'", (policy, company_id))

    # ---- pending rules ---------------------------------------------------------------------

    def add_pending_rule(self, company_id: str, zone_ref: str, text: str, source: dict, reference_time: str,
                         proposed_by: str | None) -> dict:
        rid = "rl_" + uuid.uuid4().hex[:16]
        c = self._cipher(company_id)
        enc = (lambda v, p: c.encrypt(v, p, rid)) if c is not None else (lambda v, p: v)
        self._x("INSERT INTO pending_rules(id, company_id, zone_ref, text, source_json, reference_time, proposed_by, status, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (rid, company_id, zone_ref, enc(text, "rule.text"), enc(json.dumps(source, ensure_ascii=False), "rule.source"),
                 reference_time, proposed_by, "pending", time.time()))
        return self.get_pending_rule(company_id, rid)  # type: ignore[return-value]

    def _dec_rule(self, row) -> dict:
        d = dict(row)
        c = self._cipher(d["company_id"], create=False) if str(d.get("text", "")).startswith("zmenc1:") else None
        if c is not None:
            d["text"] = c.decrypt_or(d["text"], "rule.text", d["id"])
            d["source_json"] = c.decrypt_or(d["source_json"], "rule.source", d["id"], fallback="{}")
        d["source"] = json.loads(d.pop("source_json") or "{}")
        return d

    def reencrypt_rules(self, company_id: str) -> int:
        c = self._cipher(company_id)
        if c is None or not c.enabled:
            return 0
        n = 0
        for r in self._q("SELECT id, text, source_json FROM pending_rules WHERE company_id=? AND status='pending'", (company_id,)):
            if not (c.needs_rewrite(r["text"]) or c.needs_rewrite(r["source_json"])):
                continue
            self._x("UPDATE pending_rules SET text=?, source_json=? WHERE id=?",
                    (c.encrypt(c.decrypt(r["text"], "rule.text", r["id"]), "rule.text", r["id"]),
                     c.encrypt(c.decrypt(r["source_json"], "rule.source", r["id"]), "rule.source", r["id"]), r["id"]))
            n += 1
        return n

    def get_pending_rule(self, company_id: str, rule_id: str) -> dict | None:
        rows = self._q("SELECT * FROM pending_rules WHERE company_id=? AND id=?", (company_id, rule_id))
        return self._dec_rule(rows[0]) if rows else None

    def pending_rules(self, company_id: str, zone_refs: list[str], status: str = "pending") -> list[dict]:
        if not zone_refs:
            return []
        marks = ",".join("?" for _ in zone_refs)
        return [self._dec_rule(r) for r in self._q(
            f"SELECT * FROM pending_rules WHERE company_id=? AND status=? AND zone_ref IN ({marks}) ORDER BY created_at DESC LIMIT 200",
            (company_id, status, *zone_refs))]

    def decide_rule(self, company_id: str, rule_id: str, status: str, by: str | None, episode_id: str | None) -> int:
        # the text is kept only while pending; a decided rule keeps ids and who decided
        return self._x("UPDATE pending_rules SET status=?, decided_by=?, decided_at=?, episode_id=?, text='', source_json='{}' "
                       "WHERE company_id=? AND id=? AND status='pending'",
                       (status, by, time.time(), episode_id, company_id, rule_id))

    def find_split(self, company_id: str, key: str) -> dict | None:
        rows = self._q("SELECT * FROM split_requests WHERE company_id=? AND idempotency_key=?", (company_id, key))
        return dict(rows[0]) if rows else None

    def save_split(self, company_id: str, key: str, person_id: str, result: dict) -> None:
        self._x("INSERT OR IGNORE INTO split_requests(company_id, idempotency_key, person_id, result_json, created_at) VALUES (?,?,?,?,?)",
                (company_id, key, person_id, json.dumps(result), time.time()))

    def graph_uuids_from_origin(self, person_id: str, origin_company_id: str) -> list[str]:
        return [r["graph_episode_uuid"] for r in self._q(
            "SELECT graph_episode_uuid FROM episodes WHERE company_id=? AND origin_company_id=? AND graph_episode_uuid IS NOT NULL",
            (person_id, origin_company_id))]

    def delete_episodes_from_origin(self, person_id: str, origin_company_id: str) -> int:
        return self._x("DELETE FROM episodes WHERE company_id=? AND origin_company_id=?", (person_id, origin_company_id))

    def set_company_store(self, company_id: str, store_id: str | None) -> None:
        self._x("UPDATE companies SET store_id=?, tier=? WHERE id=?",
                (store_id, "enterprise" if store_id else "standard", company_id))

    # ---- dedicated graph stores ------------------------------------------------------------

    def add_graph_store(self, store_id: str, company_id: str, uri: str, username: str, container: str | None) -> dict:
        self._x("INSERT INTO graph_stores(id, company_id, uri, username, container, status, created_at) VALUES (?,?,?,?,?,?,?)",
                (store_id, company_id, uri, username, container, "ready", time.time()))
        return self.get_graph_store(store_id)  # type: ignore[return-value]

    def get_graph_store(self, store_id: str) -> dict | None:
        rows = self._q("SELECT * FROM graph_stores WHERE id=?", (store_id,))
        return dict(rows[0]) if rows else None

    def list_graph_stores(self) -> list[dict]:
        return [dict(r) for r in self._q("SELECT * FROM graph_stores ORDER BY created_at")]

    def set_graph_store_status(self, store_id: str, status: str) -> None:
        self._x("UPDATE graph_stores SET status=? WHERE id=?", (status, store_id))

    def delete_graph_store(self, store_id: str) -> None:
        self._x("DELETE FROM graph_stores WHERE id=?", (store_id,))

    def companies_on_store(self, store_id: str) -> list[dict]:
        return [dict(r) for r in self._q("SELECT * FROM companies WHERE store_id=?", (store_id,))]

    def delete_company(self, company_id: str) -> None:
        self._x("DELETE FROM usage WHERE company_id=?", (company_id,))
        self._x("DELETE FROM company_limits WHERE company_id=?", (company_id,))
        self._x("DELETE FROM quota_alerts WHERE company_id=?", (company_id,))
        self._x("DELETE FROM search_hits WHERE company_id=?", (company_id,))
        self._x("DELETE FROM token_reservations WHERE company_id=?", (company_id,))
        self._x("DELETE FROM split_requests WHERE company_id=? OR person_id=?", (company_id, company_id))
        # consent records stay (ids + hash only): the company keeps proof of what it was given
        self._x("DELETE FROM companies WHERE id=?", (company_id,))

    # ---- episodes -----------------------------------------------------------------------

    def find_episode(self, company_id: str, idempotency_key: str) -> dict | None:
        rows = self._q(
            "SELECT * FROM episodes WHERE company_id=? AND idempotency_key=?",
            (company_id, idempotency_key),
        )
        return dict(rows[0]) if rows else None

    def insert_episode(
        self,
        company_id: str,
        idempotency_key: str,
        status: str,
        reason: str | None,
        source: dict,
        reference_time: str,
        summary: str | None,
        origin_company_id: str | None = None,
        group_id: str | None = None,
        zone_ref: str | None = None,
        trust: str = "trusted",
    ) -> dict:
        episode_id = "ep_" + uuid.uuid4().hex[:20]
        now = time.time()
        enc = self._enc(company_id, episode_id)
        self._x(
            "INSERT INTO episodes(id, company_id, idempotency_key, status, reason, source_json, "
            "reference_time, summary, created_at, finished_at, origin_company_id, group_id, zone_ref, trust) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                episode_id,
                company_id,
                idempotency_key,
                status,
                enc("reason", reason),
                enc("source_json", json.dumps(source, ensure_ascii=False)),
                reference_time,
                enc("summary", summary),
                now,
                now if status == "skipped" else None,
                origin_company_id,
                group_id,
                zone_ref,
                trust,
            ),
        )
        return self.get_episode(company_id, episode_id)  # type: ignore[return-value]

    # ---- field encryption -----------------------------------------------------------------

    def _cipher(self, company_id: str, create: bool = True):
        return self.keys.cipher(company_id, create=create) if self.keys is not None else None

    def _enc(self, company_id: str, episode_id: str):
        c = self._cipher(company_id)

        def enc(col: str, value):
            return c.encrypt(value, EP_FIELDS[col], episode_id) if c is not None else value

        return enc

    def _dec(self, row) -> dict:
        d = dict(row)
        c = self._cipher(d["company_id"], create=False) if any(isinstance(d.get(k), str) and d[k].startswith("zmenc1:") for k in EP_FIELDS) else None
        if c is not None:
            for col, purpose in EP_FIELDS.items():
                if col in d:
                    d[col] = c.decrypt_or(d[col], purpose, d["id"], fallback=None if col != "source_json" else "{}")
        return d

    def reencrypt_episodes(self, company_id: str) -> int:
        """Rewrite this company's episode rows under its active data key (rotation, or
        encrypting rows written before encryption was turned on)."""
        c = self._cipher(company_id)
        if c is None or not c.enabled:
            return 0
        n = 0
        for row in self._q("SELECT id, company_id, summary, source_json, reason FROM episodes WHERE company_id=?", (company_id,)):
            if not any(c.needs_rewrite(row[k]) for k in EP_FIELDS):
                continue
            plain = {k: c.decrypt(row[k], EP_FIELDS[k], row["id"]) for k in EP_FIELDS}
            self._x("UPDATE episodes SET summary=?, source_json=?, reason=? WHERE id=? AND company_id=?",
                    (c.encrypt(plain["summary"], EP_FIELDS["summary"], row["id"]),
                     c.encrypt(plain["source_json"], EP_FIELDS["source_json"], row["id"]),
                     c.encrypt(plain["reason"], EP_FIELDS["reason"], row["id"]), row["id"], company_id))
            n += 1
        return n

    def get_episode(self, company_id: str, episode_id: str) -> dict | None:
        rows = self._q("SELECT * FROM episodes WHERE id=? AND company_id=?", (episode_id, company_id))
        return self._dec(rows[0]) if rows else None

    def mark_running(self, episode_id: str) -> None:
        self._x("UPDATE episodes SET status='running', started_at=? WHERE id=?", (time.time(), episode_id))

    def mark_done(self, episode_id: str, graph_uuid: str | None, status: str = "done", reason: str | None = None) -> None:
        if reason is not None:
            rows = self._q("SELECT company_id FROM episodes WHERE id=?", (episode_id,))
            if rows:
                reason = self._enc(rows[0]["company_id"], episode_id)("reason", reason)
        self._x(
            "UPDATE episodes SET status=?, reason=COALESCE(?, reason), graph_episode_uuid=?, "
            "finished_at=?, summary=NULL WHERE id=?",
            (status, reason, graph_uuid, time.time(), episode_id),
        )

    def mark_failed(self, episode_id: str, error: str) -> None:
        self._x(
            "UPDATE episodes SET status='failed', error=?, finished_at=? WHERE id=?",
            (error[:2000], time.time(), episode_id),
        )

    def mark_deferred(self, episode_id: str, error: str, retry_after: float) -> None:
        """Stopped by the monthly token quota: keep the summary, retry when the quota has room."""
        self._x(
            "UPDATE episodes SET status='deferred', error=?, retry_after=?, finished_at=? WHERE id=?",
            (error[:2000], retry_after, time.time(), episode_id),
        )

    def deferred_episodes(self, now: float) -> list[dict]:
        """Deferred episodes due for a quota check, oldest first."""
        return [
            self._dec(r)
            for r in self._q(
                "SELECT * FROM episodes WHERE status='deferred' AND summary IS NOT NULL "
                "AND COALESCE(retry_after, 0) <= ? ORDER BY created_at", (now,))
        ]

    def requeue_deferred(self, episode_id: str, reservation: str) -> bool:
        """deferred -> queued, with the token reservation that admitted it (one transaction)."""

        def run(c):
            n = c.execute("UPDATE episodes SET status='queued', error=NULL, retry_after=NULL, started_at=NULL, "
                          "finished_at=NULL WHERE id=? AND status='deferred'", (episode_id,)).rowcount
            if n:
                c.execute("UPDATE token_reservations SET episode_id=? WHERE id=?", (episode_id, reservation))
            else:
                c.execute("DELETE FROM token_reservations WHERE id=?", (reservation,))
            return n > 0

        return self._tx(run)

    def postpone_deferred(self, episode_id: str, retry_after: float) -> None:
        self._x("UPDATE episodes SET retry_after=? WHERE id=? AND status='deferred'", (retry_after, episode_id))

    def pending_episodes(self) -> list[dict]:
        return [
            self._dec(r)
            for r in self._q(
                "SELECT * FROM episodes WHERE status IN ('queued','running') ORDER BY created_at"
            )
        ]

    def pending_summaries(self, company_id: str) -> list[dict]:
        """Summaries received but not ingested yet (GDPR erasure rewrites them too)."""
        return [self._dec(r) for r in self._q(
            "SELECT id, company_id, summary FROM episodes WHERE company_id=? AND status IN ('queued','deferred') "
            "AND summary IS NOT NULL",
            (company_id,))]

    def set_summary(self, episode_id: str, summary: str, company_id: str | None = None) -> None:
        if company_id is not None:
            summary = self._enc(company_id, episode_id)("summary", summary)
        self._x("UPDATE episodes SET summary=? WHERE id=? AND status IN ('queued','deferred')", (summary, episode_id))

    def sources_for_graph_episodes(self, company_id: str, graph_uuids: list[str]) -> dict[str, dict]:
        if not graph_uuids:
            return {}
        marks = ",".join("?" for _ in graph_uuids)
        rows = self._q(
            f"SELECT id, company_id, graph_episode_uuid, source_json, reference_time FROM episodes "
            f"WHERE company_id=? AND graph_episode_uuid IN ({marks})",
            (company_id, *graph_uuids),
        )
        out = {}
        for r in rows:
            src = json.loads(self._dec(r)["source_json"])
            src["episode_id"] = r["id"]
            src["reference_time"] = r["reference_time"]
            out[r["graph_episode_uuid"]] = src
        return out

    # ---- usage --------------------------------------------------------------------------

    def record_usage(
        self, company_id: str, episode_id: str | None, stage: str, model: str, calls: int, tin: int, tout: int,
        cache_write: int = 0, cache_read: int = 0, cost_usd: float | None = None,
        reservation: str | None = None, keep_reserved: int = 0,
    ) -> None:
        """Record real usage. With `reservation`, settle it in the same transaction: release it
        (keep_reserved=0) or shrink it to `keep_reserved` tokens still expected later."""

        def run(c):
            if calls:
                c.execute(
                    "INSERT INTO usage(company_id, episode_id, stage, model, calls, input_tokens, output_tokens, "
                    "cache_write_tokens, cache_read_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (company_id, episode_id, stage, model, calls, tin, tout, cache_write, cache_read, cost_usd, time.time()),
                )
            if reservation:
                if keep_reserved > 0:
                    c.execute("UPDATE token_reservations SET tokens=?, episode_id=COALESCE(?, episode_id) WHERE id=?",
                              (keep_reserved, episode_id, reservation))
                else:
                    c.execute("DELETE FROM token_reservations WHERE id=?", (reservation,))

        if calls == 0 and not reservation:
            return
        self._tx(run)

    # ---- token reservations (monthly quota) ----------------------------------------------

    @staticmethod
    def _used_and_reserved(c, company_id: str, since: float, now: float, exclude: str | None = None) -> tuple[int, int]:
        used = c.execute(
            "SELECT COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0) "
            "FROM usage WHERE company_id=? AND created_at>=?", (company_id, since)).fetchone()[0]
        reserved = c.execute(
            "SELECT COALESCE(SUM(tokens), 0) FROM token_reservations WHERE company_id=? AND created_at>=? AND id IS NOT ?",
            (company_id, now - RESERVATION_TTL_S, exclude)).fetchone()[0]
        return int(used), int(reserved)

    def reserve_tokens(self, company_id: str, tokens: int, limit: int, since: float) -> tuple[str | None, int]:
        """Atomically: if usage this period + live reservations + `tokens` fits in `limit` (0 =
        unlimited), hold `tokens` and return (reservation id, committed); else (None, committed)."""
        now = time.time()

        def run(c):
            used, reserved = self._used_and_reserved(c, company_id, since, now)
            committed = used + reserved
            if limit > 0 and committed + tokens > limit:
                return None, committed
            rid = "rs_" + uuid.uuid4().hex[:16]
            c.execute("INSERT INTO token_reservations(id, company_id, tokens, created_at) VALUES (?,?,?,?)",
                      (rid, company_id, int(tokens), now))
            return rid, committed + tokens

        return self._tx(run)

    def extend_reservation(self, reservation: str, company_id: str, tokens: int, limit: int, since: float) -> bool:
        """Atomically raise a reservation to `tokens` if the period still has room for it."""
        now = time.time()

        def run(c):
            used, reserved_others = self._used_and_reserved(c, company_id, since, now, exclude=reservation)
            if limit > 0 and used + reserved_others + tokens > limit:
                return False
            n = c.execute("UPDATE token_reservations SET tokens=?, created_at=? WHERE id=?", (int(tokens), now, reservation)).rowcount
            if n == 0:
                c.execute("INSERT INTO token_reservations(id, company_id, tokens, created_at) VALUES (?,?,?,?)",
                          (reservation, company_id, int(tokens), now))
            return True

        return self._tx(run)

    def reservation_for_episode(self, episode_id: str) -> dict | None:
        rows = self._q("SELECT * FROM token_reservations WHERE episode_id=?", (episode_id,))
        return dict(rows[0]) if rows else None

    def release_reservation(self, reservation: str) -> None:
        self._x("DELETE FROM token_reservations WHERE id=?", (reservation,))

    def reserved_tokens(self, company_id: str) -> int:
        return self._q(
            "SELECT COALESCE(SUM(tokens), 0) AS n FROM token_reservations WHERE company_id=? AND created_at>=?",
            (company_id, time.time() - RESERVATION_TTL_S))[0]["n"]

    # ---- search rate (persisted) ------------------------------------------------------------

    def take_search_slot(self, company_id: str, now: float, limit: int, window: float = 60.0) -> tuple[bool, int, float | None]:
        """Atomically: drop hits older than the window; if fewer than `limit` remain, record one.
        Returns (allowed, hits in the window, oldest hit time)."""

        def run(c):
            c.execute("DELETE FROM search_hits WHERE company_id=? AND ts<=?", (company_id, now - window))
            n, oldest = c.execute("SELECT COUNT(*), MIN(ts) FROM search_hits WHERE company_id=?", (company_id,)).fetchone()
            if limit > 0 and n >= limit:
                return False, n, oldest
            c.execute("INSERT INTO search_hits(company_id, ts) VALUES (?,?)", (company_id, now))
            return True, n + 1, oldest if oldest is not None else now

        out = self._tx(run)
        if int(now) % 97 == 0:  # now and then, drop other companies' stale rows
            self._x("DELETE FROM search_hits WHERE ts<=?", (now - 2 * window,))
        return out

    def search_count(self, company_id: str, now: float, window: float = 60.0) -> int:
        return self._q("SELECT COUNT(*) AS n FROM search_hits WHERE company_id=? AND ts>?", (company_id, now - window))[0]["n"]

    # ---- quotas -------------------------------------------------------------------------

    def episodes_since(self, company_id: str, since: float) -> int:
        """Episodes received (not duplicates; skipped ones count, the gate cost money)."""
        return self._q("SELECT COUNT(*) AS n FROM episodes WHERE company_id=? AND created_at>=?", (company_id, since))[0]["n"]

    def tokens_since(self, company_id: str, since: float) -> int:
        """LLM tokens billed to the company: input (uncached + cache writes + cache reads) + output."""
        return self._q(
            "SELECT COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0) AS n "
            "FROM usage WHERE company_id=? AND created_at>=?",
            (company_id, since),
        )[0]["n"]

    def get_limits(self, company_id: str) -> dict:
        rows = self._q("SELECT episodes_per_day, ingest_tokens_per_month, searches_per_minute, updated_at FROM company_limits WHERE company_id=?", (company_id,))
        return dict(rows[0]) if rows else {}

    def set_limits(self, company_id: str, values: dict) -> None:
        cur = self.get_limits(company_id)
        merged = {k: cur.get(k) for k in ("episodes_per_day", "ingest_tokens_per_month", "searches_per_minute")}
        merged.update(values)
        self._x(
            "INSERT INTO company_limits(company_id, episodes_per_day, ingest_tokens_per_month, searches_per_minute, updated_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET episodes_per_day=excluded.episodes_per_day, "
            "ingest_tokens_per_month=excluded.ingest_tokens_per_month, searches_per_minute=excluded.searches_per_minute, "
            "updated_at=excluded.updated_at",
            (company_id, merged["episodes_per_day"], merged["ingest_tokens_per_month"], merged["searches_per_minute"], time.time()),
        )

    def clear_limits(self, company_id: str) -> int:
        return self._x("DELETE FROM company_limits WHERE company_id=?", (company_id,))

    def claim_alert(self, company_id: str, period: str, threshold: int, used: int, quota: int) -> bool:
        """True the first time this (company, month, threshold) alert is claimed."""
        try:
            self._x(
                "INSERT INTO quota_alerts(company_id, period, threshold, used, quota, sent_at) VALUES (?,?,?,?,?,?)",
                (company_id, period, threshold, used, quota, time.time()),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    def alerts_for(self, company_id: str) -> list[dict]:
        return [dict(r) for r in self._q("SELECT period, threshold, used, quota, sent_at FROM quota_alerts WHERE company_id=? ORDER BY sent_at", (company_id,))]

    def usage_summary(self, since: float = 0.0, until: float | None = None) -> list[dict[str, Any]]:
        until = until or time.time() + 1
        rows = self._q(
            """
            SELECT c.id AS company_id, c.name AS name,
              (SELECT COUNT(*) FROM episodes e WHERE e.company_id=c.id AND e.created_at BETWEEN ? AND ?) AS episodes_total,
              (SELECT COUNT(*) FROM episodes e WHERE e.company_id=c.id AND e.status='done' AND e.created_at BETWEEN ? AND ?) AS episodes_ingested,
              (SELECT COUNT(*) FROM episodes e WHERE e.company_id=c.id AND e.status='skipped' AND e.created_at BETWEEN ? AND ?) AS episodes_skipped,
              (SELECT COUNT(*) FROM episodes e WHERE e.company_id=c.id AND e.status='failed' AND e.created_at BETWEEN ? AND ?) AS episodes_failed,
              (SELECT COUNT(*) FROM episodes e WHERE e.company_id=c.id AND e.status='deferred' AND e.created_at BETWEEN ? AND ?) AS episodes_deferred,
              COALESCE((SELECT SUM(calls) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?),0) AS llm_calls,
              COALESCE((SELECT SUM(input_tokens) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?),0) AS input_tokens,
              COALESCE((SELECT SUM(output_tokens) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?),0) AS output_tokens,
              COALESCE((SELECT SUM(cache_write_tokens) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?),0) AS cache_write_tokens,
              COALESCE((SELECT SUM(cache_read_tokens) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?),0) AS cache_read_tokens,
              (SELECT SUM(cost_usd) FROM usage u WHERE u.company_id=c.id AND u.created_at BETWEEN ? AND ?) AS cost_usd_metered,
              (SELECT SUM(input_tokens) FROM usage u WHERE u.company_id=c.id AND u.cost_usd IS NULL AND u.created_at BETWEEN ? AND ?) AS legacy_input,
              (SELECT SUM(output_tokens) FROM usage u WHERE u.company_id=c.id AND u.cost_usd IS NULL AND u.created_at BETWEEN ? AND ?) AS legacy_output
            FROM companies c ORDER BY c.created_at
            """,
            (since, until) * 13,
        )
        return [dict(r) for r in rows]

    def usage_for_episode(self, episode_id: str) -> list[dict]:
        return [
            dict(r)
            for r in self._q(
                "SELECT stage, model, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd "
                "FROM usage WHERE episode_id=?",
                (episode_id,),
            )
        ]
