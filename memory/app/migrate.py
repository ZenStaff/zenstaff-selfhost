"""Move one company's graph between graph stores (shared Neo4j <-> its dedicated Neo4j).

The company keeps its group_id in both places, so every query stays the same and a dedicated
store simply holds one group. Steps (`copy_group`):

1. refuse if the target already holds nodes of this group; export every node of the group (labels + all properties, embeddings included) and every
   relationship between two of its nodes; refuse if a relationship crosses into another group;
2. write them into the target store (indexes are created first), embeddings through
   `db.create.set*VectorProperty` like Graphiti does;
3. verify: node and relationship counts per label/type, and a SHA-256 digest over every node
   and relationship (canonical JSON, embeddings rounded to 6 decimals) must be equal on both sides;
4. only then the caller switches the company's route, and the source copy is deleted.

The caller (main.py) holds the company's ingest lock for the whole move, so nothing is written
to the company's memory meanwhile. Reads keep going to the source until the switch.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Any

log = logging.getLogger("zen-memory.migrate")

PRIMARY_LABELS = ("Episodic", "Entity", "Community", "Saga")
BATCH = 500
_SAFE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class MigrationError(RuntimeError):
    pass


def _q(name: str) -> str:
    if not _SAFE.match(name):
        raise MigrationError(f"unexpected label or type {name!r}")
    return f"`{name}`"


def _primary(labels: list[str]) -> str:
    for p in PRIMARY_LABELS:
        if p in labels:
            return p
    raise MigrationError(f"node with labels {labels} has none of {PRIMARY_LABELS}")


def _is_embedding(k: str, v: Any) -> bool:
    return k.endswith("_embedding") and isinstance(v, list)


async def export_group(engine, group_id: str) -> tuple[list[dict], list[dict]]:
    nodes = await engine.scoped(
        group_id,
        "MATCH (n) WHERE n.group_id = $g RETURN n.uuid AS uuid, labels(n) AS labels, properties(n) AS props",
    )
    rels = await engine.scoped(
        group_id,
        """
        MATCH (a)-[r]->(b) WHERE a.group_id = $g AND b.group_id = $g
        RETURN a.uuid AS s, labels(a) AS sl, b.uuid AS t, labels(b) AS tl, type(r) AS type, properties(r) AS props
        """,
    )
    crossing = await engine.scoped(
        group_id,
        "MATCH (a)-[r]-(b) WHERE a.group_id = $g AND (b.group_id IS NULL OR b.group_id <> $g) RETURN count(r) AS c",
    )
    if crossing and crossing[0]["c"]:
        raise MigrationError(f"{crossing[0]['c']} relationships connect this group to nodes outside it")
    for n in nodes:
        if not n["uuid"]:
            raise MigrationError("node without uuid")
        if n["props"].get("group_id") != group_id:
            raise MigrationError("node of another group in the export")
    return nodes, rels


def _canon(v: Any) -> Any:
    if isinstance(v, float):
        return round(v, 6)
    if isinstance(v, list):
        return [_canon(x) for x in v]
    if hasattr(v, "iso_format"):
        return v.iso_format()
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def digest(nodes: list[dict], rels: list[dict]) -> dict:
    node_lines = sorted(
        json.dumps([n["uuid"], sorted(n["labels"]), {k: _canon(v) for k, v in n["props"].items()}], sort_keys=True,
                   ensure_ascii=False, default=str)
        for n in nodes
    )
    rel_lines = sorted(
        json.dumps([r["type"], r["s"], r["t"], {k: _canon(v) for k, v in r["props"].items()}], sort_keys=True,
                   ensure_ascii=False, default=str)
        for r in rels
    )
    h = hashlib.sha256()
    for line in node_lines + ["--"] + rel_lines:
        h.update(line.encode())
        h.update(b"\n")
    by_label: dict[str, int] = {}
    for n in nodes:
        k = ":".join(sorted(n["labels"]))
        by_label[k] = by_label.get(k, 0) + 1
    by_type: dict[str, int] = {}
    for r in rels:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
    return {"nodes": len(nodes), "relationships": len(rels), "by_label": dict(sorted(by_label.items())),
            "by_type": dict(sorted(by_type.items())), "sha256": h.hexdigest()}


async def import_group(engine, group_id: str, nodes: list[dict], rels: list[dict]) -> None:
    # nodes, bucketed by label set and by which embedding properties they carry
    buckets: dict[tuple, list[dict]] = {}
    for n in nodes:
        emb = tuple(sorted(k for k, v in n["props"].items() if _is_embedding(k, v)))
        buckets.setdefault((tuple(sorted(n["labels"])), _primary(n["labels"]), emb), []).append(n)
    for (labels, primary, emb), items in buckets.items():
        label_str = ":" + ":".join(_q(lbl) for lbl in labels)
        calls = "".join(
            f" WITH n, r CALL db.create.setNodeVectorProperty(n, '{k}', r.emb.{_q(k)[1:-1]})" for k in emb
        )
        cypher = f"UNWIND $rows AS r CREATE (n{label_str} {{group_id: $g}}) SET n += r.props{calls} RETURN count(*) AS c"
        for i in range(0, len(items), BATCH):
            rows = [{"props": {k: v for k, v in n["props"].items() if k not in emb},
                     "emb": {k: n["props"][k] for k in emb}} for n in items[i:i + BATCH]]
            await engine.scoped(group_id, cypher, rows=rows)
    rbuckets: dict[tuple, list[dict]] = {}
    for r in rels:
        emb = tuple(sorted(k for k, v in r["props"].items() if _is_embedding(k, v)))
        rbuckets.setdefault((_primary(r["sl"]), r["type"], _primary(r["tl"]), emb), []).append(r)
    for (sl, rtype, tl, emb), items in rbuckets.items():
        calls = "".join(
            f" WITH x, r CALL db.create.setRelationshipVectorProperty(x, '{k}', r.emb.{_q(k)[1:-1]})" for k in emb
        )
        cypher = (
            f"UNWIND $rows AS r MATCH (a:{_q(sl)} {{uuid: r.s, group_id: $g}}) MATCH (b:{_q(tl)} {{uuid: r.t, group_id: $g}}) "
            f"CREATE (a)-[x:{_q(rtype)}]->(b) SET x += r.props{calls} RETURN count(*) AS c"
        )
        for i in range(0, len(items), BATCH):
            rows = [{"s": r["s"], "t": r["t"], "props": {k: v for k, v in r["props"].items() if k not in emb},
                     "emb": {k: r["props"][k] for k in emb}} for r in items[i:i + BATCH]]
            res = await engine.scoped(group_id, cypher, rows=rows)
            if res and res[0]["c"] != len(rows):
                raise MigrationError(f"{rtype}: wrote {res[0]['c']} of {len(rows)} relationships (missing endpoints)")


async def copy_group(src, dst, group_id: str) -> dict:
    """Copy the group from engine `src` to engine `dst` and verify it. Returns a report; raises
    on any mismatch, in which case the partial copy in `dst` is removed and `src` is untouched.
    The caller switches the route and then deletes the source copy (`src.delete_group`)."""
    t0 = time.monotonic()
    await dst.setup()
    existing = await dst.scoped(group_id, "MATCH (n) WHERE n.group_id = $g RETURN count(n) AS c")
    if existing and existing[0]["c"]:
        raise MigrationError(f"target already holds {existing[0]['c']} nodes of this group; nothing was changed")
    nodes, rels = await export_group(src, group_id)
    before = digest(nodes, rels)
    try:
        await import_group(dst, group_id, nodes, rels)
        n2, r2 = await export_group(dst, group_id)
        after = digest(n2, r2)
        if after != before:
            raise MigrationError(f"verification failed: source {before} != target {after}")
    except BaseException:
        await dst.delete_group(group_id)
        raise
    return {"verified": True, "source": before, "target": after, "copy_ms": int((time.monotonic() - t0) * 1000)}
