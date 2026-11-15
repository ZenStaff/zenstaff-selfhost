"""Per-company encryption of stored raw content (envelope encryption, AES-256-GCM).

- Master keys (KEKs) come only from the environment: ZM_MASTER_KEYS="k1:<base64 32 bytes>[,k2:...]",
  ZM_MASTER_KEY_ID = the one used for new wraps (default: the last listed). They are never
  written to disk by this service.
- Each company has its own random 256-bit data key (DEK), stored only wrapped by a KEK in a
  separate SQLite file (keys.sqlite3, `secure_delete` on). A DEK has versions: rotation adds a
  version, re-encrypts the company's content, then destroys the old version.
- A value is stored as "zmenc1:<dek version>:<base64url(nonce || ciphertext+tag)>". The
  associated data binds it to the company, the field and the record ("zm1|co_x|episode.content|
  <uuid>"), so a ciphertext copied to another company, field or record does not decrypt.
- Crypto-shredding: deleting a company deletes its DEK rows (and checkpoints the WAL), so every
  copy of its encrypted content, including the ones in backups, is unreadable once no backup of
  keys.sqlite3 from before the deletion is left (see README, "Encryption at rest").

What is and is not encrypted is listed in README ("Encryption at rest").
"""

from __future__ import annotations

import base64
import contextvars
import logging
import os
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger("zen-memory.crypto")

PREFIX = "zmenc1:"
_NONCE = 12


class KeyUnavailable(RuntimeError):
    """The data key for this value no longer exists (company deleted: crypto-shredded) or the
    master key that wraps it is not configured."""


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


# ---- master keys (KEK) ----------------------------------------------------------------------


class MasterKeys:
    def __init__(self, spec: str = "", active: str = ""):
        self.keys: dict[str, bytes] = {}
        for part in (p.strip() for p in (spec or "").split(",")):
            if not part:
                continue
            kid, sep, b64 = part.partition(":")
            if not sep or not kid.strip():
                raise ValueError("ZM_MASTER_KEYS entries are <id>:<base64 key>")
            key = base64.b64decode(b64.strip() + "=" * (-len(b64.strip()) % 4))
            if len(key) != 32:
                raise ValueError(f"master key {kid!r} must be 32 bytes (got {len(key)})")
            self.keys[kid.strip()] = key
        self.active = (active or "").strip() or (list(self.keys)[-1] if self.keys else "")
        if self.keys and self.active not in self.keys:
            raise ValueError(f"ZM_MASTER_KEY_ID={self.active!r} is not in ZM_MASTER_KEYS")

    @classmethod
    def from_env(cls) -> "MasterKeys":
        return cls(os.environ.get("ZM_MASTER_KEYS", ""), os.environ.get("ZM_MASTER_KEY_ID", ""))

    @property
    def enabled(self) -> bool:
        return bool(self.keys)

    def wrap(self, secret: bytes, aad: bytes) -> tuple[str, bytes]:
        nonce = os.urandom(_NONCE)
        return self.active, nonce + AESGCM(self.keys[self.active]).encrypt(nonce, secret, aad)

    def unwrap(self, kid: str, blob: bytes, aad: bytes) -> bytes:
        if kid not in self.keys:
            raise KeyUnavailable(f"master key {kid!r} is not configured")
        return AESGCM(self.keys[kid]).decrypt(blob[:_NONCE], blob[_NONCE:], aad)


def new_master_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


# ---- company cipher -------------------------------------------------------------------------


@dataclass
class CompanyCipher:
    company_id: str
    keys: dict[int, bytes] = field(default_factory=dict)
    active: int = 0

    @property
    def enabled(self) -> bool:
        return self.active in self.keys

    def _aad(self, purpose: str, record: str) -> bytes:
        return f"zm1|{self.company_id}|{purpose}|{record}".encode()

    def encrypt(self, value: str | None, purpose: str, record: str) -> str | None:
        """Ciphertext envelope, or the value unchanged when encryption is off."""
        if value is None or not self.enabled or is_encrypted(value):
            return value
        nonce = os.urandom(_NONCE)
        ct = AESGCM(self.keys[self.active]).encrypt(nonce, value.encode(), self._aad(purpose, record))
        return f"{PREFIX}{self.active}:{_b64e(nonce + ct)}"

    def decrypt(self, value: str | None, purpose: str, record: str) -> str | None:
        """Plaintext; legacy plaintext values pass through. Raises KeyUnavailable if the key is gone."""
        if not is_encrypted(value):
            return value
        _, ver, blob = value.split(":", 2)  # type: ignore[union-attr]
        key = self.keys.get(int(ver))
        if key is None:
            raise KeyUnavailable(f"data key v{ver} of {self.company_id} does not exist")
        raw = _b64d(blob)
        return AESGCM(key).decrypt(raw[:_NONCE], raw[_NONCE:], self._aad(purpose, record)).decode()

    def decrypt_or(self, value: str | None, purpose: str, record: str, fallback: str = "[unreadable]") -> str | None:
        try:
            return self.decrypt(value, purpose, record)
        except Exception:
            return fallback

    def needs_rewrite(self, value: str | None) -> bool:
        """True for plaintext (when encryption is on) or ciphertext under a non-active version."""
        if value is None or not self.enabled:
            return False
        if not is_encrypted(value):
            return True
        return int(value.split(":", 2)[1]) != self.active


