"""Company-scoped graph access: the only door to Cypher in our code.

Every query our code sends to a graph store goes through `scoped_query(driver, group_id, ...)`.
It refuses a query unless the company's group is bound in it, and it sets the `$g` parameter
itself, so a caller cannot pass another group's id. `validate_cypher` is the rule, also run by
the static check in tests/test_cypher_scope.py over every Cypher string in app/ and eval/:

- the query must use `$g`;
- every node pattern with a label, `(n:Entity ...)`, must be scoped: `{group_id: $g}` in its
  properties, or `n.group_id = $g` elsewhere in the query, or `n` bound by another scoped pattern;
- an unlabeled named node `(n)` must be scoped the same way, or touch a scoped relationship;
- every relationship pattern `-[e:RELATES_TO ...]-` must be scoped or touch a scoped node;
- an anonymous node `()` must touch a scoped relationship or node.

Graphiti's own queries (add_episode, search_) are not ours: they get the group through their
`group_id` / `group_ids` arguments, and our results are filtered by group a second time.
Enterprise companies additionally live in their own graph store (`stores.py`), so the database
they are in holds nothing else.
"""

from __future__ import annotations

import re
from typing import Any


class ScopeViolation(RuntimeError):
    """A Cypher query that is not provably limited to one company's group."""


_NODE = re.compile(r"(?<![\w.$`])\(\s*(?P<var>[A-Za-z_]\w*)?\s*(?P<labels>(?::\s*`?\w+`?\s*(?:[|&]\s*`?\w+`?\s*)*)*)\s*(?P<props>\{[^{}]*\})?\s*\)")
_REL = re.compile(r"<?-\[\s*(?P<var>[A-Za-z_]\w*)?\s*(?P<types>:\s*`?\w+`?(?:\s*\|\s*`?\w+`?)*)?\s*(?P<props>\{[^{}]*\})?\s*\]->?")
_SCOPED_PROPS = re.compile(r"\bgroup_id\s*:\s*\$g\b")


def looks_like_cypher(text: str) -> bool:
    return bool(re.search(r"\b(MATCH|MERGE)\s*\(|\bCREATE\s*\(|\bUNWIND\b", text))


def _var_scoped_by_where(q: str, var: str) -> bool:
    return bool(re.search(rf"(?<![\w.]){re.escape(var)}\.group_id\s*=\s*\$g\b", q))


def validate_cypher(q: str) -> None:
    """Raise ScopeViolation unless every pattern in `q` is limited to the group `$g`."""
    if not re.search(r"\$g\b", q):
        raise ScopeViolation("query does not use $g (the company's group)")
    # mask strings so patterns inside literals are ignored
    masked = re.sub(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"", "''", q)
    nodes = []
    for m in _NODE.finditer(masked):
        start = m.start()
        before = masked[:start].rstrip()
        if before.endswith("CALL") or before.upper().endswith("CALL"):
            continue  # CALL () { ... } subquery, not a node
        var, labels, props = m.group("var"), (m.group("labels") or "").strip(), m.group("props") or ""
        if var is None and not labels and not props:
            text_inside = m.group(0)[1:-1].strip()
            if text_inside:
                continue
        nodes.append({"span": (m.start(), m.end()), "var": var, "labels": labels, "scoped": bool(_SCOPED_PROPS.search(props))})
    rels = []
    for m in _REL.finditer(masked):
        rels.append({"span": (m.start(), m.end()), "var": m.group("var"), "types": m.group("types") or "",
                     "scoped": bool(_SCOPED_PROPS.search(m.group("props") or ""))})
    scoped_vars = {n["var"] for n in nodes if n["var"] and n["scoped"]}
    scoped_vars |= {r["var"] for r in rels if r["var"] and r["scoped"]}
    for n in nodes:
        if n["var"] and not n["scoped"] and (n["var"] in scoped_vars or _var_scoped_by_where(masked, n["var"])):
            n["scoped"] = True
    for r in rels:
        if r["var"] and not r["scoped"] and _var_scoped_by_where(masked, r["var"]):
            r["scoped"] = True

    def touching(rel: dict) -> list[dict]:
        rs, re_ = rel["span"]
        return [n for n in nodes if n["span"][1] == rs or n["span"][0] == re_]

    def rels_touching(node: dict) -> list[dict]:
        ns, ne = node["span"]
        return [r for r in rels if r["span"][0] == ne or r["span"][1] == ns]

    for r in rels:
        if not r["scoped"]:
            if not any(n["scoped"] for n in touching(r)):
                raise ScopeViolation(f"relationship {masked[r['span'][0]:r['span'][1]]!r} is not limited to $g")
            r["anchored"] = True  # reached only through a scoped node
    for n in nodes:
        if n["scoped"]:
            continue
        frag = masked[n["span"][0]:n["span"][1]]
        if n["labels"]:
            raise ScopeViolation(f"node {frag!r} has a label but no group_id: $g")
        if not any(r["scoped"] or r.get("anchored") for r in rels_touching(n)):
            raise ScopeViolation(f"node {frag!r} is not limited to $g")


async def scoped_query(driver: Any, group_id: str, cypher: str, **params: Any) -> list[dict]:
    """Run `cypher` limited to `group_id`. The caller may not pass `g`: it is set here."""
    if not group_id or not isinstance(group_id, str):
        raise ScopeViolation("missing group_id")
    if "g" in params:
        raise ScopeViolation("pass the group as group_id, not as a query parameter")
    validate_cypher(cypher)
    records, _, _ = await driver.execute_query(cypher, g=group_id, **params)  # zm-scope: the one door
    return [dict(r) for r in records]


def only_group(items: list, group_id: str) -> list:
    """Second filter on objects Graphiti returns (nodes/edges with a .group_id)."""
    return [x for x in items if getattr(x, "group_id", None) == group_id]
