"""Per-company consumption limits.

Three quotas, each with a default from the environment and an optional per-company override
(admin API). 0 means unlimited.

| quota                    | counts                                                      | window              |
|--------------------------|-------------------------------------------------------------|---------------------|
| episodes_per_day         | POST /v1/episodes that are not duplicates (skipped included) | UTC calendar day    |
| ingest_tokens_per_month  | every LLM token billed to the company (gate + extraction)   | UTC calendar month  |
| searches_per_minute      | GET /v1/search                                              | sliding 60 seconds  |

The token quota is enforced with reservations, so it is not overshot: before the gate runs,
POST /v1/episodes atomically checks used + reserved + the estimate of this summary (gate +
ingest) against the limit and reserves the estimate (else 429). After the gate the reservation
shrinks to the ingest estimate (or is released for a skipped summary); the ingest settles it
with the real usage, or releases it on failure. Before every LLM call of a running job the
`Budget` makes sure the reservation covers what the job has spent plus that call's estimate,
extending it atomically when the period still has room, else the job stops with QuotaExceeded
before the call is made. The search counter lives in SQLite (`search_hits`), so it survives
restarts and is shared by every process using the same database.

A request over a quota gets HTTP 429 with a JSON body naming the quota and when it resets, and a
Retry-After header. When a company's monthly token use crosses 80% and 100% of its quota, an
alert is written to the log (once per month and threshold) and, if QUOTA_ALERT_WEBHOOK_URL is
set, POSTed there as JSON.
"""

from __future__ import annotations

import asyncio
import calendar
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from .db import Store

log = logging.getLogger("zen-memory.quotas")

QUOTA_NAMES = ("episodes_per_day", "ingest_tokens_per_month", "searches_per_minute")
ALERT_THRESHOLDS = (80, 100)


@dataclass
class QuotaExceeded(Exception):
    quota: str
    limit: int
    used: int
    resets_at: datetime

    def body(self) -> dict:
        retry = max(1, int((self.resets_at - datetime.now(timezone.utc)).total_seconds()) + 1)
        what = {
            "episodes_per_day": f"{self.limit} conversation summaries per day",
            "ingest_tokens_per_month": f"{self.limit:,} LLM tokens per month for memory ingest",
            "searches_per_minute": f"{self.limit} searches per minute",
        }[self.quota]
        return {
            "error": "quota_exceeded",
            "quota": self.quota,
            "limit": self.limit,
            "used": self.used,
            "resets_at": self.resets_at.isoformat(),
            "retry_after_seconds": retry,
            "message": f"Quota exceeded: {what}. It resets at {self.resets_at.isoformat()}.",
        }


