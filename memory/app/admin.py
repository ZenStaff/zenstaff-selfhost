"""Offline admin commands, run inside the API container (work while the API is stopped):

    python -m app.admin audit-verify [/data/audit.sqlite3] [--anchor SEQ:HASH]
    python -m app.admin audit-head   [/data/audit.sqlite3]

Everything that changes data (migrations, key rotation, rewrap) goes through the running API's
admin endpoints instead (scripts/zm-admin), because the API holds each company's ingest lock.
"""

from __future__ import annotations

import json
import sys

from .audit import AuditLog


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("audit-verify", "audit-head"):
        print(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    anchor = None
    if "--anchor" in rest:
        i = rest.index("--anchor")
        anchor = rest[i + 1]
        rest = rest[:i] + rest[i + 2:]
    path = rest[0] if rest else "/data/audit.sqlite3"
    log = AuditLog(path, anchor_every=0)
    if cmd == "audit-head":
        print(json.dumps(log.head()))
        return 0
    seq, hsh = (anchor.split(":", 1) if anchor else (None, None))
    res = log.verify(int(seq) if seq else None, hsh)
    print(json.dumps(res))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
