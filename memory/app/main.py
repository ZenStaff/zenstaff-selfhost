"""zen-memory HTTP API (v1).

Isolation rule: the company, and therefore the Graphiti group_id, comes ONLY from the API key
in the Authorization header. No endpoint accepts a group_id or company id from a company caller.
The company record also decides WHERE its graph lives (stores.GraphRouter: shared Neo4j for the
Standard tier, a dedicated Neo4j for Enterprise) and holds its data key (crypto.KeyStore).
Every call is written to the hash-chained audit log (audit.py).
"""


import asyncio
import hashlib
import logging
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

import json
from contextvars import ContextVar

from . import access, classify
from .audit import AuditLog, client_ip, parse_networks
from .config import Settings, settings as default_settings
from .crypto import KeyStore, MasterKeys
from .db import Store
from .engine import MemoryEngine
from .gate import novelty_check
from .llm import UsageMeter, current_meter, estimate_tokens
from .migrate import MigrationError, copy_group
from .quotas import Quotas, QuotaExceeded
from .stores import GraphRouter, StoreUnavailable
from .worker import IngestWorker

log = logging.getLogger("zen-memory")

# the starter's personal space during one request (classify needs to know if there is one)
request_person: ContextVar[dict | None] = ContextVar("request_person", default=None)


# ---- request / response models ---------------------------------------------------------------


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceIn(Strict):
    thread_id: str = Field(min_length=1, max_length=200)
    timestamp: datetime = Field(description="When the conversation finished (ISO 8601).")
    user: str | None = Field(None, max_length=200)
    machine: str | None = Field(None, max_length=200)
    app: str | None = Field("zen-staff", max_length=100)
    project: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=300)

    @field_validator("timestamp")
    @classmethod
    def _tz(cls, v: datetime) -> datetime:
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


class EpisodeIn(Strict):
    summary: str = Field(min_length=1, description="One summary of the finished conversation.")
    source: SourceIn
    idempotency_key: str | None = Field(None, max_length=200)
    # v4: the zone of the chat's project ("company", "team:<id>", "project:<id>"); default company
    zone: str | None = Field(None, max_length=120, pattern=r"^(company|personal|team:[A-Za-z0-9_.:-]{1,100}|project:[A-Za-z0-9_.:-]{1,100})$")


class FactCorrectionIn(Strict):
    fact: str = Field(min_length=3, max_length=2000)


class ForgetPersonIn(Strict):
    name: str = Field(min_length=2, max_length=200)


class PromoteIn(Strict):
    consent: Literal[True] = Field(description="The person agreed to send this item to the company.")
    zone: str | None = Field(None, max_length=120)
    user: str | None = Field(None, max_length=200)


class PersonIn(Strict):
    user_ref: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:@-]+$")


class ZoneIn(Strict):
    ref: str = Field(pattern=r"^(team|project):[A-Za-z0-9_.:-]{1,100}$")
    kind: Literal["team", "project"]
    name: str = Field(min_length=1, max_length=200)
    parent_ref: str | None = Field(None, max_length=120)


class MemberIn(Strict):
    user_ref: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:@-]+$")
    admin: bool = False
    company: bool = False
    zones: list[str] = Field(default_factory=list, max_length=2000)


class AccessIn(Strict):
    """The hub's view of a company: departments and projects, who reads what, the memory rules."""

    zones: list[ZoneIn] = Field(default_factory=list, max_length=2000)
    members: list[MemberIn] = Field(default_factory=list, max_length=5000)
    auto_promote_decisions: bool | None = None
    sensitive_policy: Literal["personal", "drop"] | None = None
    rule_set_by: str | None = Field(None, max_length=120)


class CompanyIn(Strict):
    name: str = Field(min_length=1, max_length=200)


class LimitsIn(Strict):
    """Per-company overrides. A field set to null goes back to the default; 0 = unlimited."""

    episodes_per_day: int | None = Field(None, ge=0, le=10_000_000)
    ingest_tokens_per_month: int | None = Field(None, ge=0, le=100_000_000_000)
    searches_per_minute: int | None = Field(None, ge=0, le=1_000_000)


class StoreIn(Strict):
    """A dedicated graph store created by scripts/zm-admin, registered for one company."""

    store_id: str = Field(pattern=r"^st_[a-z0-9]{6,32}$")
    company_id: str = Field(min_length=1, max_length=64)
    uri: str = Field(pattern=r"^bolt://[A-Za-z0-9_.-]+:[0-9]{2,5}$")
    username: str = Field("neo4j", min_length=1, max_length=64)
    password: str = Field(min_length=16, max_length=200)
    container: str | None = Field(None, max_length=200)


class MigrateIn(Strict):
    to: Literal["dedicated", "shared"]
    store_id: str | None = Field(None, pattern=r"^st_[a-z0-9]{6,32}$")


def quota_response(e: QuotaExceeded) -> JSONResponse:
    body = e.body()
    return JSONResponse(body, status_code=429, headers={"Retry-After": str(body["retry_after_seconds"])})


# ---- app factory -----------------------------------------------------------------------------


