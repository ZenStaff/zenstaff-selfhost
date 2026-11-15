"""Hosted release (2026-11-08): one key per member machine (issued by the hub, revoked one by one)
and the Cloudflare Workers AI embedder."""

from __future__ import annotations

import json

import httpx
import pytest

from app.embedder import CloudflareEmbedder

from .conftest import ADMIN

pytestmark = pytest.mark.asyncio
ADM = {"Authorization": f"Bearer {ADMIN}"}


async def test_key_ids_list_and_single_revoke(env):
    a, ha = await env.company("Firma A")
    b, hb = await env.company("Firma B")
    r1 = (await env.client.post(f"/admin/companies/{a['id']}/keys", headers=ADM)).json()
    r2 = (await env.client.post(f"/admin/companies/{a['id']}/keys", headers=ADM)).json()
    assert r1["key_id"].startswith("k_") and r1["key_id"] != r2["key_id"]
    k1 = {"Authorization": f"Bearer {r1['api_key']}"}
    k2 = {"Authorization": f"Bearer {r2['api_key']}"}
    assert (await env.client.get("/v1/me", headers=k1)).status_code == 200

    keys = (await env.client.get(f"/admin/companies/{a['id']}/keys", headers=ADM)).json()["keys"]
    assert {k["key_id"] for k in keys} >= {r1["key_id"], r2["key_id"]}
    assert all("api_key" not in k and "key_hash" not in k for k in keys)

    # Another company's key id is not revoked through this company.
    rb = (await env.client.post(f"/admin/companies/{b['id']}/keys", headers=ADM)).json()
    other = await env.client.delete(f"/admin/companies/{a['id']}/keys/{rb['key_id']}", headers=ADM)
    assert other.json()["revoked"] == 0
    assert (await env.client.get("/v1/me", headers={"Authorization": f"Bearer {rb['api_key']}"})).status_code == 200

    gone = await env.client.delete(f"/admin/companies/{a['id']}/keys/{r1['key_id']}", headers=ADM)
    assert gone.json()["revoked"] == 1
    assert (await env.client.get("/v1/me", headers=k1)).status_code == 401
    assert (await env.client.get("/v1/me", headers=k2)).status_code == 200
    assert (await env.client.get("/v1/me", headers=ha)).status_code == 200
    # Company callers cannot reach the key admin routes.
    assert (await env.client.get(f"/admin/companies/{a['id']}/keys", headers=k2)).status_code == 401
    assert (await env.client.delete(f"/admin/companies/{a['id']}/keys/{r2['key_id']}", headers=ha)).status_code == 401
    assert (await env.client.get("/admin/companies/co_nope/keys", headers=ADM)).status_code == 404


def _cf_transport(seen: list, fail_first: int = 0, dim: int = 1024):
    state = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        seen.append(request)
        if state["n"] <= fail_first:
            return httpx.Response(503, json={"success": False})
        body = json.loads(request.content)
        texts = body["text"]
        return httpx.Response(200, json={"success": True, "result": {
            "shape": [len(texts), dim], "data": [[float(i + 1)] * dim for i in range(len(texts))],
            "usage": {"prompt_tokens": 7 * len(texts)}}})

    return httpx.MockTransport(handler)


async def test_cloudflare_embedder_batches_retries_counts_and_caches_ping():
    seen: list = []
    emb = CloudflareEmbedder("a" * 32, "tok", "@cf/qwen/qwen3-embedding-0.6b", 1024,
                             transport=_cf_transport(seen, fail_first=1))
    vecs = await emb.create_batch([f"text {i}" for i in range(40)])
    assert len(vecs) == 40 and all(len(v) == 1024 for v in vecs)
    # 503 once, then two chunks (32 + 8)
    assert len(seen) == 3
    assert seen[0].url.path.endswith("/accounts/" + "a" * 32 + "/ai/run/@cf/qwen/qwen3-embedding-0.6b")
    assert seen[0].headers["authorization"] == "Bearer tok"
    assert emb.usage["calls"] == 2 and emb.usage["texts"] == 40 and emb.usage["input_tokens"] == 280

    assert await emb.ping() is True
    n = len(seen)
    assert await emb.ping() is True
    assert len(seen) == n  # cached


async def test_cloudflare_embedder_refuses_wrong_dimensions_and_missing_config():
    emb = CloudflareEmbedder("a" * 32, "tok", "m", 1024, transport=_cf_transport([], dim=768))
    with pytest.raises(RuntimeError):
        await emb.create("x")
    assert await emb.ping() is False
    with pytest.raises(ValueError):
        CloudflareEmbedder("", "", "m", 1024)
