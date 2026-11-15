"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


def _float(name: str, default: float) -> float:
    raw = _env(name)
    return float(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # Tenancy: "multi" (one stack, many companies) or "single" (one company, e.g. enterprise / self-host).
    tenancy: str = field(default_factory=lambda: _env("TENANCY", "multi"))
    single_tenant_name: str = field(default_factory=lambda: _env("SINGLE_TENANT_NAME", "Compania mea"))
    single_tenant_api_key: str = field(default_factory=lambda: _env("SINGLE_TENANT_API_KEY"))

    admin_token: str = field(default_factory=lambda: _env("ADMIN_TOKEN"))
    data_dir: str = field(default_factory=lambda: _env("DATA_DIR", "/data"))

    neo4j_uri: str = field(default_factory=lambda: _env("NEO4J_URI", "bolt://neo4j:7687"))
    neo4j_user: str = field(default_factory=lambda: _env("NEO4J_USER", "neo4j"))
    neo4j_password: str = field(default_factory=lambda: _env("NEO4J_PASSWORD"))

    # LLM: "anthropic" (production) or "fake" (tests / dry runs, no network, no cost).
    llm_provider: str = field(default_factory=lambda: _env("LLM_PROVIDER", "anthropic"))
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL", "claude-haiku-5-5"))
    # Cost controls (see llm.py): prompt caching, Message Batches for Graphiti's calls, per-step models.
    llm_prompt_cache: bool = field(default_factory=lambda: _env("LLM_PROMPT_CACHE", "on") != "off")
    # Prompt-cache lifetime: "1h" (default) or "5m". See llm.AnthropicLLM.
    llm_cache_ttl: str = field(default_factory=lambda: _env("LLM_CACHE_TTL", "1h"))
    llm_batch: bool = field(default_factory=lambda: _env("LLM_BATCH", "off") == "on")
    llm_batch_window_s: float = field(default_factory=lambda: _float("LLM_BATCH_WINDOW_S", 5.0))
    llm_batch_poll_s: float = field(default_factory=lambda: _float("LLM_BATCH_POLL_S", 10.0))
    llm_batch_max_wait_s: float = field(default_factory=lambda: _float("LLM_BATCH_MAX_WAIT_S", 1800.0))
    # "step=model,step=model", e.g. "dedupe_edges.resolve_edge=claude-sonnet-5-5".
    llm_step_models: str = field(default_factory=lambda: _env("LLM_STEP_MODELS"))
    # "v2" = our ontology, prompts and post-extraction review; "baseline" = v1 behaviour (eval only).
    extraction_profile: str = field(default_factory=lambda: _env("EXTRACTION_PROFILE", "v2"))
    # USD per 1M tokens, used only for the cost estimate in /admin/usage.
    llm_price_in: float = field(default_factory=lambda: _float("LLM_PRICE_IN_PER_MTOK", 0.10))
    llm_price_out: float = field(default_factory=lambda: _float("LLM_PRICE_OUT_PER_MTOK", 0.50))

    # Embeddings: "openai" = any OpenAI-compatible /v1/embeddings endpoint (our local TEI container),
    # or "fake" for tests.
    embedder_provider: str = field(default_factory=lambda: _env("EMBEDDER_PROVIDER", "openai"))
    embedder_url: str = field(default_factory=lambda: _env("EMBEDDER_URL", "http://embedder:80/v1"))
    embedder_model: str = field(default_factory=lambda: _env("EMBEDDER_MODEL", "Qwen/Qwen3-Embedding-0.6B"))
    embedder_api_key: str = field(default_factory=lambda: _env("EMBEDDER_API_KEY", "none"))
    # EMBEDDER_PROVIDER=cloudflare: the same Qwen3-Embedding-0.6B on Workers AI (hosted stack).
    cf_ai_account_id: str = field(default_factory=lambda: _env("CF_AI_ACCOUNT_ID"))
    cf_ai_api_token: str = field(default_factory=lambda: _env("CF_AI_API_TOKEN"))
    cf_embed_model: str = field(default_factory=lambda: _env("CF_EMBED_MODEL", "@cf/qwen/qwen3-embedding-0.6b"))
    embedding_dim: int = field(default_factory=lambda: _int("EMBEDDING_DIM", 1024))

    # Ingest controls.
    novelty_gate: bool = field(default_factory=lambda: _env("NOVELTY_GATE", "on") != "off")
    min_summary_chars: int = field(default_factory=lambda: _int("MIN_SUMMARY_CHARS", 40))
    max_summary_chars: int = field(default_factory=lambda: _int("MAX_SUMMARY_CHARS", 12000))
    ingest_concurrency: int = field(default_factory=lambda: _int("INGEST_CONCURRENCY", 3))
    # Ingest cost (measured with eval/growth.py, see README "Cost per conversation"):
    # earlier episodes sent to extraction as context (Graphiti sends the last 10, whole), and how
    # many characters of each; "batched" resolves all new facts of an episode against the stored
    # ones in ONE call (Graphiti: up to two calls per fact), with only facts that share an entity
    # as contradiction candidates; "graphiti" = the stock per-fact resolution.
    previous_episodes: int = field(default_factory=lambda: _int("PREVIOUS_EPISODES", 3))
    previous_episode_chars: int = field(default_factory=lambda: _int("PREVIOUS_EPISODE_CHARS", 1200))
    edge_resolve_mode: str = field(default_factory=lambda: _env("EDGE_RESOLVE_MODE", "batched"))
    edge_candidates: int = field(default_factory=lambda: _int("EDGE_INVALIDATION_CANDIDATES", 8))
    # Episodes stopped by the monthly token quota wait as "deferred" and are re-queued when the
    # month resets or the limit is raised; checked every QUOTA_RETRY_INTERVAL_S seconds.
    quota_retry_interval_s: int = field(default_factory=lambda: _int("QUOTA_RETRY_INTERVAL_S", 600))

    # Per-company quotas (defaults; override per company with PUT /admin/companies/{id}/limits).
    # 0 = unlimited. Tokens = every LLM token billed to the company (gate + extraction).
    quota_episodes_per_day: int = field(default_factory=lambda: _int("QUOTA_EPISODES_PER_DAY", 500))
    quota_ingest_tokens_per_month: int = field(default_factory=lambda: _int("QUOTA_INGEST_TOKENS_PER_MONTH", 30_000_000))
    quota_searches_per_minute: int = field(default_factory=lambda: _int("QUOTA_SEARCHES_PER_MINUTE", 120))
    # Per-person quotas (personal memory spaces; same override API under /admin/persons/{id}/limits).
    quota_person_episodes_per_day: int = field(default_factory=lambda: _int("QUOTA_PERSON_EPISODES_PER_DAY", 100))
    quota_person_ingest_tokens_per_month: int = field(default_factory=lambda: _int("QUOTA_PERSON_INGEST_TOKENS_PER_MONTH", 3_000_000))
    quota_person_searches_per_minute: int = field(default_factory=lambda: _int("QUOTA_PERSON_SEARCHES_PER_MINUTE", 60))
    # Split of a company chat into company and personal parts (one Haiku call; off = all to the company).
    personal_split: bool = field(default_factory=lambda: _env("PERSONAL_SPLIT", "on").lower() != "off")
    # Tokens reserved per accepted summary until its ingest settles (plus 5x the summary's own
    # estimated tokens); a running ingest extends its reservation while the month has room.
    quota_ingest_estimate_tokens: int = field(default_factory=lambda: _int("QUOTA_INGEST_ESTIMATE_TOKENS", 20_000))
    # Budget mode: once a space has used this % of its monthly token quota, only summaries the gate
    # marks as a decision, promise, price or change are ingested (plain facts are skipped), so the
    # quota lasts the month. 0 = off.
    quota_essential_only_percent: int = field(default_factory=lambda: _int("QUOTA_ESSENTIAL_ONLY_PERCENT", 0))
    # Optional: POSTed a JSON alert when a company crosses 80% / 100% of its monthly token quota.
    quota_alert_webhook_url: str = field(default_factory=lambda: _env("QUOTA_ALERT_WEBHOOK_URL"))
    # "json" (the alert object) or "subject-body" ({"subject","body"}: our zz-notify mail Worker)
    quota_alert_webhook_format: str = field(default_factory=lambda: _env("QUOTA_ALERT_WEBHOOK_FORMAT", "json"))

    # Audit log: clients behind these proxies (CIDRs, comma-separated) are logged with their
    # X-Forwarded-For address; empty = log the peer address. Anchor = head hash to the service
    # log every N rows.
    audit_trusted_proxies: str = field(default_factory=lambda: _env("AUDIT_TRUSTED_PROXIES"))
    audit_anchor_every: int = field(default_factory=lambda: _int("AUDIT_ANCHOR_EVERY", 1000))
    # Encryption at rest needs ZM_MASTER_KEYS (crypto.py). "required" refuses to start without it.
    encryption: str = field(default_factory=lambda: _env("ENCRYPTION", "auto"))

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "zen-memory.sqlite3")

    @property
    def keys_path(self) -> str:
        return os.path.join(self.data_dir, "keys.sqlite3")

    @property
    def audit_path(self) -> str:
        return os.path.join(self.data_dir, "audit.sqlite3")


settings = Settings()
