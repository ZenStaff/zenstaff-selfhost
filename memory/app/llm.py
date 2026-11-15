"""LLM adapters.

* `AnthropicLLM`  - Graphiti LLMClient on Claude (Haiku by default) via the official SDK.
* `FakeLLM`       - deterministic, offline; used by tests and dry runs.

Every call adds its token usage to the `UsageMeter` active in the current asyncio context, so
one ingest (gate + all Graphiti extraction calls it fans out) is billed to exactly one company.

Cost controls in `AnthropicLLM`:
* prompt caching: the system prompt is sent as a cached block (`cache_control`). Our prompt
  overrides (`prompts.py`) put the long static instructions there, so repeated calls read them
  from the cache at 0.1x the input price;
* Message Batches (optional, `LLM_BATCH=on`): Graphiti's extraction calls are collected for a
  few seconds and sent as one batch, at 50% of the price, at the cost of latency (see README);
* a hard 100K input-token guard per call: above 100K, Haiku 5.5 bills the whole request at 5x,
  so the longest message is trimmed in the middle and the event is logged;
* per-step model routing (`LLM_STEP_MODELS`), e.g. a stronger model for one Graphiti step only.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re
import time
import typing
import uuid
from dataclasses import dataclass, field

from graphiti_core.llm_client.client import LLMClient
from graphiti_core.llm_client.config import DEFAULT_MAX_TOKENS, LLMConfig, ModelSize
from graphiti_core.llm_client.errors import RateLimitError, RefusalError
from graphiti_core.prompts.models import Message
from pydantic import BaseModel, ValidationError

log = logging.getLogger("zen-memory.llm")

# USD per 1M tokens (input, output) for prompts up to 100K tokens. Cache reads bill at 0.1x the
# input price, 5-minute cache writes at 1.25x; batch requests at 0.5x of everything.
PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
}
CACHE_READ_X = 0.10
CACHE_WRITE_X = 1.25
CACHE_WRITE_1H_X = 2.00
BATCH_X = 0.50
# Above this, Haiku 5.5 bills the whole request at 5x. Stay clearly below it.
INPUT_TOKEN_GUARD = 100_000
GUARD_TARGET = 90_000


def price_of(model: str, default: tuple[float, float] = (0.10, 0.50)) -> tuple[float, float]:
    return PRICES.get(model, default)


def call_cost(model: str, tin: int, tout: int, cache_write: int = 0, cache_read: int = 0, batch: bool = False,
              cache_write_1h: int = 0) -> float:
    """`cache_write` counts all cache writes; `cache_write_1h` is the part written with the 1-hour TTL (2x)."""
    pin, pout = price_of(model)
    cw_1h = min(cache_write_1h, cache_write)
    usd = (tin * pin + (cache_write - cw_1h) * pin * CACHE_WRITE_X + cw_1h * pin * CACHE_WRITE_1H_X
           + cache_read * pin * CACHE_READ_X + tout * pout) / 1e6
    return usd * (BATCH_X if batch else 1.0)


@dataclass
class UsageMeter:
    calls: int = 0
    input_tokens: int = 0  # uncached input
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    batch_calls: int = 0
    cost_usd: float = 0.0
    guard_trims: int = 0
    by_step: dict[str, dict[str, float]] = field(default_factory=dict)
    # quotas.Budget of the job (or None): checked before every call so the monthly quota holds
    budget: typing.Any = None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.cache_write_tokens + self.cache_read_tokens + self.output_tokens

    def before_call(self, estimated_tokens: int) -> None:
        if self.budget is not None:
            self.budget.ensure(self.total_tokens, estimated_tokens)

    def add(self, tin: int, tout: int, *, model: str = "", step: str = "", cache_write: int = 0,
            cache_read: int = 0, batch: bool = False, cache_write_1h: int = 0) -> None:
        self.calls += 1
        self.input_tokens += tin
        self.output_tokens += tout
        self.cache_write_tokens += cache_write
        self.cache_read_tokens += cache_read
        self.batch_calls += int(batch)
        cost = call_cost(model, tin, tout, cache_write, cache_read, batch, cache_write_1h) if model else 0.0
        self.cost_usd += cost
        s = self.by_step.setdefault(step or "other", {"calls": 0, "in": 0, "out": 0, "cache_w": 0, "cache_r": 0, "usd": 0.0})
        s["calls"] += 1
        s["in"] += tin
        s["out"] += tout
        s["cache_w"] += cache_write
        s["cache_r"] += cache_read
        s["usd"] += cost

    @property
    def total_input(self) -> int:
        return self.input_tokens + self.cache_write_tokens + self.cache_read_tokens


current_meter: contextvars.ContextVar[UsageMeter | None] = contextvars.ContextVar("zm_meter", default=None)
# Name of the Graphiti prompt being run ("extract_edges.edge", ...), or our own step ("zm.review").
current_step: contextvars.ContextVar[str] = contextvars.ContextVar("zm_step", default="")


def _meter_before_call(estimated_tokens: int) -> None:
    """Raises quotas.QuotaExceeded when the company's monthly token quota cannot cover this call."""
    meter = current_meter.get()
    if meter is not None:
        meter.before_call(estimated_tokens)


