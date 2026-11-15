"""Routing of each company to its graph store (isolation tiers).

- Standard tier: the shared Neo4j; the company is isolated by its group_id (scope.py enforces
  that every query is limited to it).
- Enterprise tier: a dedicated Neo4j container for that company alone (created and destroyed by
  scripts/zm-admin, on the internal Docker network, resource-limited, in the nightly backup).
  The company keeps its group_id there too, so the same scoped queries run unchanged.

The route is the company record (`companies.store_id`), read fresh on every request and every
ingest job, so a migration takes effect at once. Engines for dedicated stores are created on
first use (one Neo4j driver each) and share the LLM client and embedder with the shared engine.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

log = logging.getLogger("zen-memory.stores")


class StoreUnavailable(RuntimeError):
    pass


class GraphRouter:
    def __init__(self, shared, store=None, keys=None, factory: Callable[[str, str, str], Any] | None = None):
        self.shared = shared
        self.store = store
        self.keys = keys
        self.factory = factory  # (uri, user, password) -> MemoryEngine
        self.dedicated: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    # the shared engine's attributes (g, driver, ...) for code that predates routing
    def __getattr__(self, name):
        return getattr(self.shared, name)

    async def engine_for_store(self, store_id: str | None):
        if not store_id:
            return self.shared
        eng = self.dedicated.get(store_id)
        if eng is not None:
            return eng
        async with self._lock:
            eng = self.dedicated.get(store_id)
            if eng is not None:
                return eng
            if self.store is None or self.keys is None or self.factory is None:
                raise StoreUnavailable("dedicated stores are not configured")
            row = self.store.get_graph_store(store_id)
            if row is None:
                raise StoreUnavailable(f"graph store {store_id} is not registered")
            password = self.keys.get_secret(f"store:{store_id}")
            if password is None:
                raise StoreUnavailable(f"no credentials for graph store {store_id}")
            eng = self.factory(row["uri"], row["username"], password)
            await eng.setup()
            self.dedicated[store_id] = eng
            log.info("graph store %s connected (%s)", store_id, row["uri"])
            return eng

    async def engine_for(self, company: dict):
        return await self.engine_for_store(company.get("store_id"))

    async def forget_store(self, store_id: str) -> None:
        eng = self.dedicated.pop(store_id, None)
        if eng is not None:
            await eng.close()

    async def setup(self) -> None:
        await self.shared.setup()

    async def ping(self) -> bool:
        return await self.shared.ping()

    async def ping_dedicated(self) -> dict[str, bool]:
        out = {}
        for sid, eng in list(self.dedicated.items()):
            out[sid] = await eng.ping()
        return out

    async def close(self) -> None:
        for sid in list(self.dedicated):
            await self.forget_store(sid)
        await self.shared.close()