def day_window(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def month_window(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    days = calendar.monthrange(start.year, start.month)[1]
    return start, start + timedelta(days=days)


class Quotas:
    def __init__(self, store: Store, defaults: dict[str, int], webhook_url: str = "", clock=None,
                 person_defaults: dict[str, int] | None = None, webhook_format: str = "json"):
        self.store = store
        self.defaults = {k: int(defaults.get(k, 0) or 0) for k in QUOTA_NAMES}
        # personal spaces (kind='person') have their own, smaller defaults
        self.person_defaults = {k: int((person_defaults or defaults).get(k, 0) or 0) for k in QUOTA_NAMES}
        self.webhook_url = webhook_url
        # "json" = the alert object below; "subject-body" = {"subject", "body"}, the shape of our
        # server's mail alert channel (the zz-notify Cloudflare Worker), so no relay is needed
        self.webhook_format = webhook_format
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._tasks: set[asyncio.Task] = set()

    # ---- limits -------------------------------------------------------------------------

    def defaults_for(self, company_id: str) -> dict[str, int]:
        c = self.store.get_company(company_id)
        return self.person_defaults if c is not None and c.get("kind") == "person" else self.defaults

    def limits(self, company_id: str) -> dict:
        over = self.store.get_limits(company_id)
        defaults = self.defaults_for(company_id)
        eff = {}
        for k in QUOTA_NAMES:
            v = over.get(k)
            eff[k] = {"limit": defaults[k] if v is None else v, "source": "default" if v is None else "override"}
        return eff

    def limit(self, company_id: str, name: str) -> int:
        return self.limits(company_id)[name]["limit"]

    def status(self, company_id: str) -> dict:
        now = self.clock()
        d0, d1 = day_window(now)
        m0, m1 = month_window(now)
        lim = self.limits(company_id)
        used = {
            "episodes_per_day": (self.store.episodes_since(company_id, d0.timestamp()), d1),
            "ingest_tokens_per_month": (self.store.tokens_since(company_id, m0.timestamp()), m1),
            "searches_per_minute": (self.store.search_count(company_id, now.timestamp()), now + timedelta(seconds=60)),
        }
        out = {k: {**lim[k], "used": used[k][0], "resets_at": used[k][1].isoformat()} for k in QUOTA_NAMES}
        out["ingest_tokens_per_month"]["reserved"] = self.store.reserved_tokens(company_id)
        return out | {"alerts": self.store.alerts_for(company_id)}

    # ---- checks (raise QuotaExceeded) -----------------------------------------------------

    def check_ingest(self, company_id: str) -> None:
        now = self.clock()
        lim = self.limit(company_id, "episodes_per_day")
        if lim > 0:
            d0, d1 = day_window(now)
            n = self.store.episodes_since(company_id, d0.timestamp())
            if n >= lim:
                raise QuotaExceeded("episodes_per_day", lim, n, d1)
        lim = self.limit(company_id, "ingest_tokens_per_month")
        if lim > 0:
            m0, m1 = month_window(now)
            n = self.store.tokens_since(company_id, m0.timestamp()) + self.store.reserved_tokens(company_id)
            if n >= lim:
                raise QuotaExceeded("ingest_tokens_per_month", lim, n, m1)

    def month_fraction_used(self, company_id: str) -> float:
        """Share of this month's token quota already used (0 when the quota is unlimited)."""
        lim = self.limit(company_id, "ingest_tokens_per_month")
        if lim <= 0:
            return 0.0
        m0, _ = month_window(self.clock())
        return self.store.tokens_since(company_id, m0.timestamp()) / lim

    def reserve_tokens(self, company_id: str, tokens: int) -> str:
        """Atomic check + reserve on the monthly token quota; returns the reservation id."""
        lim = self.limit(company_id, "ingest_tokens_per_month")
        m0, m1 = month_window(self.clock())
        rid, committed = self.store.reserve_tokens(company_id, max(0, int(tokens)), lim, m0.timestamp())
        if rid is None:
            raise QuotaExceeded("ingest_tokens_per_month", lim, committed, m1)
        return rid

    def budget(self, company_id: str, reservation: str, reserved: int) -> "Budget":
        return Budget(self, company_id, reservation, reserved)

    def check_search(self, company_id: str) -> None:
        lim = self.limit(company_id, "searches_per_minute")
        if lim <= 0:
            return
        ts = self.clock().timestamp()
        ok, n, oldest = self.store.take_search_slot(company_id, ts, lim)
        if not ok:
            reset = datetime.fromtimestamp((oldest or ts) + 60, timezone.utc)
            raise QuotaExceeded("searches_per_minute", lim, n, reset)

    # ---- monthly alerts -------------------------------------------------------------------

    def after_usage(self, company: dict) -> None:
        """Call after tokens were recorded for the company: alerts at 80% and 100%."""
        lim = self.limit(company["id"], "ingest_tokens_per_month")
        if lim <= 0:
            return
        now = self.clock()
        m0, _ = month_window(now)
        used = self.store.tokens_since(company["id"], m0.timestamp())
        period = now.strftime("%Y-%m")
        for th in ALERT_THRESHOLDS:
            if used * 100 >= lim * th and self.store.claim_alert(company["id"], period, th, used, lim):
                payload = {
                    "event": "quota_threshold",
                    "quota": "ingest_tokens_per_month",
                    "threshold_percent": th,
                    "company_id": company["id"],
                    "company_name": company.get("name"),
                    "period": period,
                    "used": used,
                    "limit": lim,
                    "at": now.isoformat(),
                }
                log.warning("QUOTA ALERT %s (%s) used %d of %d tokens this month (%d%% threshold)",
                            company["id"], company.get("name"), used, lim, th)
                if self.webhook_url:
                    self._spawn(self._post(payload))

    def _spawn(self, coro) -> None:
        try:
            t = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            return
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    @staticmethod
    def as_subject_body(payload: dict) -> dict:
        who = payload.get("company_name") or payload.get("company_id")
        subject = (f"zen-memory: {who} a folosit {payload['threshold_percent']}% din cota lunară de tokeni "
                   f"({payload['used']:,} din {payload['limit']:,}, {payload['period']})")
        body = (subject + "\n\nPeste 100%, rezumatele noi primesc 429 și cele în curs așteaptă ca 'deferred' "
                "până la resetare (1 ale lunii) sau până crește limita: PUT /admin/companies/{id}/limits.\n\n"
                + json.dumps(payload, ensure_ascii=False, indent=1))
        return {"subject": subject, "body": body}

    async def _post(self, payload: dict) -> None:
        if self.webhook_format == "subject-body":
            payload = self.as_subject_body(payload)
        try:
            async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "zen-memory-quota-alert/1.0"}) as c:
                r = await c.post(self.webhook_url, json=payload)
                r.raise_for_status()
        except Exception as e:
            log.error("quota alert webhook failed: %s", e)

    async def drain(self) -> None:
        if self._tasks:
            await asyncio.wait(list(self._tasks), timeout=10)


class Budget:
    """The token reservation of one running job (gate or ingest). `UsageMeter.before_call` asks it,
    before every LLM call, to cover what the job spent so far plus that call's estimate; it extends
    the reservation atomically while the month has room, else raises QuotaExceeded (no call is
    made, so the quota is never overshot by more than one call's estimation error)."""

    STEP = 5_000  # extend in chunks, so a long ingest does not hit SQLite on every call

    def __init__(self, quotas: Quotas, company_id: str, reservation: str, reserved: int):
        self.quotas, self.company_id, self.reservation, self.reserved = quotas, company_id, reservation, int(reserved)

    def ensure(self, spent: int, next_call: int) -> None:
        need = spent + next_call
        if need <= self.reserved:
            return
        lim = self.quotas.limit(self.company_id, "ingest_tokens_per_month")
        m0, m1 = month_window(self.quotas.clock())
        want = need + self.STEP
        store = self.quotas.store
        # the reservation holds the job's whole allowance (what it spent is recorded only when it
        # settles), so it grows to cover spent + the next call
        for tokens in (want, need):
            if store.extend_reservation(self.reservation, self.company_id, tokens, lim, m0.timestamp()):
                self.reserved = tokens
                return
        used = store.tokens_since(self.company_id, m0.timestamp()) + store.reserved_tokens(self.company_id)
        raise QuotaExceeded("ingest_tokens_per_month", lim, used, m1)