def _meter_add(tin: int, tout: int, **kw: typing.Any) -> None:
    meter = current_meter.get()
    if meter is not None:
        meter.add(tin, tout, step=kw.pop("step", None) or current_step.get(), **kw)


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def parse_json(text: str) -> dict[str, typing.Any]:
    text = _FENCE.sub("", text.strip()).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def estimate_tokens(text: str) -> int:
    # Romanian/JSON prompts run ~3.2 characters per token on Claude; err on the high side.
    return int(len(text) / 3.0) + 1


def guard_input(system: str, messages: list[dict], limit: int = GUARD_TARGET) -> tuple[str, list[dict], bool]:
    """Trim the longest text in the middle until the estimated prompt fits `limit` tokens."""

    def size(c: typing.Any) -> int:
        return len(c) if isinstance(c, str) else 0

    def total() -> int:
        return estimate_tokens(system) + sum(estimate_tokens(m["content"]) for m in messages if isinstance(m["content"], str))

    if total() <= limit:
        return system, messages, False
    messages = [dict(m) for m in messages]
    marker = "\n[... trimmed to stay under the input-token limit ...]\n"
    for _ in range(8):
        over = total() - limit
        if over <= 0:
            break
        idx = max(range(len(messages)), key=lambda i: size(messages[i]["content"]))
        if len(system) > size(messages[idx]["content"]):
            cut = min(len(system) - 2000, over * 3 + 2000)
            if cut <= 0:
                break
            half = (len(system) - cut) // 2
            system = system[:half] + marker + system[-half:]
            continue
        content = messages[idx]["content"]
        cut = min(len(content) - 2000, over * 3 + 2000)
        if cut <= 0:
            break
        half = (len(content) - cut) // 2
        messages[idx]["content"] = content[:half] + marker + content[-half:]
    return system, messages, True


_TAGGED = re.compile(r'<([A-Z][A-Z0-9_]*(?: [A-Z][A-Z0-9_]*)*)(?: [a-z_]+="[^"]*")*>.*?</\1>', re.DOTALL)
# Tagged blocks that are the same on every call (Graphiti's worked examples and our fixed type
# lists): they go to the cached system prompt with the instructions, not to the user message.
STATIC_TAGS = {"EXAMPLE", "ENTITY TYPES", "FACT_TYPES"}


def cache_layout(system: str, convo: list[dict]) -> tuple[str, list[dict]]:
    """Move the static instructions of a Graphiti prompt into the (cached) system prompt.

    Graphiti puts the episode data first and its long instructions after it, in the user
    message, so nothing is cacheable. Its data always sits in <TAGGED> blocks; the text outside
    them is the same on every call. We keep the tagged blocks in the user message, in order, and
    append the remaining text to the system prompt.
    """
    if len(convo) != 1 or not isinstance(convo[0].get("content"), str):
        return system, convo
    content = convo[0]["content"]
    matches = list(_TAGGED.finditer(content))
    blocks = [m.group(0) for m in matches if m.group(1) not in STATIC_TAGS]
    fixed = [m.group(0) for m in matches if m.group(1) in STATIC_TAGS]
    if not blocks:
        return system, convo
    static = re.sub(r"\n{3,}", "\n\n", _TAGGED.sub(lambda m: "" if m.group(1) not in STATIC_TAGS else m.group(0), content)).strip()
    if len(static) - sum(len(f) for f in fixed) < 400:
        return system, convo
    system = (
        system + "\n\n# INSTRUCTIONS (the data they refer to is in the tagged sections of the user message)\n\n" + static
    )
    return system, [{"role": "user", "content": "\n\n".join(blocks)}]


