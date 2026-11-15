"""Test harness: real Neo4j (throwaway containers, see scripts/test.sh), fake LLM, fake embedder.

NEO4J_URI is the shared graph; NEO4J_URI_2 (optional) is a second Neo4j that plays a dedicated
Enterprise store. Encryption is on (random master key per test) unless a test turns it off.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import replace
from datetime import datetime, timezone

import httpx
import pytest_asyncio
from graphiti_core import Graphiti
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge, EpisodicEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode

from app.audit import AuditLog
from app.config import Settings
from app.crypto import KeyStore, MasterKeys, new_master_key
from app.db import Store
from app.embedder import FakeEmbedder, NoRerank
from app.engine import MemoryEngine, ZenBase
from app.llm import FakeLLM
from app.main import create_app
from app.stores import GraphRouter

STORE2_URI = os.environ.get("NEO4J_URI_2", "")

ADMIN = "test-admin-token"


def dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


class Seeder:
    """Writes graph objects directly (no LLM), the way Graphiti would after extraction."""

    def __init__(self, graphiti: Graphiti, store: Store):
        self.g = graphiti
        self.store = store

    async def episode(self, company: dict, text: str, thread: str, when: str) -> EpisodicNode:
        ep = EpisodicNode(
            name=thread,
            group_id=company["group_id"],
            source=EpisodeType.text,
            source_description="test",
            content=text,
            valid_at=dt(when),
            created_at=dt(when),
        )
        await ep.save(self.g.driver)
        row = self.store.insert_episode(company["id"], f"seed-{uuid.uuid4().hex}", "queued", None, {"thread_id": thread, "user": "test"}, dt(when).isoformat(), text)
        self.store.mark_done(row["id"], ep.uuid)
        return ep

    async def entity(self, company: dict, name: str, label: str, mentioned_in: EpisodicNode | None = None) -> EntityNode:
        n = EntityNode(name=name, group_id=company["group_id"], labels=["Entity", label], summary=f"{name} ({label})", created_at=dt("2026-01-01"))
        await n.generate_name_embedding(self.g.embedder)
        await n.save(self.g.driver)
        if mentioned_in is not None:
            e = EpisodicEdge(source_node_uuid=mentioned_in.uuid, target_node_uuid=n.uuid, group_id=company["group_id"], created_at=dt("2026-01-01"))
            await e.save(self.g.driver)
        return n

    async def fact(self, company: dict, src: EntityNode, dst: EntityNode, name: str, fact: str, ep: EpisodicNode,
                   valid_at: str, invalid_at: str | None = None, **attrs) -> EntityEdge:
        e = EntityEdge(
            group_id=company["group_id"], source_node_uuid=src.uuid, target_node_uuid=dst.uuid, name=name, fact=fact,
            episodes=[ep.uuid], created_at=dt(valid_at), valid_at=dt(valid_at),
            invalid_at=dt(invalid_at) if invalid_at else None, expired_at=dt(invalid_at) if invalid_at else None,
            attributes=attrs,
        )
        await e.generate_embedding(self.g.embedder)
        await e.save(self.g.driver)
        return e


@pytest_asyncio.fixture
async def env(tmp_path):
    cfg = replace(
        Settings(),
        tenancy="multi",
        admin_token=ADMIN,
        data_dir=str(tmp_path),
        llm_provider="fake",
        embedder_provider="fake",
        novelty_gate=True,
        quota_ingest_estimate_tokens=0,  # reservation = 6x the summary's tokens + 700 (tests set their own sizes)
    )
    driver = Neo4jDriver(os.environ.get("NEO4J_URI", "bolt://localhost:7687"), "neo4j", os.environ["NEO4J_PASSWORD"])
    llm = FakeLLM()
    embedder = FakeEmbedder(1024)
    graphiti = ZenBase(graph_driver=driver, llm_client=llm, embedder=embedder, cross_encoder=NoRerank())
    engine = MemoryEngine(graphiti)

    def factory(uri: str, user: str, password: str) -> MemoryEngine:
        g = ZenBase(graph_driver=Neo4jDriver(uri, user, password), llm_client=llm, embedder=embedder, cross_encoder=NoRerank())
        return MemoryEngine(g)

    keys = KeyStore(str(tmp_path / "keys.sqlite3"), MasterKeys("t1:" + new_master_key()))
    store = Store(cfg.db_path, keys)
    router = GraphRouter(engine, store, keys, factory)
    audit = AuditLog(str(tmp_path / "audit.sqlite3"))
    app = create_app(store, router, llm, cfg, keys=keys, audit=audit)
    groups: set[str] = set()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, client=("203.0.113.7", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            env = Env(app, client, store, engine, Seeder(graphiti, store), keys=keys, audit=audit, router=router,
                      groups=groups)
            yield env
            for c in store.list_companies():
                groups.add(c["group_id"])
                for z in store.zones_of(c["id"], include_archived=True):
                    groups.add(z["group_id"])
            for g in groups:
                await engine.delete_group(g)
                if STORE2_URI:
                    e2 = await env.store2_engine()
                    await e2.delete_group(g)
            await env.close_extra()


class Env:
    def __init__(self, app, client: httpx.AsyncClient, store: Store, engine: MemoryEngine, seed: Seeder, *, keys=None,
                 audit=None, router=None, groups=None):
        self.app, self.client, self.store, self.engine, self.seed = app, client, store, engine, seed
        self.keys, self.audit, self.router, self.groups = keys, audit, router, groups if groups is not None else set()
        self._e2 = None

    async def raw(self, cypher: str, **params) -> list[dict]:
        """Unscoped read of the shared graph, for assertions only."""
        records, _, _ = await self.engine.driver.execute_query(cypher, **params)
        return [dict(r) for r in records]

    async def store2_engine(self) -> MemoryEngine:
        if self._e2 is None:
            self._e2 = self.router.factory(STORE2_URI, "neo4j", os.environ["NEO4J_PASSWORD"])
            await self._e2.setup()
        return self._e2

    async def close_extra(self) -> None:
        if self._e2 is not None:
            await self._e2.close()

    async def register_store2(self, company: dict, store_id: str = "st_test01") -> dict:
        r = await self.client.post("/admin/stores", headers={"Authorization": f"Bearer {ADMIN}"}, json={
            "store_id": store_id, "company_id": company["id"], "uri": STORE2_URI, "username": "neo4j",
            "password": os.environ["NEO4J_PASSWORD"], "container": "test-store2"})
        assert r.status_code == 201, r.text
        return r.json()

    async def company(self, name: str) -> tuple[dict, dict]:
        r = await self.client.post("/admin/companies", json={"name": name}, headers={"Authorization": f"Bearer {ADMIN}"})
        assert r.status_code == 201, r.text
        body = r.json()
        return self.store.get_company(body["company_id"]), {"Authorization": f"Bearer {body['api_key']}"}
