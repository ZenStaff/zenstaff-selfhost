"""Append-only, hash-chained audit log of every API call (a separate SQLite file, audit.sqlite3).

Each row: sequence number, UTC timestamp, company id, API key id, action (the endpoint), HTTP
method, route template (never the query string, which can carry search text), status code,
client IP, request id, previous hash, hash. `hash = sha256(prev_hash + canonical JSON of the
row's other fields)`, the first row chains to 64 zeros.

Append-only is enforced twice: SQLite triggers reject UPDATE and DELETE on the table, and the
chain makes any edit, insertion or deletion in the middle visible to `verify()`. Removing rows
from the END cannot be seen from the chain alone, so the head (last seq + hash) is written to
the service log at start and every AUDIT_ANCHOR_EVERY rows, and `GET /admin/audit/head` returns
it: keep those anchors somewhere else (log shipping, the nightly backup) and compare.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone

log = logging.getLogger("zen-memory.audit")

GENESIS = "0" * 64
FIELDS = ("seq", "ts", "company_id", "key_id", "auth", "action", "method", "route", "status", "ip", "request_id")
# Added in v4 (personal memory): the second space of a call that touches two (a company chat sent
# with the starter's personal key, a promotion). Hashed only when set, so older rows verify as before.
OPTIONAL_FIELDS = ("subject_id",)

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  company_id TEXT,
  key_id TEXT,
  auth TEXT NOT NULL,          -- company | admin | invalid | none
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT,
  request_id TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""


def row_hash(prev_hash: str, row: dict) -> str:
    data = {k: row.get(k) for k in FIELDS}
    for k in OPTIONAL_FIELDS:
        if row.get(k) is not None:
            data[k] = row[k]
    body = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256((prev_hash + body).encode()).hexdigest()


class AuditLog:
    def __init__(self, path: str, anchor_every: int = 1000):
        if path != ":memory:":
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.executescript(SCHEMA)
        cols = {r[1] for r in self._conn.execute("PRAGMA table_info(audit)")}
        for k in OPTIONAL_FIELDS:
            if k not in cols:
                self._conn.execute(f"ALTER TABLE audit ADD COLUMN {k} TEXT")
        self._lock = threading.Lock()
        self.anchor_every = max(0, anchor_every)

    def append(self, *, company_id: str | None, key_id: str | None, auth: str, action: str, method: str, route: str,
               status: int, ip: str | None, request_id: str | None = None, subject_id: str | None = None) -> dict:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")  # the chain head cannot move under us (other processes too)
            try:
                last = self._conn.execute("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
                prev = last["hash"] if last else GENESIS
                row = {
                    "seq": (last["seq"] + 1) if last else 1,
                    "ts": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
                    "company_id": company_id, "key_id": key_id, "auth": auth, "action": action, "method": method,
                    "route": route, "status": int(status), "ip": ip, "request_id": request_id or uuid.uuid4().hex,
                    "subject_id": subject_id,
                }
                row["prev_hash"] = prev
                row["hash"] = row_hash(prev, row)
                self._conn.execute(
                    f"INSERT INTO audit({', '.join(FIELDS + OPTIONAL_FIELDS)}, prev_hash, hash) "
                    f"VALUES ({', '.join('?' for _ in FIELDS + OPTIONAL_FIELDS)}, ?, ?)",
                    tuple(row[k] for k in FIELDS + OPTIONAL_FIELDS) + (row["prev_hash"], row["hash"]),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
        if self.anchor_every and row["seq"] % self.anchor_every == 0:
            log.info("audit anchor seq=%d hash=%s", row["seq"], row["hash"])
        return row

    def head(self) -> dict:
        last = self._conn.execute("SELECT seq, ts, hash FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
        return dict(last) if last else {"seq": 0, "ts": None, "hash": GENESIS}

    def verify(self, anchor_seq: int | None = None, anchor_hash: str | None = None) -> dict:
        """Walk the whole chain. ok=False with the first bad seq if any row was edited, inserted
        or removed; with an anchor (seq, hash recorded earlier), also detects removed tail rows."""
        prev, expected_seq, n = GENESIS, 1, 0
        t0 = time.monotonic()
        seen_anchor = anchor_seq is None
        for r in self._conn.execute(f"SELECT {', '.join(FIELDS + OPTIONAL_FIELDS)}, prev_hash, hash FROM audit ORDER BY seq"):
            r = dict(r)
            if r["seq"] != expected_seq:
                return {"ok": False, "rows": n, "bad_seq": expected_seq, "error": f"row {expected_seq} missing (next is {r['seq']})"}
            if r["prev_hash"] != prev:
                return {"ok": False, "rows": n, "bad_seq": r["seq"], "error": "prev_hash does not match the previous row"}
            if row_hash(prev, r) != r["hash"]:
                return {"ok": False, "rows": n, "bad_seq": r["seq"], "error": "row content does not match its hash"}
            if anchor_seq is not None and r["seq"] == anchor_seq:
                if anchor_hash and r["hash"] != anchor_hash:
                    return {"ok": False, "rows": n, "bad_seq": r["seq"], "error": "anchor hash differs"}
                seen_anchor = True
            prev, expected_seq, n = r["hash"], expected_seq + 1, n + 1
        if not seen_anchor:
            return {"ok": False, "rows": n, "bad_seq": anchor_seq, "error": "anchored row is gone (log truncated)"}
        return {"ok": True, "rows": n, "head": prev, "ms": int((time.monotonic() - t0) * 1000)}


def parse_networks(spec: str) -> list:
    return [ipaddress.ip_network(p.strip(), strict=False) for p in (spec or "").split(",") if p.strip()]


def client_ip(scope_client: tuple | None, headers: dict[str, str], trusted: list) -> str | None:
    """The peer address; behind a trusted proxy (AUDIT_TRUSTED_PROXIES), the right-most
    X-Forwarded-For entry that is not itself a trusted proxy."""
    peer = scope_client[0] if scope_client else None
    if not peer or not trusted:
        return peer
    try:
        if not any(ipaddress.ip_address(peer) in n for n in trusted):
            return peer
    except ValueError:
        return peer
    xff = [p.strip() for p in headers.get("x-forwarded-for", "").split(",") if p.strip()]
    for ip in reversed(xff):
        try:
            if not any(ipaddress.ip_address(ip) in n for n in trusted):
                return ip
        except ValueError:
            return ip
    return peer