class TextLLM(typing.Protocol):
    """Minimal interface used by the novelty gate and the review step."""

    model_name: str

    async def complete_json(self, system: str, user: str, max_tokens: int = 300, *, step: str = "") -> dict[str, typing.Any]: ...


class _BatchDispatcher:
    """Collects Messages requests for a short window and sends them as one Message Batch.

    Each waiting caller gets its own result; a request the batch cannot serve (errored,
    expired, or the batch takes longer than `max_wait`) falls back to a normal call.
    """

    def __init__(self, client: typing.Any, window: float, poll: float, max_wait: float, max_size: int = 200):
        self.client = client
        self.window = window
        self.poll = poll
        self.max_wait = max_wait
        self.max_size = max_size
        self.pending: list[tuple[str, dict, asyncio.Future]] = []
        self._flusher: asyncio.Task | None = None
        self._tasks: set[asyncio.Task] = set()
        self.batches_sent = 0

    async def submit(self, params: dict) -> typing.Any:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending.append(("r" + uuid.uuid4().hex[:24], params, fut))
        if len(self.pending) >= self.max_size:
            self._flush_now()
        elif self._flusher is None or self._flusher.done():
            self._flusher = asyncio.create_task(self._flush_later())
        return await fut

    async def _flush_later(self) -> None:
        await asyncio.sleep(self.window)
        self._flush_now()

    def _flush_now(self) -> None:
        items, self.pending = self.pending, []
        if items:
            t = asyncio.create_task(self._run(items))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)

    async def _run(self, items: list[tuple[str, dict, asyncio.Future]]) -> None:
        by_id = {cid: fut for cid, _, fut in items}
        try:
            batch = await self.client.messages.batches.create(
                requests=[{"custom_id": cid, "params": p} for cid, p, _ in items]
            )
            self.batches_sent += 1
            t0 = time.monotonic()
            while True:
                await asyncio.sleep(self.poll)
                b = await self.client.messages.batches.retrieve(batch.id)
                if b.processing_status == "ended":
                    break
                if time.monotonic() - t0 > self.max_wait:
                    log.warning("batch %s still running after %.0fs; cancelling, falling back to direct calls", batch.id, self.max_wait)
                    await self.client.messages.batches.cancel(batch.id)
                    raise TimeoutError("batch too slow")
            log.info("batch %s: %d requests in %.1fs", batch.id, len(items), time.monotonic() - t0)
            async for r in await self.client.messages.batches.results(batch.id):
                fut = by_id.pop(r.custom_id, None)
                if fut is None or fut.done():
                    continue
                if r.result.type == "succeeded":
                    fut.set_result(r.result.message)
                else:
                    fut.set_exception(RuntimeError(f"batch request {r.result.type}"))
        except Exception as e:  # whole batch failed: let every caller fall back
            for fut in by_id.values():
                if not fut.done():
                    fut.set_exception(RuntimeError(f"batch failed: {type(e).__name__}: {e}"))
            return
        for fut in by_id.values():
            if not fut.done():
                fut.set_exception(RuntimeError("batch result missing"))