PLAINTEXT = CompanyCipher("-")  # encryption off

# Set around Graphiti calls so the engine hooks (engine.ZenBase) can encrypt what Graphiti saves
# and decrypt the previous episodes Graphiti reads back as context.
current_cipher: contextvars.ContextVar[CompanyCipher] = contextvars.ContextVar("zm_cipher", default=PLAINTEXT)


# ---- key store (keys.sqlite3) ---------------------------------------------------------------

KEY_SCHEMA = """
CREATE TABLE IF NOT EXISTS company_keys (
  company_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kek_id TEXT NOT NULL,
  wrapped BLOB NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (company_id, version)
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  kek_id TEXT NOT NULL,
  wrapped BLOB NOT NULL,
  created_at REAL NOT NULL
);
"""


class KeyStore:
    def __init__(self, path: str, master: MasterKeys):
        if path != ":memory:":
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self.master = master
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA secure_delete=ON")  # deleted key bytes are overwritten, not left in free pages
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.executescript(KEY_SCHEMA)
        self._lock = threading.RLock()
        self._cache: dict[str, CompanyCipher] = {}

    @property
    def enabled(self) -> bool:
        return self.master.enabled

    @staticmethod
    def _dek_aad(company_id: str, version: int) -> bytes:
        return f"zm-dek|{company_id}|{version}".encode()

    def _rows(self, company_id: str) -> list[tuple[int, str, bytes]]:
        return self._conn.execute(
            "SELECT version, kek_id, wrapped FROM company_keys WHERE company_id=? ORDER BY version", (company_id,)
        ).fetchall()

    def _add_version(self, company_id: str) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(MAX(version), 0) FROM company_keys WHERE company_id=?", (company_id,)).fetchone()
            version = int(row[0]) + 1
            kid, blob = self.master.wrap(secrets.token_bytes(32), self._dek_aad(company_id, version))
            self._conn.execute(
                "INSERT INTO company_keys(company_id, version, kek_id, wrapped, created_at) VALUES (?,?,?,?,?)",
                (company_id, version, kid, blob, time.time()),
            )
            self._cache.pop(company_id, None)
            return version

    def cipher(self, company_id: str, create: bool = True) -> CompanyCipher:
        """The company's cipher (all live DEK versions, newest active). Creates the first DEK on
        first use when encryption is on. With encryption off: a pass-through cipher that still
        decrypts nothing (encrypted values raise KeyUnavailable)."""
        if not self.enabled:
            return CompanyCipher(company_id)
        with self._lock:
            c = self._cache.get(company_id)
            if c is not None:
                return c
            rows = self._rows(company_id)
            if not rows and create:
                self._add_version(company_id)
                rows = self._rows(company_id)
            keys = {v: self.master.unwrap(kid, blob, self._dek_aad(company_id, v)) for v, kid, blob in rows}
            c = CompanyCipher(company_id, keys, max(keys) if keys else 0)
            if keys:
                self._cache[company_id] = c
            return c

    def has_key(self, company_id: str) -> bool:
        return bool(self._rows(company_id))

    def key_versions(self, company_id: str) -> list[dict]:
        return [{"version": v, "kek_id": kid} for v, kid, _ in self._rows(company_id)]

    def rotate_begin(self, company_id: str) -> CompanyCipher:
        """Add a new DEK version and make it active (old versions still decrypt)."""
        if not self.enabled:
            raise RuntimeError("encryption is off (ZM_MASTER_KEYS not set)")
        self.cipher(company_id)
        self._add_version(company_id)
        return self.cipher(company_id)

    def retire_below(self, company_id: str, version: int) -> int:
        """Destroy DEK versions older than `version` (after the content was re-encrypted)."""
        with self._lock:
            n = self._conn.execute("DELETE FROM company_keys WHERE company_id=? AND version<?", (company_id, version)).rowcount
            self._cache.pop(company_id, None)
            self._flush()
            return n

    def shred(self, company_id: str) -> int:
        """Crypto-shredding: destroy every DEK version of the company. Irreversible."""
        with self._lock:
            n = self._conn.execute("DELETE FROM company_keys WHERE company_id=?", (company_id,)).rowcount
            self._cache.pop(company_id, None)
            self._flush()
            return n

    def _flush(self) -> None:
        # move the (zero-overwritten) pages out of the WAL into the main file and empty the WAL
        self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def rewrap_all(self) -> dict:
        """Re-wrap every DEK and secret that is not under the active master key (KEK rotation)."""
        if not self.enabled:
            raise RuntimeError("encryption is off (ZM_MASTER_KEYS not set)")
        with self._lock:
            done = 0
            for cid, v, kid, blob in self._conn.execute("SELECT company_id, version, kek_id, wrapped FROM company_keys").fetchall():
                if kid == self.master.active:
                    continue
                aad = self._dek_aad(cid, v)
                nkid, nblob = self.master.wrap(self.master.unwrap(kid, blob, aad), aad)
                self._conn.execute("UPDATE company_keys SET kek_id=?, wrapped=? WHERE company_id=? AND version=?", (nkid, nblob, cid, v))
                done += 1
            sdone = 0
            for sid, kid, blob in self._conn.execute("SELECT id, kek_id, wrapped FROM secrets").fetchall():
                if kid == self.master.active:
                    continue
                aad = f"zm-secret|{sid}".encode()
                nkid, nblob = self.master.wrap(self.master.unwrap(kid, blob, aad), aad)
                self._conn.execute("UPDATE secrets SET kek_id=?, wrapped=? WHERE id=?", (nkid, nblob, sid))
                sdone += 1
            self._cache.clear()
            self._flush()
            return {"data_keys_rewrapped": done, "secrets_rewrapped": sdone, "kek_id": self.master.active}

    def kek_usage(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for kid, n in self._conn.execute("SELECT kek_id, COUNT(*) FROM company_keys GROUP BY kek_id"):
            out[kid] = out.get(kid, 0) + n
        for kid, n in self._conn.execute("SELECT kek_id, COUNT(*) FROM secrets GROUP BY kek_id"):
            out[kid] = out.get(kid, 0) + n
        return out

    def check_all(self) -> int:
        """Unwrap every stored key once (start-up check). Raises if a master key is missing."""
        if not self.enabled:
            n = self._conn.execute("SELECT (SELECT COUNT(*) FROM company_keys) + (SELECT COUNT(*) FROM secrets)").fetchone()[0]
            if n:
                raise KeyUnavailable(f"{n} wrapped keys exist but ZM_MASTER_KEYS is not set")
            return 0
        n = 0
        for cid, v, kid, blob in self._conn.execute("SELECT company_id, version, kek_id, wrapped FROM company_keys").fetchall():
            self.master.unwrap(kid, blob, self._dek_aad(cid, v))
            n += 1
        for sid, kid, blob in self._conn.execute("SELECT id, kek_id, wrapped FROM secrets").fetchall():
            self.master.unwrap(kid, blob, f"zm-secret|{sid}".encode())
            n += 1
        return n

    # ---- secrets (e.g. passwords of dedicated graph stores), wrapped by the KEK directly ----

    def put_secret(self, sid: str, value: str) -> None:
        if not self.enabled:
            raise RuntimeError("storing a secret needs ZM_MASTER_KEYS")
        kid, blob = self.master.wrap(value.encode(), f"zm-secret|{sid}".encode())
        with self._lock:
            self._conn.execute(
                "INSERT INTO secrets(id, kek_id, wrapped, created_at) VALUES (?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET kek_id=excluded.kek_id, wrapped=excluded.wrapped",
                (sid, kid, blob, time.time()),
            )

    def get_secret(self, sid: str) -> str | None:
        row = self._conn.execute("SELECT kek_id, wrapped FROM secrets WHERE id=?", (sid,)).fetchone()
        if row is None:
            return None
        return self.master.unwrap(row[0], row[1], f"zm-secret|{sid}".encode()).decode()

    def delete_secret(self, sid: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM secrets WHERE id=?", (sid,))
            self._flush()