def create_app(store: Store, engine: MemoryEngine | GraphRouter, llm: Any, cfg: Settings = default_settings,
               keys: KeyStore | None = None, audit: AuditLog | None = None) -> FastAPI:
    keys = keys or store.keys or KeyStore(cfg.keys_path, MasterKeys.from_env())
    if store.keys is None:
        store.keys = keys
    if cfg.encryption == "required" and not keys.enabled:
        raise RuntimeError("ENCRYPTION=required but ZM_MASTER_KEYS is not set")
    router = engine if isinstance(engine, GraphRouter) else GraphRouter(engine, store, keys)
    if router.store is None:
        router.store, router.keys = store, keys
    audit = audit or AuditLog(cfg.audit_path, cfg.audit_anchor_every)
    trusted_proxies = parse_networks(cfg.audit_trusted_proxies)
    quotas = Quotas(
        store,
        {
            "episodes_per_day": cfg.quota_episodes_per_day,
            "ingest_tokens_per_month": cfg.quota_ingest_tokens_per_month,
            "searches_per_minute": cfg.quota_searches_per_minute,
        },
        cfg.quota_alert_webhook_url,
        webhook_format=cfg.quota_alert_webhook_format,
        person_defaults={
            "episodes_per_day": cfg.quota_person_episodes_per_day,
            "ingest_tokens_per_month": cfg.quota_person_ingest_tokens_per_month,
            "searches_per_minute": cfg.quota_person_searches_per_minute,
        },
    )

    def ingest_estimate(summary: str) -> int:
        return cfg.quota_ingest_estimate_tokens + 5 * estimate_tokens(summary)

    def gate_estimate(summary: str) -> int:
        return estimate_tokens(summary) + 700  # gate prompt ~450 tokens + at most 200 out

    ESSENTIAL_KINDS = {"decision", "promise", "price", "change"}

    def budget_filter(space: dict, gate):
        """Budget mode (QUOTA_ESSENTIAL_ONLY_PERCENT): late in a heavy month, keep only the summaries
        with a decision, promise, price or change; a plain fact waits for nobody (skipped)."""
        pct = app.state.essential_only_percent
        if not gate.ingest or pct <= 0 or ESSENTIAL_KINDS & set(gate.kinds or []):
            return gate
        if quotas.month_fraction_used(space["id"]) * 100 < pct:
            return gate
        from .gate import GateResult

        return GateResult(False, f"budget mode: past {pct}% of the monthly quota only decisions, promises, prices "
                                 "and changes are kept", gate.kinds, gate.used_llm)

    def budget_for(company: dict, ep: dict):
        res = store.reservation_for_episode(ep["id"])
        if res is not None:
            return quotas.budget(company["id"], res["id"], res["tokens"])
        # an episode queued before reservations existed, or whose reservation expired
        est = ingest_estimate(ep.get("summary") or "")
        rid = quotas.reserve_tokens(company["id"], est)
        return quotas.budget(company["id"], rid, est)

    worker = IngestWorker(store, router, llm.model_name, cfg.ingest_concurrency, on_usage=quotas.after_usage,
                          budget_for=budget_for, keys=keys)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        n_keys = keys.check_all()  # refuse to start if a master key needed by a stored key is missing
        log.info("encryption %s (%d wrapped keys readable)", "on" if keys.enabled else "OFF", n_keys)
        head = audit.head()
        log.info("audit anchor seq=%d hash=%s", head["seq"], head["hash"])
        await router.setup()
        if cfg.tenancy == "single" and not store.list_companies("company"):
            if not cfg.single_tenant_api_key:
                raise RuntimeError("TENANCY=single needs SINGLE_TENANT_API_KEY")
            store.create_company(cfg.single_tenant_name, cfg.single_tenant_api_key)
            log.info("single-tenant company created")
        resumed = worker.resume()
        if resumed:
            log.info("re-queued %d unfinished episodes", resumed)

        async def deferred_loop():
            while True:
                try:
                    app.state.retry_deferred()
                except Exception:
                    log.exception("retry of quota-deferred episodes failed")
                await asyncio.sleep(max(30, cfg.quota_retry_interval_s))

        retry_task = asyncio.create_task(deferred_loop())
        yield
        retry_task.cancel()
        await worker.drain(timeout=30)
        await quotas.drain()
        await router.close()

    app = FastAPI(title="zen-memory", version="1.0.0", lifespan=lifespan)
    app.state.worker = worker

    def reserve_deferred(company: dict, ep: dict) -> str:
        return quotas.reserve_tokens(company["id"], ingest_estimate(ep.get("summary") or ""))

    # re-queue the episodes deferred by the monthly token quota that fit now (lifespan runs it
    # every QUOTA_RETRY_INTERVAL_S; tests call it directly)
    app.state.retry_deferred = lambda now=None: worker.retry_deferred(reserve_deferred, now)
    app.state.essential_only_percent = cfg.quota_essential_only_percent
    app.state.store = store
    app.state.quotas = quotas
    app.state.keys = keys
    app.state.audit = audit
    app.state.router = router

    # ---- audit log -------------------------------------------------------------------------

    @app.middleware("http")
    async def audit_calls(request: Request, call_next):
        if request.url.path == "/healthz":  # container health checks, every 15 s
            return await call_next(request)
        request.state.audit_ctx = {"auth": "none", "company_id": None, "key_id": None, "subject_id": None}
        rid = uuid.uuid4().hex
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-Id"] = rid
            return response
        finally:
            ctx = request.state.audit_ctx
            route = request.scope.get("route")
            try:
                audit.append(
                    company_id=ctx["company_id"], key_id=ctx["key_id"], auth=ctx["auth"],
                    action=getattr(route, "name", None) or "unmatched", method=request.method,
                    route=getattr(route, "path", None) or "<unmatched>", status=status,
                    ip=client_ip(request.scope.get("client"), {k.decode().lower(): v.decode() for k, v in request.scope.get("headers", [])},
                                 trusted_proxies),
                    request_id=rid, subject_id=ctx.get("subject_id"),
                )
            except Exception:
                log.exception("AUDIT WRITE FAILED for %s %s", request.method, request.url.path)

    # ---- auth ------------------------------------------------------------------------------

    def _bearer(authorization: str | None) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer token")
        return authorization[7:].strip()

    def _ctx(request: Request, **kw) -> None:
        ctx = getattr(request.state, "audit_ctx", None)
        if ctx is not None:
            ctx.update(kw)

    def company_auth(request: Request, authorization: Annotated[str | None, Header()] = None) -> dict:
        try:
            company = store.company_for_key(_bearer(authorization))
        except HTTPException:
            _ctx(request, auth="none")
            raise
        if company is None:
            _ctx(request, auth="invalid")
            raise HTTPException(401, "invalid API key")
        _ctx(request, auth="company", company_id=company["id"], key_id=company.get("key_id"))
        return company

    def admin_auth(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
        if not cfg.admin_token:
            raise HTTPException(403, "admin API disabled (ADMIN_TOKEN not set)")
        if not secrets.compare_digest(_bearer(authorization), cfg.admin_token):
            _ctx(request, auth="invalid")
            raise HTTPException(401, "invalid admin token")
        _ctx(request, auth="admin", key_id="admin-token")
        cid = request.path_params.get("company_id")
        if cid:
            _ctx(request, company_id=cid)

    Company = Annotated[dict, Depends(company_auth)]
    Admin = Depends(admin_auth)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.exception("unhandled error on %s", request.url.path)
        return JSONResponse({"detail": "internal error"}, status_code=500)

    # ---- health ----------------------------------------------------------------------------

    @app.get("/healthz")
    async def healthz():
        neo4j_ok = await router.ping()
        emb_ok = await router.shared.g.embedder.ping() if hasattr(router.shared.g.embedder, "ping") else True
        ok = neo4j_ok and emb_ok
        return JSONResponse(
            {
                "status": "ok" if ok else "degraded",
                "neo4j": neo4j_ok,
                "embedder": emb_ok,
                "embedder_provider": cfg.embedder_provider,
                "llm": llm.model_name,
                "tenancy": cfg.tenancy,
                "encryption": keys.enabled,
                "dedicated_stores": len(router.dedicated),
                "queue_depth": worker.depth,
            },
            status_code=200 if ok else 503,
        )

    # ---- company API -----------------------------------------------------------------------

    @app.get("/v1/me")
    async def me(company: Company):
        st = quotas.status(company["id"])
        st.pop("alerts", None)
        return {
            "company_id": company["id"],
            "name": company["name"],
            "kind": company.get("kind") or "company",
            "zones": [{"ref": z["ref"], "kind": z["kind"], "name": z["name"]} for z in access.visible_zones(store, company)],
            "bound_to_user": bool(company.get("key_user_ref")) if company.get("kind") != "person" else True,
            "tier": company.get("tier") or "standard",
            "graph": await (await router.engine_for(company)).counts(company["group_id"]),
            "quotas": st,
        }

    async def _ingest_part(space: dict, text: str, source: dict, key: str, reference_time: str, *,
                           group_id: str | None = None, zone_ref: str | None = None, trust: str = "trusted",
                           origin_company_id: str | None = None, force: bool = False) -> tuple[dict, int]:
        """Gate + store + queue one text for one space (company or person). Returns (payload, http status)."""
        existing = store.find_episode(space["id"], key)
        if existing:
            return {"episode_id": existing["id"], "status": "duplicate", "reason": f"already received ({existing['status']})"}, 200
        g_est, i_est = gate_estimate(text), ingest_estimate(text)
        try:
            quotas.check_ingest(space["id"])
            reservation = quotas.reserve_tokens(space["id"], (0 if force else g_est) + i_est)
        except QuotaExceeded as e:
            return {"status": "quota_exceeded", **e.body()}, 429
        meter = UsageMeter(budget=quotas.budget(space["id"], reservation, g_est + i_est))
        token = current_meter.set(meter)
        t0 = time.monotonic()
        try:
            if force:
                from .gate import GateResult

                gate = GateResult(True, "confirmed by a person", [], False)
            else:
                gate = await novelty_check(llm, text)
                gate = budget_filter(space, gate)
        except BaseException:
            store.release_reservation(reservation)
            raise
        finally:
            current_meter.reset(token)
        gate_ms = int((time.monotonic() - t0) * 1000)
        src = {**source, "trust": trust, "zone": zone_ref or ("personal" if space.get("kind") == "person" else "company")}
        ep = store.insert_episode(space["id"], key, "queued" if gate.ingest else "skipped", gate.reason, src, reference_time,
                                  text if gate.ingest else None, origin_company_id=origin_company_id,
                                  group_id=group_id if group_id and group_id != space["group_id"] else None,
                                  zone_ref=zone_ref, trust=trust)
        store.record_usage(space["id"], ep["id"], "gate", llm.model_name, meter.calls, meter.input_tokens, meter.output_tokens,
                           meter.cache_write_tokens, meter.cache_read_tokens, round(meter.cost_usd, 8),
                           reservation=reservation, keep_reserved=i_est if gate.ingest else 0)
        quotas.after_usage(space)
        payload = {
            "episode_id": ep["id"],
            "status": "accepted" if gate.ingest else "skipped",
            "reason": gate.reason,
            "kinds": gate.kinds,
            "gate": {"used_llm": gate.used_llm, "ms": gate_ms, "input_tokens": meter.input_tokens, "output_tokens": meter.output_tokens},
        }
        if gate.ingest:
            worker.enqueue(space, ep)
            return payload, 202
        return payload, 200

    async def _route_summary(space: dict, summary: str) -> tuple[classify.Split, dict]:
        """The classifier step, billed to the calling space."""
        person = request_person.get()
        zone_kind = "person" if space.get("kind") == "person" else "zone"
        use_llm = (cfg.personal_split and len(summary) >= cfg.min_summary_chars
                   and (zone_kind == "person" or classify.needs_llm(summary, person is not None)))
        meter = UsageMeter()
        token = current_meter.set(meter)
        t0 = time.monotonic()
        try:
            split = await classify.route(
                llm, summary, zone_kind=zone_kind, has_personal=person is not None,
                auto_promote_decisions=bool(space.get("auto_promote_decisions")),
                sensitive_policy=space.get("sensitive_policy") or "personal", use_llm=use_llm,
            )
        finally:
            current_meter.reset(token)
        if meter.calls:
            store.record_usage(space["id"], None, "split", llm.model_name, meter.calls, meter.input_tokens, meter.output_tokens,
                               meter.cache_write_tokens, meter.cache_read_tokens, round(meter.cost_usd, 8))
        return split, {"used_llm": bool(meter.calls), "ms": int((time.monotonic() - t0) * 1000),
                       "input_tokens": meter.input_tokens, "output_tokens": meter.output_tokens}

    @app.post("/v1/episodes")
    async def post_episode(body: EpisodeIn, request: Request, company: Company,
                           x_zen_personal_key: Annotated[str | None, Header()] = None):
        """One finished conversation. Sorted first (classify.py): the chat's zone gets the trusted
        facts, external content becomes observations, rules wait for a person's confirmation,
        personal preferences (and sensitive data, by the company's policy) go to the starter's
        personal memory when X-Zen-Personal-Key is sent, identifiers are masked everywhere."""
        space = company
        summary = body.summary.strip()
        if len(summary) > cfg.max_summary_chars:
            raise HTTPException(413, f"summary longer than {cfg.max_summary_chars} characters; send one summary, not the transcript")
        person = access.personal_for(store, space, x_zen_personal_key)
        zone = access.writable_zone(store, space, body.zone)
        if person is not None:
            _ctx(request, subject_id=person["id"])
        key = body.idempotency_key or hashlib.sha256(f"{body.source.thread_id}\n{summary}".encode()).hexdigest()[:40]
        if zone["ref"] not in (access.COMPANY, access.PERSONAL):
            key = f"{key}@{zone['ref']}"[:200]
        prior = store.find_split(space["id"], key)
        if prior is not None:
            res = json.loads(prior["result_json"])
            return JSONResponse({**res, "status": "duplicate", "reason": "already received"}, status_code=200)
        existing = store.find_episode(space["id"], key)
        if existing:  # sent before v4 (no split record)
            return JSONResponse({"episode_id": existing["id"], "status": "duplicate", "reason": f"already received ({existing['status']})"},
                                status_code=200)
        try:
            quotas.check_ingest(space["id"])
        except QuotaExceeded as e:
            return quota_response(e)
        tok = request_person.set(person)
        try:
            split, split_info = await _route_summary(space, summary)
        finally:
            request_person.reset(tok)
        source = body.source.model_dump(mode="json")
        ref_time = body.source.timestamp.isoformat()
        user_ref = space.get("key_user_ref") or (space.get("owner_ref") if space.get("kind") == "person" else None)
        parts: dict[str, Any] = {}
        status_code = 200
        zone_text = " ".join(split.zone + split.promoted)
        main_payload: dict = {"status": "skipped", "reason": "nothing for this zone after sorting", "kinds": [], "episode_id": None}
        if zone_text:
            main_payload, code = await _ingest_part(space, zone_text, source, key, ref_time, group_id=zone["group_id"],
                                                    zone_ref=zone["ref"], trust="trusted")
            if code == 429:
                return JSONResponse(main_payload, status_code=429,
                                    headers={"Retry-After": str(main_payload.get("retry_after_seconds", 60))})
            status_code = max(status_code, code)
            if split.promoted and person is not None and main_payload.get("episode_id"):
                for t in split.promoted:
                    store.add_consent(person_id=person["id"], company_id=space["id"], mode="company_rule", item_kind="summary_part",
                                      item_id=main_payload["episode_id"], text=t, actor_ref=space.get("rule_set_by"),
                                      company_episode_id=main_payload["episode_id"])
        parts[zone["ref"]] = main_payload
        if split.observations:
            obs, code = await _ingest_part(space, classify.OBSERVATION_PREFIX + " ".join(split.observations), source, key + ":obs",
                                           ref_time, group_id=zone["group_id"], zone_ref=zone["ref"], trust="untrusted")
            parts["observations"] = obs
            status_code = max(status_code, code if code != 429 else 200)
        if split.personal and person is not None:
            pers, code = await _ingest_part(person, " ".join(split.personal), source, key + ":personal", ref_time,
                                            zone_ref=access.PERSONAL, origin_company_id=space["id"])
            parts["personal"] = pers
            status_code = max(status_code, code if code != 429 else 200)
        pending = []
        for t in split.rules:
            r = store.add_pending_rule(space["id"], zone["ref"], t, source, ref_time, user_ref)
            pending.append({"id": r["id"], "zone": zone["ref"], "text": t})
        out = {
            **main_payload,
            "zone": zone["ref"],
            "parts": parts,
            "pending_rules": pending,
            "sorting": {**split_info, "sensitive_sentences": split.sensitive, "dropped_sentences": split.dropped,
                        "identifiers_masked": len(split.identifiers), "to_personal": len(split.personal),
                        "observations": len(split.observations), "rules_waiting": len(split.rules),
                        "promoted_by_company_rule": len(split.promoted)},
        }
        if pending and main_payload["status"] == "skipped" and not zone_text:
            out["status"], out["reason"] = "pending_confirmation", "a new rule waits for a person's confirmation"
        store.save_split(space["id"], key, person["id"] if person else "", {k: v for k, v in out.items() if k != "status"})
        return JSONResponse(out, status_code=status_code)

    @app.get("/v1/episodes/{episode_id}")
    async def get_episode(episode_id: str, company: Company):
        ep = store.get_episode(company["id"], episode_id)
        if ep is None:
            raise HTTPException(404, "episode not found")
        import json

        dur = None
        if ep["started_at"] and ep["finished_at"]:
            dur = int((ep["finished_at"] - ep["started_at"]) * 1000)
        return {
            "episode_id": ep["id"],
            "status": ep["status"],
            "reason": ep["reason"],
            "error": ep["error"],
            "source": json.loads(ep["source_json"]),
            "received_at": datetime.fromtimestamp(ep["created_at"], timezone.utc).isoformat(),
            "ingest_ms": dur,
            "usage": store.usage_for_episode(ep["id"]),
        }

    def _attach_sources(company: dict, facts: list[dict], zone: dict | None = None) -> list[dict]:
        uuids = sorted({u for f in facts for u in f.get("episode_ids", [])})
        srcs = store.sources_for_graph_episodes(company["id"], uuids)
        promoted = store.promoted_items(company["id"], [f["id"] for f in facts]) if company.get("kind") == "person" else {}
        for f in facts:
            f["sources"] = [srcs[u] for u in f.pop("episode_ids", []) if u in srcs]
            a = f.get("attributes") or {}
            # trust: untrusted = came from an e-mail, web page, file or tool output (an observation);
            # confirmed = a person corrected or confirmed it; trusted = said in a chat by a person
            f["trust"] = a.pop("zm_trust", None) or ("untrusted" if any(s.get("trust") == "untrusted" for s in f["sources"]) else "trusted")
            if zone is not None:
                f["zone"] = {"ref": zone["ref"], "kind": zone["kind"], "name": zone["name"]}
            if f["id"] in promoted:
                f["promoted_to"] = promoted[f["id"]]
        return facts

    def _zones_param(space: dict, zones: str | None) -> list[dict]:
        vis = access.visible_zones(store, space)
        if not zones:
            return vis
        want = {z.strip() for z in zones.split(",") if z.strip()}
        return [z for z in vis if z["ref"] in want]

    @app.get("/v1/search")
    async def search(
        company: Company,
        request: Request,
        q: Annotated[str, Query(min_length=1, max_length=500)],
        limit: Annotated[int, Query(ge=1, le=50)] = 10,
        include_superseded: bool = True,
        zones: Annotated[str | None, Query(max_length=1000)] = None,
        x_zen_personal_key: Annotated[str | None, Header()] = None,
    ):
        """Searches every zone the caller may see (or the `zones` given, comma-separated, among
        them), plus the starter's personal memory with X-Zen-Personal-Key. Every fact says its zone."""
        person = access.personal_for(store, company, x_zen_personal_key)
        try:
            quotas.check_search(company["id"])
            if person is not None:
                _ctx(request, subject_id=person["id"])
                quotas.check_search(person["id"])
        except QuotaExceeded as e:
            return quota_response(e)
        t0 = time.monotonic()
        targets = [(company, z) for z in _zones_param(company, zones)]
        if person is not None and (not zones or access.PERSONAL in zones.split(",")):
            targets.append((person, access.personal_zone(person)))
        qvec = None
        ranked: list[list[dict]] = []
        entities: list[dict] = []
        for space, z in targets:
            eng = await router.engine_for(space)
            if qvec is None and hasattr(eng, "query_vector"):
                qvec = await eng.query_vector(q)  # one embedding for every zone
            res = await eng.search(z["group_id"], q, limit, include_superseded, qvec=qvec)
            ranked.append(_attach_sources(space, res["facts"], z))
            for e in res["entities"]:
                e["zone"] = {"ref": z["ref"], "kind": z["kind"], "name": z["name"]}
                entities.append(e)
        facts: list[dict] = []
        for i in range(limit):  # interleave by rank, so no zone crowds out the others
            for lst in ranked:
                if i < len(lst):
                    facts.append(lst[i])
        return {"facts": facts[:limit], "entities": entities[:limit], "zones": [z["ref"] for _, z in targets],
                "took_ms": int((time.monotonic() - t0) * 1000)}

    @app.get("/v1/entities/{entity_id}")
    async def get_entity(entity_id: str, company: Company, zone: Annotated[str | None, Query(max_length=120)] = None):
        z = access.zone_for(store, company, zone)
        ent = await (await router.engine_for(company)).get_entity(z["group_id"], entity_id)
        if ent is None:
            raise HTTPException(404, "entity not found")
        ent["timeline"] = _attach_sources(company, ent["timeline"], z)
        return ent

    def _page(edge_type: str, key: str, company: dict, limit: int, cursor: str | None, zone: str | None = None, **kw):
        async def run():
            z = access.zone_for(store, company, zone)
            try:
                eng = await router.engine_for(company)
                items, nxt = await eng.typed_page(z["group_id"], edge_type, limit=limit, cursor=cursor, **kw)
            except ValueError:
                raise HTTPException(400, "invalid cursor")
            return {key: _attach_sources(company, items, z), "next_cursor": nxt, "zone": z["ref"]}

        return run()

    @app.get("/v1/decisions")
    async def decisions(
        company: Company,
        include_superseded: bool = False,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        cursor: Annotated[str | None, Query(max_length=200)] = None,
        zone: Annotated[str | None, Query(max_length=120)] = None,
    ):
        """Newest first. Pass `next_cursor` back as `cursor` for the next page (null = last page)."""
        return await _page("Decision", "decisions", company, limit, cursor, zone, include_superseded=include_superseded)

    @app.get("/v1/promises")
    async def promises(
        company: Company,
        status: Literal["open", "overdue", "done", "cancelled", "superseded", "all"] = "all",
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        cursor: Annotated[str | None, Query(max_length=200)] = None,
        zone: Annotated[str | None, Query(max_length=120)] = None,
    ):
        """Newest first, filtered by status in the database; paginate with `cursor`/`next_cursor`."""
        return await _page("Promise", "promises", company, limit, cursor, zone, include_superseded=True,
                           status=None if status == "all" else status)

    @app.get("/v1/facts")
    async def list_facts(
        company: Company,
        include_superseded: bool = True,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        cursor: Annotated[str | None, Query(max_length=200)] = None,
        zone: Annotated[str | None, Query(max_length=120)] = None,
    ):
        """Everything the zone knows, newest first ("Ce știe memoria")."""
        return await _page("all", "facts", company, limit, cursor, zone, include_superseded=include_superseded)

    @app.delete("/v1/entities/{entity_id}")
    async def forget_entity(entity_id: str, company: Company, zone: Annotated[str | None, Query(max_length=120)] = None):
        z = access.zone_for(store, company, zone)
        async with worker.lock_for(company["id"]):
            company = {**(store.get_company(company["id"]) or company), "key_user_ref": company.get("key_user_ref")}
            eng = await router.engine_for(company)
            res = await eng.forget_entity(z["group_id"], entity_id, keys.cipher(company["id"]))
            if res is None:
                raise HTTPException(404, "entity not found")
            # summaries still waiting for ingest would bring the name back: rewrite them too
            from .engine import ERASED, name_pattern

            pattern = name_pattern(res.get("name") or "")
            queued = 0
            if pattern is not None:
                for row in store.pending_summaries(company["id"]):
                    if row["summary"] and pattern.search(row["summary"]):
                        store.set_summary(row["id"], pattern.sub(ERASED, row["summary"]), company_id=company["id"])
                        queued += 1
        return {"status": "forgotten", **res, "queued_summaries_redacted": queued}

    async def _delete_company(company: dict) -> dict:
        """Revoke keys, crypto-shred the data key FIRST (so the encrypted content is unreadable
        even if a later step fails), then delete the graph and the records."""
        async with worker.lock_for(company["id"]):
            company = store.get_company(company["id"]) or company
            store.revoke_keys(company["id"])
            shredded = keys.shred(company["id"])
            nodes: int | None = None
            note = None
            try:
                eng = await router.engine_for(company)
                nodes = await eng.delete_group(company["group_id"])
                for z in store.zones_of(company["id"], include_archived=True):
                    nodes += await eng.delete_group(z["group_id"])
            except Exception as e:  # dedicated store down: its container must be destroyed instead
                log.exception("graph delete failed for %s", company["id"])
                note = f"graph store unreachable ({type(e).__name__}); destroy it with scripts/zm-admin"
            if company.get("store_id"):
                store.set_graph_store_status(company["store_id"], "orphaned")
                await router.forget_store(company["store_id"])
                note = note or "dedicated graph store is empty and marked orphaned; destroy it with scripts/zm-admin"
            store.delete_company(company["id"])
        out = {"status": "deleted", "company_id": company["id"], "graph_nodes_deleted": nodes,
               "data_keys_destroyed": shredded}
        if note:
            out["note"] = note
        return out

    @app.delete("/v1/company")
    async def delete_own_company(
        company: Company, x_confirm_delete: Annotated[str | None, Header()] = None
    ):
        if x_confirm_delete != company["id"]:
            raise HTTPException(400, "set header X-Confirm-Delete to your company_id to erase all company memory")
        return await _delete_company(company)


    # ---- one fact: review and correction ("Ce știe memoria") -------------------------------------

    def _user_of(space: dict) -> str | None:
        return space.get("key_user_ref") or (space.get("owner_ref") if space.get("kind") == "person" else None)

    async def _fact_or_404(space: dict, z: dict, fact_id: str) -> dict:
        f = await (await router.engine_for(space)).get_fact(z["group_id"], fact_id)
        if f is None:
            raise HTTPException(404, "fact not found")
        return f

    @app.get("/v1/facts/{fact_id}")
    async def get_fact(fact_id: str, company: Company, zone: Annotated[str | None, Query(max_length=120)] = None):
        z = access.zone_for(store, company, zone)
        return _attach_sources(company, [await _fact_or_404(company, z, fact_id)], z)[0]

    @app.patch("/v1/facts/{fact_id}")
    async def correct_fact(fact_id: str, body: FactCorrectionIn, company: Company,
                           zone: Annotated[str | None, Query(max_length=120)] = None):
        """A person rewrites a fact (it becomes trust "confirmed"; the old text is kept on the fact)."""
        z = access.writable_zone(store, company, zone)
        text, _ = classify.mask_identifiers(body.fact.strip())
        async with worker.lock_for(company["id"]):
            await _fact_or_404(company, z, fact_id)
            f = await (await router.engine_for(company)).correct_fact(z["group_id"], fact_id, text, _user_of(company))
        return _attach_sources(company, [f], z)[0]

    @app.post("/v1/facts/{fact_id}/wrong")
    async def mark_fact_wrong(fact_id: str, company: Company, zone: Annotated[str | None, Query(max_length=120)] = None):
        """"Greșit": the fact stops being current now and stays in the history marked wrong."""
        z = access.writable_zone(store, company, zone)
        async with worker.lock_for(company["id"]):
            await _fact_or_404(company, z, fact_id)
            await (await router.engine_for(company)).mark_wrong(z["group_id"], fact_id, _user_of(company))
        return {"status": "marked_wrong", "id": fact_id}

    @app.delete("/v1/facts/{fact_id}")
    async def delete_fact(fact_id: str, company: Company, zone: Annotated[str | None, Query(max_length=120)] = None):
        """Personal memory: the person deletes their own item. Company zones: owners/admins only."""
        z = access.writable_zone(store, company, zone)
        if company.get("kind") != "person" and not access.is_admin(store, company):
            raise HTTPException(403, "only owners and admins delete company facts; mark it wrong instead")
        async with worker.lock_for(company["id"]):
            ok = await (await router.engine_for(company)).delete_fact(z["group_id"], fact_id)
        if not ok:
            raise HTTPException(404, "fact not found")
        return {"status": "deleted", "id": fact_id}

    @app.post("/v1/forget-person")
    async def forget_person(body: ForgetPersonIn, company: Company):
        """GDPR: every fact about a named person or organization, in every zone of the company
        (archived ones too). Owners/admins only. Personal memories of members are not touched:
        nobody but their owner can reach them."""
        if company.get("kind") == "person" or not access.is_admin(store, company):
            raise HTTPException(403, "only owners and admins erase a person from company memory")
        out = []
        async with worker.lock_for(company["id"]):
            eng = await router.engine_for(company)
            from .engine import ERASED, name_pattern

            for z in [access.company_zone(company)] + [access._zone_view(x) for x in store.zones_of(company["id"], include_archived=True)]:
                ids = await eng.find_entities_by_name(z["group_id"], body.name)
                for eid in ids:
                    res = await eng.forget_entity(z["group_id"], eid, keys.cipher(company["id"]))
                    if res:
                        out.append({"zone": z["ref"], "entity_id": eid, "facts_deleted": res.get("facts_deleted"),
                                    "facts_rewritten": res.get("facts_rewritten")})
            pattern = name_pattern(body.name)
            queued = 0
            if pattern is not None:
                for row in store.pending_summaries(company["id"]):
                    if row["summary"] and pattern.search(row["summary"]):
                        store.set_summary(row["id"], pattern.sub(ERASED, row["summary"]), company_id=company["id"])
                        queued += 1
        return {"status": "forgotten", "entities": out, "queued_summaries_redacted": queued}

    # ---- rules waiting for confirmation -------------------------------------------------------

    @app.get("/v1/rules/pending")
    async def pending_rules(company: Company):
        """"Agentul vrea să rețină o regulă nouă": rules from chats, waiting for a person."""
        refs = [z["ref"] for z in access.visible_zones(store, company)]
        return {"rules": [{"id": r["id"], "zone": r["zone_ref"], "text": r["text"], "proposed_by": r["proposed_by"],
                           "thread_id": r["source"].get("thread_id"), "title": r["source"].get("title"),
                           "created_at": datetime.fromtimestamp(r["created_at"], timezone.utc).isoformat()}
                          for r in store.pending_rules(company["id"], refs)]}

    async def _rule_or_404(space: dict, rule_id: str) -> tuple[dict, dict]:
        r = store.get_pending_rule(space["id"], rule_id)
        if r is None or r["status"] != "pending":
            raise HTTPException(404, "rule not found")
        return r, access.writable_zone(store, space, r["zone_ref"])

    @app.post("/v1/rules/{rule_id}/confirm")
    async def confirm_rule(rule_id: str, company: Company):
        r, z = await _rule_or_404(company, rule_id)
        by = _user_of(company)
        src = {**r["source"], "confirmed_by": by}
        payload, code = await _ingest_part(company, r["text"], src, f"rule:{rule_id}", r["reference_time"],
                                           group_id=z["group_id"], zone_ref=z["ref"], trust="confirmed", force=True)
        if code == 429:
            return JSONResponse(payload, status_code=429)
        store.decide_rule(company["id"], rule_id, "confirmed", by, payload.get("episode_id"))
        return {"status": "confirmed", "id": rule_id, "episode": payload}

    @app.post("/v1/rules/{rule_id}/reject")
    async def reject_rule(rule_id: str, company: Company):
        await _rule_or_404(company, rule_id)
        store.decide_rule(company["id"], rule_id, "rejected", _user_of(company), None)
        return {"status": "rejected", "id": rule_id}

    # ---- zones ---------------------------------------------------------------------------------

    @app.get("/v1/zones")
    async def list_zones(company: Company):
        """The zones this key may read; owners/admins also see who reads each zone (hub user ids)."""
        admin = access.is_admin(store, company)
        members = store.members_of(company["id"]) if admin else []
        eng = await router.engine_for(company)
        out = []
        for z in access.visible_zones(store, company):
            item = {k: z[k] for k in ("ref", "kind", "name", "archived")} | {"parent_ref": z.get("parent_ref"),
                                                                             "counts": await eng.counts(z["group_id"])}
            if admin:
                item["readers"] = [m["user_ref"] for m in members if m["admin"] or
                                   (m["company_read"] if z["ref"] == access.COMPANY else z["ref"] in m["zones"])]
            out.append(item)
        return {"zones": out, "admin": admin,
                "rules": {"auto_promote_decisions": bool(company.get("auto_promote_decisions")),
                          "sensitive_policy": company.get("sensitive_policy") or "personal"}
                if company.get("kind") != "person" else None}

    # ---- personal memory: promotion to the company, consent records ----------------------------

    @app.post("/v1/facts/{fact_id}/promote")
    async def promote_fact(fact_id: str, body: PromoteIn, request: Request, company: Company,
                           x_zen_company_key: Annotated[str | None, Header()] = None):
        """"Trimite în memoria firmei": the person (bearer = their personal key) sends one of their
        items to a company zone (X-Zen-Company-Key = their key of that company, same hub user)."""
        person = company
        if person.get("kind") != "person":
            raise HTTPException(400, "send your personal key as the bearer key")
        target = store.company_for_key((x_zen_company_key or "").strip()) if x_zen_company_key else None
        if target is None or target.get("kind") == "person":
            raise HTTPException(401, "X-Zen-Company-Key must be a valid company key")
        if not target.get("key_user_ref") or target["key_user_ref"] != person.get("owner_ref"):
            raise HTTPException(403, "the company key belongs to another person")
        if not store.person_linked(person["id"], target["id"]):
            raise HTTPException(403, "you are not (or no longer) in this company")
        _ctx(request, subject_id=target["id"])
        z = access.writable_zone(store, target, body.zone)
        f = await _fact_or_404(person, access.personal_zone(person), fact_id)
        text = f["fact"] or ""
        src = {"thread_id": f"personal:{fact_id}", "timestamp": f.get("valid_from") or datetime.now(timezone.utc).isoformat(),
               "user": body.user, "title": "Din memoria personală", "app": "zen-staff"}
        consent = store.add_consent(person_id=person["id"], company_id=target["id"], mode="manual", item_kind="fact",
                                    item_id=fact_id, text=text, actor_ref=person.get("owner_ref"), company_episode_id=None)
        payload, code = await _ingest_part(target, text, src, f"promote:{consent['id']}", src["timestamp"], group_id=z["group_id"],
                                           zone_ref=z["ref"], trust="confirmed", force=True)
        if code == 429:
            return JSONResponse(payload, status_code=429)
        store.set_consent_episode(consent["id"], payload.get("episode_id"))
        return {"status": "promoted", "consent_id": consent["id"], "zone": z["ref"], "episode": payload}

    @app.get("/v1/consents")
    async def list_consents(company: Company):
        """Personal key: what you sent to companies. Company key (owners/admins): what people sent to it.
        Ids, mode and a hash of the text only."""
        if company.get("kind") == "person":
            rows = store.consents_for(person_id=company["id"])
        elif access.is_admin(store, company):
            rows = store.consents_for(company_id=company["id"])
        else:
            raise HTTPException(403, "only owners and admins see the consent records of the company")
        return {"consents": [{**{k: r[k] for k in ("id", "person_id", "company_id", "mode", "item_kind", "item_id", "item_sha256",
                                                  "actor_ref", "company_episode_id")},
                              "created_at": datetime.fromtimestamp(r["created_at"], timezone.utc).isoformat()} for r in rows]}

    @app.delete("/v1/companies/{company_id}/items")
    async def forget_company_items(company_id: str, company: Company):
        """Personal key: delete every personal item that came from chats of that company (when you
        leave it, or any time). Promoted copies stay in the company: they were given with consent."""
        if company.get("kind") != "person":
            raise HTTPException(400, "this is for personal memory")
        return await _forget_origin(company, company_id)

    async def _forget_origin(person: dict, company_id: str) -> dict:
        async with worker.lock_for(person["id"]):
            uuids = store.graph_uuids_from_origin(person["id"], company_id)
            res = await (await router.engine_for(person)).delete_episodes(person["group_id"], uuids)
            rows = store.delete_episodes_from_origin(person["id"], company_id)
        return {"status": "deleted", "company_id": company_id, "episodes_deleted": res["episodes"], "facts_deleted": res["facts"],
                "entities_deleted": res["entities"], "records_deleted": rows}

    # ---- admin API -------------------------------------------------------------------------

    @app.post("/admin/companies", dependencies=[Admin], status_code=201)
    async def admin_create_company(body: CompanyIn):
        if cfg.tenancy == "single" and store.list_companies("company"):
            raise HTTPException(409, "single-tenant deployment already has its company")
        company, raw = store.create_company(body.name)
        return {"company_id": company["id"], "name": company["name"], "api_key": raw, "note": "store the key now; it is not shown again"}

    @app.get("/admin/companies", dependencies=[Admin])
    async def admin_list_companies():
        out = []
        for c in store.list_companies("company"):  # personal spaces are listed by /admin/persons, without content
            try:
                graph = await (await router.engine_for(c)).counts(c["group_id"])
            except Exception as e:
                graph = {"error": type(e).__name__}
            out.append({"company_id": c["id"], "name": c["name"], "tier": c.get("tier") or "standard",
                        "store_id": c.get("store_id"),
                        "created_at": datetime.fromtimestamp(c["created_at"], timezone.utc).isoformat(), "graph": graph})
        return {"companies": out}

    @app.post("/admin/companies/{company_id}/keys", dependencies=[Admin], status_code=201)
    async def admin_new_key(company_id: str, revoke_existing: bool = False,
                            user_ref: Annotated[str | None, Query(max_length=120, pattern=r"^[A-Za-z0-9_.:@-]+$")] = None):
        """A machine key. With `user_ref` (the hub user) the key reads the zones that user may read."""
        c = store.get_company(company_id)
        if c is None or c.get("kind") == "person":
            raise HTTPException(404, "company not found")
        revoked = store.revoke_keys(company_id) if revoke_existing else 0
        key_id, raw = store.add_key_with_id(company_id, user_ref=user_ref)
        return {"company_id": company_id, "key_id": key_id, "api_key": raw, "revoked": revoked, "user_ref": user_ref}

    @app.get("/admin/companies/{company_id}/keys", dependencies=[Admin])
    async def admin_list_keys(company_id: str):
        _company_or_404(company_id)
        def iso(t):
            return None if t is None else datetime.fromtimestamp(t, timezone.utc).isoformat()
        return {"keys": [{"key_id": k["id"], "prefix": k["prefix"], "created_at": iso(k["created_at"]),
                          "revoked_at": iso(k["revoked_at"]), "user_ref": k.get("user_ref")} for k in store.list_keys(company_id)]}

    @app.delete("/admin/companies/{company_id}/keys/{key_id}", dependencies=[Admin])
    async def admin_revoke_key(company_id: str, key_id: str):
        _company_or_404(company_id)
        return {"company_id": company_id, "key_id": key_id, "revoked": store.revoke_key(company_id, key_id)}

    # ---- admin: zones and access (from the hub) ----------------------------------------------

    @app.put("/admin/companies/{company_id}/access", dependencies=[Admin])
    async def admin_sync_access(company_id: str, body: AccessIn):
        """Replace the company's departments/projects and who reads which zone (the hub sends its
        whole view each time). Zones gone from the hub are archived, never deleted."""
        c = _company_or_404(company_id)
        if c.get("kind") == "person":
            raise HTTPException(404, "company not found")
        res = store.sync_access(company_id, [z.model_dump() for z in body.zones], [m.model_dump() for m in body.members])
        if body.auto_promote_decisions is not None:
            store.set_company_rule(company_id, body.auto_promote_decisions, body.rule_set_by)
        if body.sensitive_policy is not None:
            store.set_sensitive_policy(company_id, body.sensitive_policy)
        return {"company_id": company_id, **res}

    @app.get("/admin/companies/{company_id}/access", dependencies=[Admin])
    async def admin_get_access(company_id: str):
        c = _company_or_404(company_id)
        return {"company_id": company_id,
                "zones": [{k: z[k] for k in ("ref", "kind", "name", "parent_ref")} | {"archived": z["archived_at"] is not None}
                          for z in store.zones_of(company_id, include_archived=True)],
                "members": store.members_of(company_id),
                "auto_promote_decisions": bool(c.get("auto_promote_decisions")), "sensitive_policy": c.get("sensitive_policy")}

    # ---- admin: personal memory spaces (ids only, never content) --------------------------------

    def _person_or_404(person_id: str) -> dict:
        p = store.get_company(person_id)
        if p is None or p.get("kind") != "person":
            raise HTTPException(404, "person not found")
        return p

    def _person_view(p: dict) -> dict:
        def iso(t):
            return None if t is None else datetime.fromtimestamp(t, timezone.utc).isoformat()
        return {"person_id": p["id"], "user_ref": p["owner_ref"], "created_at": iso(p["created_at"]),
                "companies": [{"company_id": l["company_id"], "linked_at": iso(l["linked_at"]), "detached_at": iso(l["detached_at"])}
                              for l in store.person_links(p["id"])]}

    @app.post("/admin/persons", dependencies=[Admin])
    async def admin_create_person(body: PersonIn):
        """The personal memory of one hub user (created once; asking again returns the same one)."""
        p, created = store.create_person(body.user_ref)
        return JSONResponse({**_person_view(p), "created": created}, status_code=201 if created else 200)

    @app.get("/admin/persons", dependencies=[Admin])
    async def admin_list_persons():
        return {"persons": [_person_view(p) for p in store.list_companies("person")]}

    @app.get("/admin/persons/{person_id}", dependencies=[Admin])
    async def admin_get_person(person_id: str):
        return _person_view(_person_or_404(person_id))

    @app.delete("/admin/persons/{person_id}", dependencies=[Admin])
    async def admin_delete_person(person_id: str):
        """Account deletion: the person's key is destroyed first (crypto-shredding), then the graph."""
        return await _delete_company(_person_or_404(person_id))

    @app.post("/admin/persons/{person_id}/keys", dependencies=[Admin], status_code=201)
    async def admin_person_key(person_id: str):
        p = _person_or_404(person_id)
        key_id, raw = store.add_key_with_id(person_id, user_ref=p["owner_ref"])
        return {"person_id": person_id, "key_id": key_id, "api_key": raw}

    @app.get("/admin/persons/{person_id}/keys", dependencies=[Admin])
    async def admin_person_keys(person_id: str):
        _person_or_404(person_id)
        return await admin_list_keys(person_id)

    @app.delete("/admin/persons/{person_id}/keys/{key_id}", dependencies=[Admin])
    async def admin_person_revoke(person_id: str, key_id: str):
        _person_or_404(person_id)
        return {"person_id": person_id, "key_id": key_id, "revoked": store.revoke_key(person_id, key_id)}

    @app.put("/admin/persons/{person_id}/companies/{company_id}", dependencies=[Admin])
    async def admin_link_person(person_id: str, company_id: str):
        _person_or_404(person_id)
        c = _company_or_404(company_id)
        if c.get("kind") == "person":
            raise HTTPException(404, "company not found")
        store.link_person(person_id, company_id)
        return _person_view(_person_or_404(person_id))

    @app.delete("/admin/persons/{person_id}/companies/{company_id}", dependencies=[Admin])
    async def admin_unlink_person(person_id: str, company_id: str, forget: bool = False):
        """The person left the company. Their personal memory stays theirs (forget=false) or loses
        everything that came from that company's chats (forget=true). Nothing goes to the company."""
        p = _person_or_404(person_id)
        detached = store.detach_person(person_id, company_id)
        out = {"person_id": person_id, "company_id": company_id, "detached": bool(detached)}
        if forget:
            out["forgotten"] = await _forget_origin(p, company_id)
        return out

    @app.delete("/admin/companies/{company_id}", dependencies=[Admin])
    async def admin_delete_company(company_id: str):
        c = store.get_company(company_id)
        if c is None:
            raise HTTPException(404, "company not found")
        return await _delete_company(c)

    def _company_or_404(company_id: str) -> dict:
        c = store.get_company(company_id)
        if c is None:
            raise HTTPException(404, "company not found")
        return c

    @app.get("/admin/companies/{company_id}/limits", dependencies=[Admin])
    async def admin_get_limits(company_id: str):
        _company_or_404(company_id)
        return {"company_id": company_id, "quotas": quotas.status(company_id), "defaults": quotas.defaults}

    @app.put("/admin/companies/{company_id}/limits", dependencies=[Admin])
    async def admin_set_limits(company_id: str, body: LimitsIn):
        _company_or_404(company_id)
        store.set_limits(company_id, {k: getattr(body, k) for k in body.model_fields_set})
        return {"company_id": company_id, "quotas": quotas.status(company_id), "defaults": quotas.defaults}

    @app.delete("/admin/companies/{company_id}/limits", dependencies=[Admin])
    async def admin_clear_limits(company_id: str):
        _company_or_404(company_id)
        store.clear_limits(company_id)
        return {"company_id": company_id, "quotas": quotas.status(company_id), "defaults": quotas.defaults}

    @app.get("/admin/usage", dependencies=[Admin])
    async def admin_usage(since: datetime | None = None, until: datetime | None = None):
        s = since.timestamp() if since else 0.0
        u = until.timestamp() if until else None
        rows = store.usage_summary(s, u)
        for r in rows:
            legacy_in, legacy_out = r.pop("legacy_input") or 0, r.pop("legacy_output") or 0
            # rows since v2 carry their exact cost (model, cache and batch pricing); older rows are estimated
            r["est_cost_usd"] = round(
                (r.pop("cost_usd_metered") or 0) + legacy_in / 1e6 * cfg.llm_price_in + legacy_out / 1e6 * cfg.llm_price_out, 6
            )
        return {"model": llm.model_name, "price_per_mtok_usd": {"input": cfg.llm_price_in, "output": cfg.llm_price_out}, "companies": rows}

    # ---- admin: dedicated graph stores (Enterprise tier) ---------------------------------------

    def _store_view(s: dict) -> dict:
        return {"store_id": s["id"], "company_id": s["company_id"], "uri": s["uri"], "container": s["container"],
                "status": s["status"], "routed_companies": [c["id"] for c in store.companies_on_store(s["id"])],
                "created_at": datetime.fromtimestamp(s["created_at"], timezone.utc).isoformat()}

    @app.post("/admin/stores", dependencies=[Admin], status_code=201)
    async def admin_register_store(body: StoreIn):
        if not keys.enabled:
            raise HTTPException(409, "dedicated stores need encryption on (ZM_MASTER_KEYS) to keep their password")
        if router.factory is None:
            raise HTTPException(409, "this deployment cannot open dedicated stores")
        _company_or_404(body.company_id)
        if store.get_graph_store(body.store_id):
            raise HTTPException(409, "store already registered")
        eng = router.factory(body.uri, body.username, body.password)
        try:
            if not await eng.ping():
                raise HTTPException(502, "cannot reach the store (wrong uri or password?)")
        finally:
            await eng.close()
        keys.put_secret(f"store:{body.store_id}", body.password)
        return _store_view(store.add_graph_store(body.store_id, body.company_id, body.uri, body.username, body.container))

    @app.get("/admin/stores", dependencies=[Admin])
    async def admin_list_stores():
        out = []
        for s in store.list_graph_stores():
            v = _store_view(s)
            try:
                v["reachable"] = await (await router.engine_for_store(s["id"])).ping()
            except Exception:
                v["reachable"] = False
            out.append(v)
        return {"stores": out}

    @app.delete("/admin/stores/{store_id}", dependencies=[Admin])
    async def admin_unregister_store(store_id: str):
        s = store.get_graph_store(store_id)
        if s is None:
            raise HTTPException(404, "store not found")
        if store.companies_on_store(store_id):
            raise HTTPException(409, "a company is still routed to this store; migrate it to shared first")
        nodes = None
        try:
            eng = await router.engine_for_store(store_id)
            # store-level check (not a company query): a store with data left is never dropped
            records, _, _ = await eng.driver.execute_query("MATCH (n) RETURN count(n) AS c")  # zm-unscoped: emptiness check of a whole dedicated store
            nodes = records[0]["c"]
        except Exception:
            if s["status"] != "orphaned":
                raise HTTPException(502, "store unreachable; it can only be dropped once its company is deleted")
        if nodes and s["status"] != "orphaned":
            raise HTTPException(409, f"store still holds {nodes} nodes")
        await router.forget_store(store_id)
        keys.delete_secret(f"store:{store_id}")
        store.delete_graph_store(store_id)
        return {"status": "unregistered", "store_id": store_id, "nodes_left": nodes, "container": s["container"]}

    @app.post("/admin/companies/{company_id}/migrate", dependencies=[Admin])
    async def admin_migrate(company_id: str, body: MigrateIn):
        """Move the company's graph between the shared store and its dedicated store. Holds the
        company's ingest lock; copies, verifies (counts + digest), switches the route, then deletes
        the source copy. On any mismatch nothing changes."""
        async with worker.lock_for(company_id):
            c = _company_or_404(company_id)
            cur = c.get("store_id")
            if body.to == "dedicated":
                sid = body.store_id
                s = store.get_graph_store(sid) if sid else None
                if s is None:
                    raise HTTPException(404, "store_id of a registered store is required")
                if s["company_id"] != company_id or s["status"] != "ready":
                    raise HTTPException(409, "that store is not this company's (or not ready)")
                if any(x["id"] != company_id for x in store.companies_on_store(sid)):
                    raise HTTPException(409, "store already serves another company")
                if cur == sid:
                    return {"status": "unchanged", "company_id": company_id, "store_id": sid}
                target = sid
            else:
                if not cur:
                    return {"status": "unchanged", "company_id": company_id, "store_id": None}
                target = None
            groups = [c["group_id"]] + [z["group_id"] for z in store.zones_of(company_id, include_archived=True)]
            copied: list[str] = []
            try:
                src = await router.engine_for_store(cur)
                dst = await router.engine_for_store(target)
                report = None
                for g in groups:  # the company and each of its zones (departments, projects)
                    r = await copy_group(src, dst, g)
                    copied.append(g)
                    report = report or r
            except (MigrationError, StoreUnavailable) as e:
                for g in copied:  # a later zone failed: undo the copies already made
                    await dst.delete_group(g)
                raise HTTPException(409, f"migration refused: {e}")
            store.set_company_store(company_id, target)
            deleted = 0
            for g in groups:
                deleted += await src.delete_group(g)
            log.info("company %s moved %s -> %s (%d nodes)", company_id, cur or "shared", target or "shared", report["source"]["nodes"])
        return {"status": "moved", "company_id": company_id, "from": cur or "shared", "to": target or "shared",
                "tier": "enterprise" if target else "standard", "source_nodes_deleted": deleted, **report}

    # ---- admin: keys --------------------------------------------------------------------------

    @app.get("/admin/keys", dependencies=[Admin])
    async def admin_keys():
        return {"encryption": keys.enabled, "active_master_key": keys.master.active or None,
                "configured_master_keys": sorted(keys.master.keys), "wrapped_keys_by_master_key": keys.kek_usage()}

    @app.post("/admin/keys/rewrap", dependencies=[Admin])
    async def admin_rewrap():
        """After adding a new master key to ZM_MASTER_KEYS and making it ZM_MASTER_KEY_ID:
        re-wrap every data key under it. Then the old master key can be removed from the env."""
        if not keys.enabled:
            raise HTTPException(409, "encryption is off")
        return keys.rewrap_all()

    @app.post("/admin/companies/{company_id}/keys/rotate", dependencies=[Admin])
    async def admin_rotate_company_key(company_id: str):
        """New data key version; re-encrypt the company's stored content; destroy old versions."""
        if not keys.enabled:
            raise HTTPException(409, "encryption is off")
        async with worker.lock_for(company_id):
            c = _company_or_404(company_id)
            cipher = keys.rotate_begin(company_id)
            rows = store.reencrypt_episodes(company_id)
            eng = await router.engine_for(c)
            episodes = 0
            for g in [c["group_id"]] + [z["group_id"] for z in store.zones_of(company_id, include_archived=True)]:
                episodes += await eng.reencrypt_episodes(g, cipher)
            rows += store.reencrypt_rules(company_id)
            destroyed = keys.retire_below(company_id, cipher.active)
        return {"company_id": company_id, "active_version": cipher.active, "sqlite_rows_reencrypted": rows,
                "graph_episodes_reencrypted": episodes, "old_versions_destroyed": destroyed}

    # ---- admin: audit -------------------------------------------------------------------------

    @app.get("/admin/embedder/usage", dependencies=[Admin])
    async def admin_embedder_usage():
        emb = router.shared.g.embedder
        return {"provider": cfg.embedder_provider, "model": getattr(emb, "model", None),
                "today": getattr(emb, "usage", None)}

    @app.get("/admin/audit/head", dependencies=[Admin])
    async def admin_audit_head():
        return audit.head()

    @app.get("/admin/audit/verify", dependencies=[Admin])
    async def admin_audit_verify(anchor_seq: int | None = None,
                                 anchor_hash: Annotated[str | None, Query(pattern=r"^[0-9a-f]{64}$")] = None):
        return audit.verify(anchor_seq, anchor_hash)

    return app


def pipeline_options(cfg: Settings) -> dict:
    """Ingest cost settings for ZenGraphiti.create (see config.py and README "Cost per conversation")."""
    return {
        "previous_episodes": cfg.previous_episodes if cfg.previous_episodes >= 0 else None,
        "previous_episode_chars": cfg.previous_episode_chars or None,
        "resolve_mode": cfg.edge_resolve_mode,
        "edge_candidates": max(1, cfg.edge_candidates),
    }


def build_components(cfg: Settings = default_settings) -> tuple[MemoryEngine, Any]:
    """Engine and LLM from settings (shared by the API and the eval runner)."""
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    from .embedder import CloudflareEmbedder, FakeEmbedder, LocalEmbedder, NoRerank
    from .engine import ZenGraphiti
    from .llm import AnthropicLLM, FakeLLM
    import os

    if cfg.llm_provider == "anthropic":
        if not cfg.anthropic_api_key:
            raise RuntimeError("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY")
        step_models = dict(
            kv.split("=", 1) for kv in (x.strip() for x in cfg.llm_step_models.split(",")) if "=" in kv
        )
        llm: Any = AnthropicLLM(
            cfg.anthropic_api_key, cfg.llm_model, os.environ.get("LLM_EFFORT", "low"),
            prompt_cache=cfg.llm_prompt_cache, cache_ttl=cfg.llm_cache_ttl, batch=cfg.llm_batch, batch_window=cfg.llm_batch_window_s,
            batch_poll=cfg.llm_batch_poll_s, batch_max_wait=cfg.llm_batch_max_wait_s, step_models=step_models,
        )
    else:
        llm = FakeLLM()
    if cfg.embedder_provider == "fake":
        embedder: Any = FakeEmbedder(cfg.embedding_dim)
    elif cfg.embedder_provider == "cloudflare":
        embedder = CloudflareEmbedder(cfg.cf_ai_account_id, cfg.cf_ai_api_token, cfg.cf_embed_model, cfg.embedding_dim)
    else:
        embedder = LocalEmbedder(cfg.embedder_url, cfg.embedder_model, cfg.embedding_dim, cfg.embedder_api_key)
    driver = Neo4jDriver(cfg.neo4j_uri, cfg.neo4j_user, cfg.neo4j_password)
    graphiti = ZenGraphiti.create(driver, llm, embedder, NoRerank(), profile=cfg.extraction_profile, **pipeline_options(cfg))
    engine = MemoryEngine(graphiti, os.environ.get("EMBEDDER_QUERY_INSTRUCTION", ""), profile=cfg.extraction_profile)
    return engine, llm


def build_default_app() -> FastAPI:
    """Production wiring from environment variables."""
    cfg = default_settings
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("neo4j.notifications").setLevel(logging.WARNING)
    engine, llm = build_components(cfg)
    keys = KeyStore(cfg.keys_path, MasterKeys.from_env())
    store = Store(cfg.db_path, keys)
    router = GraphRouter(engine, store, keys, engine_factory(cfg, engine, llm))
    return create_app(store, router, llm, cfg, keys=keys)


def engine_factory(cfg: Settings, shared: MemoryEngine, llm: Any):
    """(uri, user, password) -> MemoryEngine on another Neo4j (a dedicated store), sharing the
    LLM client, the embedder and the pipeline settings of the shared engine."""
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    from .embedder import NoRerank
    from .engine import ZenGraphiti

    def make(uri: str, user: str, password: str) -> MemoryEngine:
        driver = Neo4jDriver(uri, user, password)
        g = ZenGraphiti.create(driver, llm, shared.g.embedder, NoRerank(), profile=cfg.extraction_profile,
                               **pipeline_options(cfg))
        return MemoryEngine(g, shared.query_instruction, profile=cfg.extraction_profile)

    return make