class AnthropicLLM(LLMClient):
    def __init__(
        self,
        api_key: str,
        model: str,
        effort: str = "low",
        *,
        prompt_cache: bool = True,
        cache_ttl: str = "5m",
        batch: bool = False,
        batch_window: float = 5.0,
        batch_poll: float = 10.0,
        batch_max_wait: float = 1800.0,
        step_models: dict[str, str] | None = None,
    ):
        super().__init__(LLMConfig(api_key=api_key, model=model, small_model=model), cache=False)
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=3)
        self.model_name = model
        self.effort = effort
        self.prompt_cache = prompt_cache
        # "1h": the fixed system prompts (the same for every company) stay cached across the gaps
        # between one person's conversations; a write costs 2x instead of 1.25x, a read 0.1x.
        self.cache_ttl = cache_ttl if cache_ttl in ("5m", "1h") else "5m"
        self.step_models = step_models or {}
        self.batcher = _BatchDispatcher(self._client, batch_window, batch_poll, batch_max_wait) if batch else None

    def _params(self, model: str, system: str, messages: list[dict], max_tokens: int) -> dict:
        sys_block: dict[str, typing.Any] = {"type": "text", "text": system}
        if self.prompt_cache:
            sys_block["cache_control"] = {"type": "ephemeral", "ttl": "1h"} if self.cache_ttl == "1h" else {"type": "ephemeral"}
        return {
            "model": model,
            "max_tokens": max_tokens,
            "system": [sys_block],
            "messages": messages,
            "output_config": {"effort": self.effort},
            # Extraction is a structured, well-specified task: no thinking, low effort.
            # Sonnet 5.5 rejects {"type": "disabled"}; "between_tools" is its thinking-off mode.
            "thinking": {"type": "between_tools"} if model.startswith("claude-sonnet-5-5") else {"type": "disabled"},
        }

    async def _call(self, system: str, messages: list[dict], max_tokens: int, *, step: str = "", allow_batch: bool = False) -> str:
        a = self._anthropic
        step = step or current_step.get()
        model = self.step_models.get(step, self.model_name)
        system, messages, trimmed = guard_input(system, messages)
        if trimmed:
            log.warning("input-token guard: trimmed the prompt for step %s to stay under %d tokens", step or "?", INPUT_TOKEN_GUARD)
            meter = current_meter.get()
            if meter is not None:
                meter.guard_trims += 1
        _meter_before_call(
            estimate_tokens(system + "".join(m["content"] if isinstance(m.get("content"), str) else json.dumps(m.get("content"), ensure_ascii=False)
                                             for m in messages))
            + min(max_tokens, 2000)
        )
        params = self._params(model, system, messages, max_tokens)
        resp = None
        used_batch = False
        if allow_batch and self.batcher is not None:
            try:
                resp = await self.batcher.submit(params)
                used_batch = True
            except Exception as e:
                log.warning("batch path failed for step %s (%s); calling directly", step or "?", e)
        if resp is None:
            try:
                resp = await self._client.messages.create(**params)
            except a.RateLimitError as e:
                raise RateLimitError(str(e)) from e
        u = resp.usage
        cw = getattr(u, "cache_creation_input_tokens", 0) or 0
        cr = getattr(u, "cache_read_input_tokens", 0) or 0
        breakdown = getattr(u, "cache_creation", None)
        cw_1h = getattr(breakdown, "ephemeral_1h_input_tokens", None)
        if cw_1h is None:  # no breakdown: everything was written with the TTL we asked for
            cw_1h = cw if self.cache_ttl == "1h" else 0
        if (u.input_tokens or 0) + cw + cr > INPUT_TOKEN_GUARD:
            log.error("input-token guard missed: step %s used %d input tokens", step or "?", (u.input_tokens or 0) + cw + cr)
        _meter_add(u.input_tokens or 0, u.output_tokens or 0, model=model, step=step, cache_write=cw, cache_read=cr,
                   batch=used_batch, cache_write_1h=cw_1h or 0)
        if resp.stop_reason == "refusal":
            raise RefusalError("model refused the request")
        if resp.stop_reason == "max_tokens":
            raise ValueError(f"output truncated at max_tokens={max_tokens}")
        return "".join(b.text for b in resp.content if b.type == "text")

    async def complete_json(self, system: str, user: str, max_tokens: int = 300, *, step: str = "") -> dict[str, typing.Any]:
        text = await self._call(system, [{"role": "user", "content": user}], max_tokens, step=step)
        return parse_json(text)

    async def generate_response(self, messages: list[Message], *args: typing.Any, **kwargs: typing.Any) -> dict[str, typing.Any]:
        prompt_name = kwargs.get("prompt_name") or (args[4] if len(args) > 4 else None)
        token = current_step.set(prompt_name or "graphiti")
        try:
            return await super().generate_response(messages, *args, **kwargs)
        finally:
            current_step.reset(token)

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type[BaseModel] | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        model_size: ModelSize = ModelSize.medium,
        *,
        model: str | None = None,
    ) -> dict[str, typing.Any]:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        convo = [{"role": m.role, "content": m.content} for m in messages if m.role != "system"]
        if not convo:
            convo = [{"role": "user", "content": "Respond now."}]
        if self.prompt_cache:
            system, convo = cache_layout(system, convo)
        system += "\n\nReply with a single valid JSON object and nothing else."
        max_tokens = min(max_tokens or DEFAULT_MAX_TOKENS, 16000)

        last_error: Exception | None = None
        for attempt in range(2):
            # Graphiti's own calls may go through the batch queue; the JSON-repair retry goes direct.
            text = await self._call(system, convo, max_tokens, allow_batch=attempt == 0)
            try:
                data = parse_json(text)
                if response_model is not None:
                    response_model.model_validate(data)
                return data
            except (json.JSONDecodeError, ValidationError) as e:
                last_error = e
                log.warning("invalid JSON from model (attempt %d): %s", attempt + 1, str(e)[:200])
                convo = convo + [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": f"That was not valid for the schema: {str(e)[:500]}. Reply again with only the corrected JSON object."},
                ]
        raise ValueError(f"model did not return valid JSON: {last_error}")


