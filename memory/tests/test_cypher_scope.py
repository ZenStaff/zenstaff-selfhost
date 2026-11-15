"""Defense in depth for tenant isolation (Standard tier, shared graph).

Static check over every module in app/ and eval/:
1. every string that looks like Cypher must pass scope.validate_cypher (limited to `$g`);
2. `.execute_query(` / `.session(` may only be called inside scope.scoped_query, or on a line
   marked `# zm-unscoped: <reason>` (health check, whole-store emptiness check).
A new query without the group scope therefore fails the test suite before it can ship.
Runtime check: scoped_query refuses an unscoped query and a caller-supplied `g`.
No database needed.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app.scope import ScopeViolation, looks_like_cypher, scoped_query, validate_cypher

ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted([*ROOT.glob("app/*.py"), *ROOT.glob("eval/*.py")])
DRIVER_CALLS = {"execute_query", "session"}


def _docstrings(tree: ast.AST) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def _text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "X" for v in node.values)
    return None


def check_source(src: str, name: str = "<src>") -> list[str]:
    """Problems found in one module's source (empty = fine)."""
    tree = ast.parse(src)
    lines = src.splitlines()
    docs = _docstrings(tree)
    problems = []

    def marked(lo: int, hi: int, marker: str) -> bool:
        return any(marker in lines[i - 1] for i in range(max(1, lo - 1), min(len(lines), hi) + 1))

    inside_fstring = {id(v) for n in ast.walk(tree) if isinstance(n, ast.JoinedStr) for v in n.values}
    for node in ast.walk(tree):
        if id(node) in docs or id(node) in inside_fstring:
            continue
        text = _text(node)
        if text is not None and looks_like_cypher(text):
            if marked(node.lineno, node.end_lineno or node.lineno, "zm-unscoped:"):
                continue
            try:
                validate_cypher(text)
            except ScopeViolation as e:
                problems.append(f"{name}:{node.lineno}: {e}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in DRIVER_CALLS:
            if not (marked(node.lineno, node.lineno, "zm-unscoped:") or (name.endswith("scope.py") and marked(node.lineno, node.lineno, "zm-scope"))):
                problems.append(f"{name}:{node.lineno}: direct driver call .{node.func.attr}() outside scope.scoped_query")
    return problems


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_every_query_is_company_scoped(path):
    assert check_source(path.read_text(), str(path.relative_to(ROOT))) == []


def test_the_checker_catches_violations():
    bad = '''
async def leak(driver, engine):
    await driver.execute_query("MATCH (n:Entity) RETURN n")
    await engine.scoped("g_x", "MATCH (n:Entity {uuid: $id}) RETURN n, $g")
    await engine.scoped("g_x", f"MATCH (s:Entity {{group_id: $g}})-[e:RELATES_TO]->(t:Entity) WHERE {1} RETURN t")
    await engine.scoped("g_x", "MATCH ()-[e:RELATES_TO {uuid: $u}]->() RETURN e, $g")
'''
    problems = check_source(bad)
    assert len(problems) == 5, problems
    assert any("direct driver call" in p for p in problems)


def test_marked_unscoped_lines_are_allowed():
    ok = '''
async def ping(driver):
    await driver.execute_query("RETURN 1")  # zm-unscoped: health check
'''
    assert check_source(ok) == []


class _Driver:
    def __init__(self):
        self.calls = []

    async def execute_query(self, cypher, **params):
        self.calls.append((cypher, params))
        return [], None, None


@pytest.mark.asyncio
async def test_scoped_query_sets_the_group_itself():
    d = _Driver()
    await scoped_query(d, "g_abc", "MATCH (n:Entity {group_id: $g}) RETURN n")
    assert d.calls[0][1] == {"g": "g_abc"}
    with pytest.raises(ScopeViolation):
        await scoped_query(d, "g_abc", "MATCH (n:Entity {group_id: $g}) RETURN n", g="g_other")
    with pytest.raises(ScopeViolation):
        await scoped_query(d, "g_abc", "MATCH (n:Entity) RETURN n")
    with pytest.raises(ScopeViolation):
        await scoped_query(d, "", "MATCH (n:Entity {group_id: $g}) RETURN n")
    assert len(d.calls) == 1


@pytest.mark.parametrize("q", [
    "MATCH (n:Entity {group_id: $g})-[e:RELATES_TO]-(m:Entity) RETURN m",
    "MATCH (n:Entity {group_id: $g}), (m:Episodic) RETURN m",
    "MATCH (a) WHERE a.group_id = $other RETURN a, $g",
    "MATCH (n:Entity {group_id: $g}) MATCH (x:Entity {uuid: $u}) DETACH DELETE x",
])
def test_validate_rejects(q):
    with pytest.raises(ScopeViolation):
        validate_cypher(q)
