"""Background ingest queue.

Episodes of one company are ingested strictly in order (Graphiti resolves contradictions against
what is already in the graph, so order matters); different companies run in parallel up to
INGEST_CONCURRENCY. Jobs survive restarts: queued/running rows are re-queued on boot.

Each job re-reads its company when it starts, so it writes to the graph store the company is
routed to at that moment (stores.GraphRouter) and with its current data key. Migrations and key
rotations hold the same per-company lock (`lock_for`), so they never overlap an ingest.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime

from .db import Store
from .engine import MemoryEngine
from .llm import UsageMeter, current_meter
from .quotas import QuotaExceeded

log = logging.getLogger("zen-memory.worker")


class IngestWorker:
    def __init__(self, store: Store, engine, model_name: str, concurrency: int, on_usage=None,
                 budget_for=None, keys=None):
        # engine: stores.GraphRouter (or a single MemoryEngine); keys: crypto.KeyStore | None
        self.keys = keys
        self.on_usage = on_usage
        # budget_for(company, episode) -> quotas.Budget | None: the token reservation of the job
        self.budget_for = budget_for
        self.store = store
        self.engine = engine
        self.model_name = model_name
        self.sem = asyncio.Semaphore(max(1, concurrency))
        self.locks: dict[str, asyncio.Lock] = {}
        self.tasks: set[asyncio.Task] = set()

    def lock_for(self, company_id: str) -> asyncio.Lock:
        return self.locks.setdefault(company_id, asyncio.Lock())

    async def _engine(self, company: dict) -> MemoryEngine:
        if hasattr(self.engine, "engine_for"):
            return await self.engine.engine_for(company)
        return self.engine

    @property
    def depth(self) -> int:
        return len(self.tasks)

    def enqueue(self, company: dict, episode: dict) -> None:
        task = asyncio.create_task(self._run(company, episode))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def resume(self) -> int:
        n = 0
        for ep in self.store.pending_episodes():
            company = self.store.get_company(ep["company_id"])
            if company and ep.get("summary"):
                self.enqueue(company, ep)
                n += 1
        return n

    def retry_deferred(self, reserve, now: float | None = None) -> int:
        """Re-queue episodes deferred by the monthly token quota, oldest first, while it has room.

        reserve(company, episode) -> reservation id, or raises QuotaExceeded. A company whose quota
        is still full is skipped until it resets (its later episodes wait behind the first one, so
        they stay in order)."""
        now = time.time() if now is None else now
        full: dict[str, float] = {}
        n = 0
        for ep in self.store.deferred_episodes(now):
            cid = ep["company_id"]
            if cid in full:
                self.store.postpone_deferred(ep["id"], full[cid])
                continue
            company = self.store.get_company(cid)
            if company is None:
                continue
            try:
                rid = reserve(company, ep)
            except QuotaExceeded as e:
                # try again after a few minutes (the limit can be raised), at the latest at the reset
                full[cid] = min(e.resets_at.timestamp(), now + 600)
                self.store.postpone_deferred(ep["id"], full[cid])
                continue
            if self.store.requeue_deferred(ep["id"], rid):
                ep = {**ep, "status": "queued"}
                self.enqueue(company, ep)
                n += 1
        if n:
            log.info("re-queued %d episodes deferred by the token quota", n)
        return n

    async def drain(self, timeout: float = 600) -> None:
        if self.tasks:
            await asyncio.wait(list(self.tasks), timeout=timeout)

    # Neo4j is briefly offline every night for the backup dump (and on restarts). Nothing is
    # written before Graphiti's final save, so retrying the whole episode is safe.
    RETRY_DELAYS = (10, 20, 40, 60, 90, 120)

    async def _ingest_with_retry(self, company: dict, ep: dict, src: dict, desc: str) -> str:
        from neo4j.exceptions import ServiceUnavailable, SessionExpired

        cipher = self.keys.cipher(company["id"]) if self.keys is not None else None
        for attempt, delay in enumerate((*self.RETRY_DELAYS, None)):
            try:
                engine = await self._engine(company)
                kw = {"cipher": cipher} if cipher is not None else {}
                return await engine.ingest(
                    group_id=ep.get("group_id") or company["group_id"],
                    name=src.get("title") or f"thread {src.get('thread_id')}",
                    body=ep["summary"],
                    reference_time=datetime.fromisoformat(ep["reference_time"]),
                    source_description=desc,
                    **kw,
                )
            except (ServiceUnavailable, SessionExpired, ConnectionError, OSError) as e:
                if delay is None:
                    raise
                log.warning("graph unavailable for %s (%s); retry %d in %ds", ep["id"], type(e).__name__, attempt + 1, delay)
                await asyncio.sleep(delay)
        raise RuntimeError("unreachable")

    async def _run(self, company: dict, ep: dict) -> None:
        lock = self.lock_for(company["id"])
        async with lock, self.sem:
            fresh = self.store.get_company(company["id"])
            if fresh is None:  # deleted while queued
                return
            company = fresh
            meter = UsageMeter()
            token = current_meter.set(meter)
            self.store.mark_running(ep["id"])
            t0 = time.monotonic()
            try:
                import json

                if self.budget_for is not None:
                    meter.budget = self.budget_for(company, ep)

                src = json.loads(ep["source_json"])
                desc = "Zen Staff conversation summary; thread {t}; user {u}; machine {m}".format(
                    t=src.get("thread_id"), u=src.get("user") or "-", m=src.get("machine") or "-"
                )
                untrusted = ep.get("trust") == "untrusted"
                group = ep.get("group_id") or company["group_id"]
                before = await (await self._engine(company)).trust_snapshot(group) if untrusted else None
                graph_uuid = await self._ingest_with_retry(company, ep, src, desc)
                if untrusted:
                    # an e-mail, web page or tool output: only observations, and no change to earlier facts
                    res = await (await self._engine(company)).untrusted_guard(group, graph_uuid, before or {})
                    log.info("untrusted episode %s: %d observations, %d earlier facts restored", ep["id"],
                             res["observations"], res["restored"])
                self.store.mark_done(ep["id"], graph_uuid)
                log.info(
                    "ingested %s for %s in %.1fs: %d calls, %d in / %d out tokens",
                    ep["id"], company["id"], time.monotonic() - t0, meter.calls, meter.input_tokens, meter.output_tokens,
                )
            except QuotaExceeded as e:
                # Nothing was saved (Graphiti writes at the end). Keep the summary: retry_deferred
                # re-queues it when the month resets or the limit is raised.
                log.warning("ingest of %s deferred: monthly token quota of %s used up", ep["id"], company["id"])
                self.store.mark_deferred(ep["id"], "quota_exceeded: " + e.body()["message"], time.time())
            except Exception as e:
                log.exception("ingest failed for %s", ep["id"])
                self.store.mark_failed(ep["id"], f"{type(e).__name__}: {e}")
            finally:
                current_meter.reset(token)
                # real usage in, reservation out (one transaction): success and failure alike
                self.store.record_usage(
                    company["id"], ep["id"], "extract", self.model_name, meter.calls, meter.input_tokens, meter.output_tokens,
                    meter.cache_write_tokens, meter.cache_read_tokens, round(meter.cost_usd, 8),
                    reservation=meter.budget.reservation if meter.budget is not None else None,
                )
                if self.on_usage is not None:
                    try:
                        self.on_usage(company)
                    except Exception:
                        log.exception("usage hook failed")