class FakeLLM(LLMClient):
    """Offline stand-in. The novelty gate uses simple keyword rules; graph extraction is not
    supported (tests seed the graph directly), so calling it through Graphiti raises."""

    model_name = "fake"
    SIGNALS = (
        "hotărât", "hotarat", "decis", "decizie", "promis", "promisiune", "până pe", "pana pe",
        "termen", "preț", "pret", "contract", "furnizor", "am convenit", "schimbăm", "schimbam",
        "decided", "promised", "deadline", "price",
    )

    def __init__(self) -> None:
        super().__init__(LLMConfig(api_key="fake", model="fake"), cache=False)

    async def complete_json(self, system: str, user: str, max_tokens: int = 300, *, step: str = "") -> dict[str, typing.Any]:
        _meter_before_call(len(system + user) // 4 + 20)
        _meter_add(len(system + user) // 4, 20, step=step or "gate")
        if step == "split":
            return self._split(user)
        low = user.lower()
        hits = [s for s in self.SIGNALS if s in low]
        if hits:
            return {"new_information": True, "kinds": ["decision"], "reason": f"signals: {', '.join(hits[:3])}"}
        return {"new_information": False, "kinds": [], "reason": "no decision, promise or new fact"}

    SPLIT_RULES = {
        "personal": ("prefer", "vreau ", "vrea ", "îmi place", "imi place", "pentru mine"),
        "personal_decisions": ("mi-am propus", "am decis pentru mine"),
        "rules": ("de acum", "întotdeauna", "intotdeauna", "nu mai trimite", "ignoră", "ignore"),
        "external": ("[extern", "e-mail", "email", "pagina web", "site-ul", "documentul primit", "ignore previous"),
        "sensitive": ("salariu", "salariul", "medical", "diagnostic", "avertisment", "disciplinar", "concediere"),
    }

    def _split(self, user: str) -> dict[str, typing.Any]:
        import re as _re

        out: dict[str, list[int]] = {k: [] for k in self.SPLIT_RULES}
        for m in _re.finditer(r"^(\d+)\. (.*)$", user, _re.M):
            i, low = int(m.group(1)), m.group(2).lower()
            for k, words in self.SPLIT_RULES.items():
                if any(w in low for w in words):
                    out[k].append(i)
        return out

    async def _generate_response(self, *args, **kwargs) -> dict[str, typing.Any]:  # pragma: no cover
        raise NotImplementedError("FakeLLM cannot run Graphiti extraction; use LLM_PROVIDER=anthropic")
