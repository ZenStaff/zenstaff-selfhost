"""Embedding adapters for Graphiti.

`LocalEmbedder` talks to any OpenAI-compatible `/v1/embeddings` endpoint. In the self-host compose
it is a Hugging Face text-embeddings-inference (TEI) container serving a multilingual model
(profile `local-embedder`), so embeddings cost nothing per call. `CloudflareEmbedder` runs the
same model (Qwen3-Embedding-0.6B, identical vectors) on Cloudflare Workers AI; our hosted stack
uses it since 2026-11-08, so the hosted server does not keep a ~3.5 GB embedder running. `FakeEmbedder` is a
deterministic hash embedding for tests.
"""

from __future__ import annotations

import hashlib
import logging
import math
import time
from collections.abc import Iterable

import httpx
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.embedder.client import EmbedderClient


class LocalEmbedder(EmbedderClient):
    def __init__(self, base_url: str, model: str, dim: int, api_key: str = "none"):
        self.url = base_url.rstrip("/") + "/embeddings"
        self.model = model
        self.dim = dim
        self._http = httpx.AsyncClient(timeout=60, headers={"Authorization": f"Bearer {api_key}"})

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 32):
            r = await self._http.post(self.url, json={"model": self.model, "input": texts[i : i + 32]})
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            out.extend(d["embedding"][: self.dim] for d in data)
        return out

    async def create(self, input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]]) -> list[float]:
        text = input_data if isinstance(input_data, str) else str(list(input_data)[0])
        return (await self._embed([text]))[0]

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return await self._embed(input_data_list) if input_data_list else []

    async def ping(self) -> bool:
        try:
            await self.create("ping")
            return True
        except Exception:
            return False


log = logging.getLogger("zen-memory.embedder")


class CloudflareEmbedder(EmbedderClient):
    """Workers AI (`POST /accounts/{id}/ai/run/{model}` with `{"text": [...]}`).

    The health check calls `ping()` every 15 s; the result is cached (`ping_ttl`) so that does not
    turn into ~6,000 Workers AI calls a day. Usage (calls, texts, input tokens) is counted per UTC
    day and logged every `log_every` calls and at the day's end, because the free daily neurons are
    shared with other apps on the same account.
    """

    API = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"

    def __init__(self, account_id: str, token: str, model: str, dim: int, *, timeout: float = 30,
                 ping_ttl: float = 300, log_every: int = 200, transport: httpx.AsyncBaseTransport | None = None):
        if not account_id or not token:
            raise ValueError("EMBEDDER_PROVIDER=cloudflare needs CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN")
        self.url = self.API.format(account=account_id, model=model)
        self.model = model
        self.dim = dim
        self.ping_ttl = ping_ttl
        self.log_every = log_every
        self._http = httpx.AsyncClient(timeout=timeout, headers={"Authorization": f"Bearer {token}"}, transport=transport)
        self._ping: tuple[float, bool] | None = None
        self.usage = {"day": time.strftime("%Y-%m-%d", time.gmtime()), "calls": 0, "texts": 0, "input_tokens": 0}

    def _count(self, texts: list[str], tokens: int | None) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime())
        if day != self.usage["day"]:
            log.info("cloudflare embeddings usage %s: %s", self.usage["day"], self.usage)
            self.usage = {"day": day, "calls": 0, "texts": 0, "input_tokens": 0}
        self.usage["calls"] += 1
        self.usage["texts"] += len(texts)
        self.usage["input_tokens"] += tokens if tokens is not None else sum(len(t) for t in texts) // 4 + 1
        if self.usage["calls"] % self.log_every == 0:
            log.info("cloudflare embeddings usage so far %s: %s", day, self.usage)

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 32):
            chunk = texts[i : i + 32]
            last: Exception | None = None
            for attempt in range(3):
                try:
                    r = await self._http.post(self.url, json={"text": chunk})
                    if r.status_code in (429, 500, 502, 503, 504):
                        raise httpx.HTTPStatusError(f"workers ai {r.status_code}", request=r.request, response=r)
                    r.raise_for_status()
                    body = r.json()
                    if body.get("success") is False or "result" not in body:
                        raise RuntimeError(f"workers ai error: {str(body.get('errors'))[:200]}")
                    result = body["result"]
                    vectors = result.get("data") or []
                    if len(vectors) != len(chunk):
                        raise RuntimeError(f"workers ai: {len(vectors)} vectors for {len(chunk)} texts")
                    for v in vectors:
                        if len(v) < self.dim:
                            raise RuntimeError(f"workers ai: {len(v)} dimensions, expected {self.dim}")
                    self._count(chunk, (result.get("usage") or {}).get("prompt_tokens"))
                    out.extend(v[: self.dim] for v in vectors)
                    break
                except (httpx.TransportError, httpx.HTTPStatusError) as e:
                    last = e
                    if isinstance(e, httpx.HTTPStatusError) and e.response.status_code not in (429, 500, 502, 503, 504):
                        raise
                    await _sleep(0.5 * (2 ** attempt))
            else:
                raise RuntimeError(f"workers ai unavailable: {last}")
        return out

    async def create(self, input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]]) -> list[float]:
        text = input_data if isinstance(input_data, str) else str(list(input_data)[0])
        return (await self._embed([text]))[0]

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return await self._embed(input_data_list) if input_data_list else []

    async def ping(self) -> bool:
        now = time.monotonic()
        if self._ping is not None and now - self._ping[0] < self.ping_ttl:
            return self._ping[1]
        try:
            await self.create("ping")
            ok = True
        except Exception as e:  # noqa: BLE001
            log.warning("cloudflare embeddings ping failed: %s", type(e).__name__)
            ok = False
        self._ping = (now, ok)
        return ok


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


class FakeEmbedder(EmbedderClient):
    """Bag-of-words hashing: texts sharing words get similar vectors. Good enough for tests."""

    def __init__(self, dim: int = 1024):
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for word in text.lower().split():
            h = int(hashlib.md5(word.strip(".,;:!?\"'()").encode()).hexdigest(), 16)
            v[h % self.dim] += 1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    async def create(self, input_data) -> list[float]:  # type: ignore[override]
        return self._vec(input_data if isinstance(input_data, str) else str(input_data))

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in input_data_list]

    async def ping(self) -> bool:
        return True


class NoRerank(CrossEncoderClient):
    """We search with reciprocal-rank fusion, so no reranker (and no extra LLM cost)."""

    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        n = len(passages)
        return [(p, 1.0 - i / max(n, 1)) for i, p in enumerate(passages)]
