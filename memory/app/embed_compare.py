"""Compare the local TEI embedder with Cloudflare Workers AI on Romanian samples (cosine per text).

Run inside the API container (it reaches the local embedder on the compose network and reads
CF_AI_ACCOUNT_ID / CF_AI_API_TOKEN from its environment): `scripts/zm-admin embed-compare`.
Before switching EMBEDDER_PROVIDER to cloudflare the cosines must be ~1.0 (same model, same
vectors), otherwise existing facts would need re-embedding. Prints no credentials.
"""

from __future__ import annotations

import asyncio
import math
import os
import sys

from .embedder import CloudflareEmbedder, LocalEmbedder

SAMPLES = [
    "Ioana a hotărât ca din 1 aprilie să cumpărăm făina de la Moara Verde, la 3,25 lei/kg.",
    "I-am promis clientului Hotel Arcadia livrarea a 40 de porții până joi la ora 7.",
    "Instruct: Given a question about a company's business, retrieve the facts that answer it\nQuery: Ce am promis clientului Bistro Lavanda?",
    "Programul de vară: luni–vineri 8–22, sâmbătă 9–23, duminică închis.",
    "Contractul cu furnizorul de ambalaje nu se mai reînnoiește din ianuarie 2027.",
]


def cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


async def main() -> int:
    dim = int(os.environ.get("EMBEDDING_DIM", "1024"))
    local = LocalEmbedder(os.environ.get("EMBEDDER_URL", "http://embedder:80/v1"),
                          os.environ.get("EMBEDDER_MODEL", "Qwen/Qwen3-Embedding-0.6B"), dim)
    cf = CloudflareEmbedder(os.environ.get("CF_AI_ACCOUNT_ID", ""), os.environ.get("CF_AI_API_TOKEN", ""),
                            os.environ.get("CF_EMBED_MODEL", "@cf/qwen/qwen3-embedding-0.6b"), dim)
    a = await local.create_batch(SAMPLES)
    b = await cf.create_batch(SAMPLES)
    worst = 1.0
    for text, x, y in zip(SAMPLES, a, b):
        c = cos(x, y)
        worst = min(worst, c)
        print(f"{c:.5f}  {text[:70]!r}")
    print(f"min cosine {worst:.5f}; workers ai usage {cf.usage}")
    return 0 if worst >= 0.999 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
