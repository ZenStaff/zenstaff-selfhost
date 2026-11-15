"""The only module that knows about Graphiti and Neo4j.

Every public method takes the caller's `group_id` as its first argument, and every Cypher query
goes through `scope.scoped_query`, which refuses a query that is not limited to that group (see
scope.py; tests/test_cypher_scope.py checks every query string statically too). Swapping the
engine later means re-implementing this one class.

Encryption: `ZenBase` encrypts the episode's raw text (content, name, source description) with
the company's data key before Graphiti saves it, and decrypts previous episodes when Graphiti
reads them back as extraction context, so the plaintext never reaches the graph store while
extraction sees exactly what it saw before. The cipher comes from `crypto.current_cipher`.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any

from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType
from graphiti_core.search.search_config_recipes import COMBINED_HYBRID_SEARCH_RRF

from .crypto import PLAINTEXT, CompanyCipher, current_cipher
from .dates import calendar_hint
from .names import NameMatcher
from .ontology import (
    EDGE_TYPE_MAP,
    EDGE_TYPE_MAP_V2,
    EDGE_TYPES,
    EDGE_TYPES_V2,
    ENTITY_TYPES,
    ENTITY_TYPES_V2,
    EXTRACTION_INSTRUCTIONS,
    EXTRACTION_INSTRUCTIONS_V2,
)

from .scope import only_group, scoped_query

log = logging.getLogger("zen-memory.engine")

# Purpose labels bound into the ciphertext of the episode fields stored in the graph.
EPISODE_FIELDS = {"content": "graph.episode.content", "name": "graph.episode.name",
                  "source_description": "graph.episode.source"}


def encrypt_episode(ep, cipher: CompanyCipher) -> None:
    for attr, purpose in EPISODE_FIELDS.items():
        v = getattr(ep, attr, None)
        if isinstance(v, str) and v:
            setattr(ep, attr, cipher.encrypt(v, purpose, ep.uuid))


def decrypt_episode(ep, cipher: CompanyCipher) -> None:
    for attr, purpose in EPISODE_FIELDS.items():
        v = getattr(ep, attr, None)
        if isinstance(v, str) and v:
            setattr(ep, attr, cipher.decrypt_or(v, purpose, ep.uuid, fallback=""))

_EDGE_CORE = {
    "uuid", "source_uuid", "target_uuid", "source_node_uuid", "target_node_uuid", "name", "group_id",
    "fact", "fact_embedding", "episodes", "created_at", "expired_at", "valid_at", "invalid_at",
    "reference_time",
}
_NODE_CORE = {"uuid", "name", "group_id", "summary", "created_at", "name_embedding", "labels"}


# The extractor usually emits our custom types ("Decision", "Promise") but sometimes a generic
# relation name for the same thing; all of these count.
TYPE_ALIASES = {
    "Decision": ["decision", "decided", "decides", "decided_to"],
    "Promise": ["promise", "promised", "promises", "promised_to", "commits_to", "committed_to", "commitment"],
}


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if hasattr(v, "to_native"):
        v = v.to_native()
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()
    return str(v)


def edge_to_fact(props: dict[str, Any], source: dict | None = None, target: dict | None = None) -> dict[str, Any]:
    attrs = {k: v for k, v in props.items() if k not in _EDGE_CORE}
    invalid = _iso(props.get("invalid_at"))
    expired = _iso(props.get("expired_at"))
    # a fact with a scheduled end (valid until a future date) is current until then
    ends_later = invalid is not None and expired is None and invalid > datetime.now(timezone.utc).isoformat()
    return {
        "id": props.get("uuid"),
        "type": props.get("name"),
        "fact": props.get("fact"),
        "valid_from": _iso(props.get("valid_at")),
        "valid_to": invalid,
        "superseded_at": expired,
        "current": expired is None and (invalid is None or ends_later),
        "recorded_at": _iso(props.get("created_at")),
        "subject": source,
        "object": target,
        "attributes": attrs,
        "episode_ids": list(props.get("episodes") or []),
    }


def node_to_entity(props: dict[str, Any], labels: list[str] | None = None) -> dict[str, Any]:
    labels = [l for l in (labels or props.get("labels") or []) if l != "Entity"]
    return {
        "id": props.get("uuid"),
        "name": props.get("name"),
        "types": labels,
        "summary": props.get("summary"),
        "created_at": _iso(props.get("created_at")),
        "attributes": {k: v for k, v in props.items() if k not in _NODE_CORE},
    }


ERASED = "[șters la cerere]"


def name_pattern(name: str) -> NameMatcher | None:
    """Matcher for a name in free text: case- and diacritics-insensitive, whole words, and the
    Romanian declined forms ("Anei Popa", "lui Ion Pop", "Mariei"); None if too short."""
    m = NameMatcher(name)
    return m if m.valid else None


def _ref(uuid: str | None, name: str | None) -> dict | None:
    return {"id": uuid, "name": name} if uuid else None


STRICT_CONTRADICTION_RULES = """

ZEN-MEMORY RULES FOR CONTRADICTIONS (they override anything above):
- Mark an existing fact as contradicted ONLY when the NEW FACT is about the same subject and the
  same attribute and explicitly replaces it: a new price for the same product from the same seller,
  a new deadline for the same commitment, another supplier for the same goods, a contract or
  subscription that ended, a decision that was withdrawn.
- NOT contradictions: a different product, contract, month or customer; an additional arrangement;
  a value restated as unchanged ("rămâne", "este tot", "în continuare"); a promise being fulfilled;
  a separate decision about something else (a menu price change does not contradict a supplier
  contract). When in doubt, return no contradiction.
"""


def _strict_resolve_edge(context: dict):
    from graphiti_core.prompts.lib import DefaultChatPromptLibrary
    from graphiti_core.prompts.models import ChatPrompt, SystemMessage

    base = DefaultChatPromptLibrary().dedupe_edges.resolve_edge(context)
    return ChatPrompt(system=SystemMessage(content=base.system.content + STRICT_CONTRADICTION_RULES), user=base.user)


class ZenBase(Graphiti):
    """Graphiti that stores episode text encrypted (both profiles).

    Context window: Graphiti sends the last 10 episodes of the group, whole, to every extraction
    prompt (nodes, edges, node dedupe, summaries), as context for resolving references. With the
    app's summaries (1-6K characters) that was the largest part of a mature company's input
    tokens. `previous_episodes` / `previous_episode_chars` keep the last few, trimmed (the app's
    summaries are written to stand alone: names, absolute dates). None = Graphiti's default.
    """

    previous_episodes: int | None = None
    previous_episode_chars: int | None = None

    async def _process_episode_data(self, episode, *args, **kwargs):
        cipher = current_cipher.get()
        if cipher.enabled:
            for ep in episode if isinstance(episode, list) else [episode]:
                encrypt_episode(ep, cipher)
        return await super()._process_episode_data(episode, *args, **kwargs)

    async def retrieve_episodes(self, *args, **kwargs):
        if self.previous_episodes is not None:
            if "last_n" in kwargs:
                kwargs["last_n"] = min(kwargs["last_n"], self.previous_episodes)
            elif len(args) > 1:
                args = (args[0], min(args[1], self.previous_episodes), *args[2:])
            else:
                kwargs["last_n"] = self.previous_episodes
        episodes = await super().retrieve_episodes(*args, **kwargs) if (kwargs.get("last_n", 1) or 0) > 0 else []
        cipher = current_cipher.get()
        group_ids = kwargs.get("group_ids") or (args[2] if len(args) > 2 else None)
        if group_ids:
            episodes = [e for e in episodes if e.group_id in group_ids]
        for ep in episodes:
            decrypt_episode(ep, cipher)
            limit = self.previous_episode_chars
            if limit and isinstance(ep.content, str) and len(ep.content) > limit:
                # context only, never saved back (Graphiti saves the current episode alone)
                ep.content = ep.content[:limit].rsplit(" ", 1)[0] + " [...]"
        return episodes


class ZenGraphiti(ZenBase):
    """Graphiti with our extraction pipeline (profile "v2"); profile "baseline" is stock Graphiti.

    v2 adds: a stricter contradiction prompt, and a review step between edge resolution and
    saving (`review.py`) that types facts, fills deadlines and vetoes unfounded invalidations.
    """

    profile = "baseline"
    last_review: dict | None = None
    resolve_mode = "graphiti"  # "batched": resolve.resolve_edges_batched, one call per episode
    edge_candidates = 8

    @classmethod
    def create(cls, driver, llm, embedder, cross_encoder, profile: str = "v2", *, previous_episodes: int | None = None,
               previous_episode_chars: int | None = None, resolve_mode: str = "graphiti",
               edge_candidates: int = 8) -> Graphiti:
        if profile == "baseline":
            g0 = ZenBase(graph_driver=driver, llm_client=llm, embedder=embedder, cross_encoder=cross_encoder)
            g0.previous_episodes, g0.previous_episode_chars = previous_episodes, previous_episode_chars
            return g0
        from graphiti_core.prompts.lib import create_prompt_library

        library = create_prompt_library({"dedupe_edges": {"resolve_edge": _strict_resolve_edge}})
        g = cls(graph_driver=driver, llm_client=llm, embedder=embedder, cross_encoder=cross_encoder, prompt_library=library)
        g.profile = profile
        g.previous_episodes, g.previous_episode_chars = previous_episodes, previous_episode_chars
        g.resolve_mode, g.edge_candidates = resolve_mode, edge_candidates
        return g

    async def _extract_and_resolve_edges(self, episode, extracted_nodes, previous_episodes, edge_type_map, group_id,
                                         edge_types, nodes, uuid_map, strict_edge_types=False,
                                         custom_extraction_instructions=None, entity_types=None, clients=None):
        from graphiti_core.utils.bulk_utils import resolve_edge_pointers
        from graphiti_core.utils.maintenance.edge_operations import extract_edges, resolve_extracted_edges

        from .review import review_edges

        clients = clients or self.clients
        episodes = episode if isinstance(episode, list) else [episode]
        primary = episodes[0]
        extracted_edges, materialized = await extract_edges(
            clients, episode, extracted_nodes, previous_episodes, edge_type_map, group_id, edge_types,
            strict_edge_types, custom_extraction_instructions,
        )
        if materialized:
            await self._merge_materialized_endpoint_nodes(
                materialized, primary, previous_episodes, entity_types, nodes, uuid_map, clients=clients
            )
        edges = resolve_edge_pointers(extracted_edges, uuid_map)
        invalidated_by: dict[str, list[str]] = {}
        if self.resolve_mode == "batched":
            from .resolve import resolve_edges_batched

            resolved, invalidated, new = await resolve_edges_batched(
                clients, edges, primary, nodes, edge_types or {}, edge_type_map, invalidated_by,
                max_candidates=self.edge_candidates, strict_edge_types=strict_edge_types,
            )
        else:
            resolved, invalidated, new = await resolve_extracted_edges(
                clients, edges, primary, nodes, edge_types or {}, edge_type_map, invalidated_by=invalidated_by
            )
        resolved, invalidated, new, stats = await review_edges(
            clients.llm_client, clients.driver, primary, nodes, resolved, invalidated, new, invalidated_by, group_id
        )
        log.info("review %s: %s", primary.uuid, stats)
        return resolved, invalidated, new


class MemoryEngine:
    def __init__(self, graphiti: Graphiti, query_instruction: str = "", profile: str = "v2"):
        self.g = graphiti
        self.driver = graphiti.driver
        self.query_instruction = query_instruction
        self.profile = profile

    async def setup(self) -> None:
        await self.g.build_indices_and_constraints()

    async def ping(self) -> bool:
        try:
            await self.driver.execute_query("RETURN 1 AS ok")  # zm-unscoped: health check, reads no data
            return True
        except Exception:
            return False

    async def close(self) -> None:
        await self.g.close()

    # ---- write ---------------------------------------------------------------------------

    async def ingest(self, group_id: str, name: str, body: str, reference_time: datetime, source_description: str,
                     cipher: CompanyCipher = PLAINTEXT) -> str:
        if self.profile == "baseline":
            types = dict(entity_types=ENTITY_TYPES, edge_types=EDGE_TYPES, edge_type_map=EDGE_TYPE_MAP,
                         custom_extraction_instructions=EXTRACTION_INSTRUCTIONS)
        else:
            types = dict(
                entity_types=ENTITY_TYPES_V2, edge_types=EDGE_TYPES_V2, edge_type_map=EDGE_TYPE_MAP_V2,
                custom_extraction_instructions=EXTRACTION_INSTRUCTIONS_V2
                + "\n<DATE_TABLE>\n" + calendar_hint(reference_time) + "\n</DATE_TABLE>\n",
            )
        token = current_cipher.set(cipher)
        try:
            res = await self.g.add_episode(
                name=name,
                episode_body=body,
                source_description=source_description,
                reference_time=reference_time,
                source=EpisodeType.text,
                group_id=group_id,
                **types,
            )
        finally:
            current_cipher.reset(token)
        return res.episode.uuid

    # ---- read ----------------------------------------------------------------------------

    async def scoped(self, group_id: str, cypher: str, **params: Any) -> list[dict]:
        """The only way to run Cypher here: limited to `group_id` (scope.scoped_query)."""
        return await scoped_query(self.driver, group_id, cypher, **params)

    async def query_vector(self, q: str):
        return await self.g.embedder.create(self.query_instruction + q)

    async def search(self, group_id: str, q: str, limit: int = 10, include_superseded: bool = True, qvec=None) -> dict:
        config = COMBINED_HYBRID_SEARCH_RRF.model_copy(deep=True)
        config.limit = limit * 2 if not include_superseded else limit
        if qvec is None and self.query_instruction:
            qvec = await self.g.embedder.create(self.query_instruction + q)
        res = await self.g.search_(q, config=config, group_ids=[group_id], query_vector=qvec)

        edge_ids = [e.uuid for e in res.edges]
        rows = await self.scoped(
            group_id,
            """
            UNWIND $ids AS id
            MATCH (s:Entity {group_id: $g})-[e:RELATES_TO {uuid: id, group_id: $g}]->(t:Entity {group_id: $g})
            RETURN properties(e) AS e, s.uuid AS su, s.name AS sn, t.uuid AS tu, t.name AS tn
            """,
            ids=edge_ids,
        )
        by_id = {r["e"]["uuid"]: r for r in rows}
        facts = []
        for eid in edge_ids:  # keep ranking order
            r = by_id.get(eid)
            if r is None:
                continue
            f = edge_to_fact(r["e"], _ref(r["su"], r["sn"]), _ref(r["tu"], r["tn"]))
            if include_superseded or f["current"]:
                facts.append(f)
        entities = [
            node_to_entity({"uuid": n.uuid, "name": n.name, "summary": n.summary, "created_at": n.created_at, **(n.attributes or {})}, n.labels)
            for n in only_group(res.nodes, group_id)
        ]
        return {"facts": facts[:limit], "entities": entities[:limit]}

    async def get_entity(self, group_id: str, entity_id: str) -> dict | None:
        rows = await self.scoped(
            group_id,
            "MATCH (n:Entity {uuid: $id, group_id: $g}) RETURN properties(n) AS n, labels(n) AS labels",
            id=entity_id,
        )
        if not rows:
            return None
        entity = node_to_entity(rows[0]["n"], rows[0]["labels"])
        edges = await self.scoped(
            group_id,
            """
            MATCH (s:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(t:Entity {group_id: $g})
            WHERE s.uuid = $id OR t.uuid = $id
            RETURN properties(e) AS e, s.uuid AS su, s.name AS sn, t.uuid AS tu, t.name AS tn
            ORDER BY coalesce(e.valid_at, e.created_at) ASC
            """,
            id=entity_id,
        )
        entity["timeline"] = [edge_to_fact(r["e"], _ref(r["su"], r["sn"]), _ref(r["tu"], r["tn"])) for r in edges]
        return entity

    # Status of a promise, in Cypher (so filtering and pagination happen in the database).
    _CURRENT = "(e.expired_at IS NULL AND (e.invalid_at IS NULL OR e.invalid_at > datetime()))"
    _PROMISE_STATUS = {
        "done": "toLower(coalesce(e.status, '')) = 'done'",
        "cancelled": "toLower(coalesce(e.status, '')) = 'cancelled'",
        "superseded": f"NOT {_CURRENT} AND NOT toLower(coalesce(e.status, '')) IN ['done', 'cancelled']",
        "overdue": f"{_CURRENT} AND NOT toLower(coalesce(e.status, '')) IN ['done', 'cancelled'] AND e.due_date IS NOT NULL AND substring(toString(e.due_date), 0, 10) < $today",
        "open": f"{_CURRENT} AND NOT toLower(coalesce(e.status, '')) IN ['done', 'cancelled'] AND (e.due_date IS NULL OR substring(toString(e.due_date), 0, 10) >= $today)",
    }

    @staticmethod
    def encode_cursor(ts: int, uuid: str) -> str:
        import base64

        return base64.urlsafe_b64encode(f"{int(ts)}|{uuid}".encode()).decode().rstrip("=")

    @staticmethod
    def decode_cursor(cursor: str) -> tuple[int, str]:
        import base64

        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        ts, _, uuid = raw.partition("|")
        if not uuid:
            raise ValueError("bad cursor")
        return int(ts), uuid

    async def typed_page(
        self, group_id: str, edge_type: str, *, include_superseded: bool = True, status: str | None = None,
        limit: int = 100, cursor: str | None = None,
    ) -> tuple[list[dict], str | None]:
        """One page of decisions or promises, newest first; returns (items, next_cursor)."""
        where = [] if edge_type == "all" else ["toLower(e.name) IN $names"]
        if status and edge_type == "Promise":
            where.append(self._PROMISE_STATUS[status])
        elif not include_superseded:
            where.append(self._CURRENT)
        params: dict[str, Any] = {"names": TYPE_ALIASES.get(edge_type, []), "limit": limit + 1,
                                  "today": date.today().isoformat()}
        if cursor:
            ts, cu = self.decode_cursor(cursor)
            params.update(cts=ts, cu=cu)
            where.append("(coalesce(e.valid_at, e.created_at).epochMillis < $cts OR "
                         "(coalesce(e.valid_at, e.created_at).epochMillis = $cts AND e.uuid < $cu))")
        rows = await self.scoped(
            group_id,
            f"""
            MATCH (s:Entity {{group_id: $g}})-[e:RELATES_TO {{group_id: $g}}]->(t:Entity {{group_id: $g}})
            WHERE {" AND ".join(where) or "true"}
            RETURN properties(e) AS e, s.uuid AS su, s.name AS sn, t.uuid AS tu, t.name AS tn,
                   coalesce(e.valid_at, e.created_at).epochMillis AS sort_ts
            ORDER BY sort_ts DESC, e.uuid DESC
            LIMIT $limit
            """,
            **params,
        )
        nxt = None
        if len(rows) > limit:
            rows = rows[:limit]
            nxt = self.encode_cursor(rows[-1]["sort_ts"], rows[-1]["e"]["uuid"])
        return self._typed_rows(edge_type, rows), nxt

    async def typed_facts(self, group_id: str, edge_type: str, include_superseded: bool, limit: int) -> list[dict]:
        items, _ = await self.typed_page(group_id, edge_type, include_superseded=include_superseded, limit=limit)
        return items

    def _typed_rows(self, edge_type: str, rows: list[dict]) -> list[dict]:
        out = []
        today = date.today().isoformat()
        for r in rows:
            f = edge_to_fact(r["e"], _ref(r["su"], r["sn"]), _ref(r["tu"], r["tn"]))
            a = f["attributes"]
            if edge_type == "Promise":
                status = (a.get("status") or "open").lower()
                if status in ("done", "cancelled"):
                    pass  # a closed promise keeps its outcome even after it stops being current
                elif not f["current"]:
                    status = "superseded"
                elif a.get("due_date") and str(a["due_date"])[:10] < today:
                    status = "overdue"
                else:
                    status = "open"
                f.update(owner=a.get("promised_by"), promised_to=a.get("promised_to"), due_date=a.get("due_date"), status=status)
            elif edge_type == "Decision":
                status = (a.get("status") or "active").lower()
                f.update(
                    owner=a.get("decided_by"),
                    decision_date=a.get("decision_date"),
                    status="superseded" if not f["current"] and status != "reversed" else status,
                )
            out.append(f)
        return out

    async def counts(self, group_id: str) -> dict[str, int]:
        rows = await self.scoped(
            group_id,
            """
            CALL () { MATCH (n:Entity {group_id: $g}) RETURN count(n) AS entities }
            CALL () { MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g}) RETURN count(e) AS facts }
            CALL () { MATCH (n:Episodic {group_id: $g}) RETURN count(n) AS episodes }
            RETURN entities, facts, episodes
            """,
        )
        return rows[0] if rows else {"entities": 0, "facts": 0, "episodes": 0}

    # ---- one fact: read, correct, mark wrong, delete (review UI, v4) --------------------------

    async def get_fact(self, group_id: str, fact_id: str) -> dict | None:
        rows = await self.scoped(
            group_id,
            """
            MATCH (s:Entity {group_id: $g})-[e:RELATES_TO {uuid: $id, group_id: $g}]->(t:Entity {group_id: $g})
            RETURN properties(e) AS e, s.uuid AS su, s.name AS sn, t.uuid AS tu, t.name AS tn
            """,
            id=fact_id,
        )
        if not rows:
            return None
        r = rows[0]
        return edge_to_fact(r["e"], _ref(r["su"], r["sn"]), _ref(r["tu"], r["tn"]))

    async def correct_fact(self, group_id: str, fact_id: str, text: str, by: str | None) -> dict | None:
        """A person rewrote the fact: new text and embedding, kept as confirmed by that person."""
        emb = await self.g.embedder.create(text.replace("\n", " "))
        rows = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {uuid: $id, group_id: $g}]->(:Entity {group_id: $g})
            SET e.zm_original_fact = coalesce(e.zm_original_fact, e.fact), e.fact = $text,
                e.zm_corrected_by = $by, e.zm_corrected_at = datetime(), e.zm_trust = 'confirmed'
            WITH e CALL db.create.setRelationshipVectorProperty(e, 'fact_embedding', $emb)
            RETURN e.uuid AS id
            """,
            id=fact_id, text=text, by=by, emb=emb,
        )
        return await self.get_fact(group_id, fact_id) if rows else None

    async def mark_wrong(self, group_id: str, fact_id: str, by: str | None) -> bool:
        """Ends the fact now (kept as history, marked wrong); it no longer shows as current."""
        rows = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {uuid: $id, group_id: $g}]->(:Entity {group_id: $g})
            SET e.expired_at = coalesce(e.expired_at, datetime()), e.invalid_at = coalesce(e.invalid_at, datetime()),
                e.zm_marked_wrong_by = $by, e.zm_marked_wrong_at = datetime()
            RETURN e.uuid AS id
            """,
            id=fact_id, by=by,
        )
        return bool(rows)

    async def delete_fact(self, group_id: str, fact_id: str) -> bool:
        rows = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {uuid: $id, group_id: $g}]->(:Entity {group_id: $g})
            DELETE e RETURN count(*) AS c
            """,
            id=fact_id,
        )
        return bool(rows and rows[0]["c"])

    async def delete_episodes(self, group_id: str, episode_uuids: list[str]) -> dict:
        """Remove these episodes, every fact that came only from them, and entities left with nothing."""
        if not episode_uuids:
            return {"episodes": 0, "facts": 0, "entities": 0}
        facts = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g})
            WHERE any(x IN e.episodes WHERE x IN $u)
            WITH e, [x IN e.episodes WHERE NOT x IN $u] AS rest
            FOREACH (_ IN CASE WHEN size(rest) > 0 THEN [1] ELSE [] END | SET e.episodes = rest)
            WITH e, rest WHERE size(rest) = 0
            DELETE e RETURN count(*) AS c
            """,
            u=episode_uuids,
        )
        eps = await self.scoped(
            group_id,
            "MATCH (ep:Episodic {group_id: $g}) WHERE ep.uuid IN $u DETACH DELETE ep RETURN count(*) AS c",
            u=episode_uuids,
        )
        ents = await self.scoped(
            group_id,
            """
            MATCH (n:Entity {group_id: $g})
            WHERE NOT EXISTS { MATCH (n)-[:RELATES_TO {group_id: $g}]-(:Entity {group_id: $g}) }
              AND NOT EXISTS { MATCH (:Episodic {group_id: $g})-[:MENTIONS {group_id: $g}]->(n) }
            DETACH DELETE n RETURN count(*) AS c
            """,
        )
        return {"episodes": eps[0]["c"] if eps else 0, "facts": facts[0]["c"] if facts else 0,
                "entities": ents[0]["c"] if ents else 0}

    # ---- untrusted content guard (memory poisoning, v4) ----------------------------------------

    async def trust_snapshot(self, group_id: str) -> dict[str, dict]:
        """State of the current facts before an untrusted episode is ingested."""
        rows = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g})
            WHERE e.expired_at IS NULL
            RETURN e.uuid AS id, e.invalid_at AS invalid_at, e.status AS status, e.name AS name
            """,
        )
        return {r["id"]: {"invalid_at": r["invalid_at"], "status": r["status"], "name": r["name"]} for r in rows}

    async def untrusted_guard(self, group_id: str, episode_uuid: str, before: dict[str, dict]) -> dict:
        """After an untrusted episode: what it created becomes an Observation (never a decision,
        promise or rule), and nothing it did to earlier facts stays (no invalidation, no status change)."""
        made = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g})
            WHERE e.episodes = [$u]
            SET e.zm_original_type = e.name, e.name = 'Observation', e.zm_trust = 'untrusted'
            RETURN count(*) AS c
            """,
            u=episode_uuid,
        )
        restored = 0
        rows = await self.scoped(
            group_id,
            """
            MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g})
            WHERE e.uuid IN $ids
            RETURN e.uuid AS id, e.expired_at AS expired_at, e.invalid_at AS invalid_at, e.status AS status, e.name AS name
            """,
            ids=list(before),
        )
        for r in rows:
            b = before[r["id"]]
            if r["expired_at"] is not None or r["invalid_at"] != b["invalid_at"] or r["status"] != b["status"] or r["name"] != b["name"]:
                await self.scoped(
                    group_id,
                    """
                    MATCH (:Entity {group_id: $g})-[e:RELATES_TO {uuid: $id, group_id: $g}]->(:Entity {group_id: $g})
                    SET e.expired_at = null, e.invalid_at = $inv, e.status = $st, e.name = $name,
                        e.episodes = [x IN e.episodes WHERE x <> $u]
                    """,
                    id=r["id"], inv=b["invalid_at"], st=b["status"], name=b["name"], u=episode_uuid,
                )
                restored += 1
        return {"observations": made[0]["c"] if made else 0, "restored": restored}

    async def find_entities_by_name(self, group_id: str, name: str) -> list[str]:
        """Entity ids whose name is this person or organization (declension- and diacritic-aware)."""
        m = name_pattern(name)
        if m is None:
            return []
        rows = await self.scoped(group_id, "MATCH (n:Entity {group_id: $g}) RETURN n.uuid AS id, n.name AS name")
        want = len(name.split())
        return [r["id"] for r in rows if r["name"] and m.search(r["name"]) and len(r["name"].split()) == want]

    # ---- GDPR ----------------------------------------------------------------------------

    async def forget_entity(self, group_id: str, entity_id: str, cipher: CompanyCipher = PLAINTEXT) -> dict | None:
        """GDPR erasure of a person or organization:
        - delete the entity and every fact touching it;
        - rewrite every other fact of the company whose text or owner fields mention its name
          (the name is replaced and the fact re-embedded, so it is no longer findable by it);
        - rewrite other entities' summaries that mention it;
        - redact the raw text of every episode that mentions it (the episode node stays, so other
          facts keep their provenance).
        Name matching (`names.NameMatcher`) ignores case and Romanian diacritics and also finds the
        declined forms ("Anei Popa", "Mariei", "Popei", "lui Ion Pop"); nicknames and initials are
        not detected."""
        rows = await self.scoped(
            group_id,
            "MATCH (n:Entity {uuid: $id, group_id: $g}) RETURN n.name AS name",
            id=entity_id,
        )
        if not rows:
            return None
        name = rows[0]["name"] or ""
        pattern = name_pattern(name)
        red = await self.scoped(
            group_id,
            """
            MATCH (ep:Episodic {group_id: $g})-[:MENTIONS]->(n:Entity {uuid: $id, group_id: $g})
            SET ep.content = '[redacted: GDPR erasure]', ep.name = '[redacted]', ep.source_description = '[redacted]'
            RETURN count(DISTINCT ep) AS redacted
            """,
            id=entity_id,
        )
        redacted = red[0]["redacted"] if red else 0
        facts = await self.scoped(
            group_id,
            """
            MATCH (n:Entity {uuid: $id, group_id: $g})-[e:RELATES_TO]-()
            WITH collect(e) AS es, count(e) AS c
            FOREACH (x IN es | DELETE x)
            RETURN c
            """,
            id=entity_id,
        )
        await self.scoped(group_id, "MATCH (n:Entity {uuid: $id, group_id: $g}) DETACH DELETE n", id=entity_id)

        rewritten = summaries = 0
        if pattern is not None:
            rows = await self.scoped(
                group_id,
                """
                MATCH (:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(:Entity {group_id: $g})
                RETURN e.uuid AS uuid, e.fact AS fact, e.decided_by AS decided_by, e.promised_by AS promised_by,
                       e.promised_to AS promised_to
                """,
            )
            for r in rows:
                fields = {k: r[k] for k in ("fact", "decided_by", "promised_by", "promised_to") if r[k] and pattern.search(str(r[k]))}
                if not fields:
                    continue
                new = {k: pattern.sub(ERASED, str(v)) for k, v in fields.items()}
                params: dict[str, Any] = {"u": r["uuid"], "props": new}
                if "fact" in new:
                    params["vec"] = await self.g.embedder.create(new["fact"])
                    await self.scoped(
                        group_id,
                        """
                        MATCH ()-[e:RELATES_TO {uuid: $u, group_id: $g}]->()
                        SET e += $props
                        WITH e CALL db.create.setRelationshipVectorProperty(e, "fact_embedding", $vec)
                        RETURN e.uuid
                        """,
                        **params,
                    )
                else:
                    await self.scoped(group_id, "MATCH ()-[e:RELATES_TO {uuid: $u, group_id: $g}]->() SET e += $props", **params)
                rewritten += 1
            for r in await self.scoped(
                group_id,
                "MATCH (n:Entity {group_id: $g}) WHERE n.summary IS NOT NULL RETURN n.uuid AS uuid, n.summary AS summary",
            ):
                if pattern.search(r["summary"]):
                    await self.scoped(
                        group_id,
                        "MATCH (n:Entity {uuid: $u, group_id: $g}) SET n.summary = $s",
                        u=r["uuid"], s=pattern.sub(ERASED, r["summary"]),
                    )
                    summaries += 1
            for r in await self.scoped(
                group_id,
                "MATCH (ep:Episodic {group_id: $g}) WHERE ep.content IS NOT NULL AND NOT ep.content STARTS WITH '[redacted' "
                "RETURN ep.uuid AS uuid, ep.content AS content, ep.name AS name, ep.source_description AS sd",
            ):
                text = " ".join(cipher.decrypt_or(r[k], p, r["uuid"], fallback="") or ""
                                for k, p in (("content", EPISODE_FIELDS["content"]), ("name", EPISODE_FIELDS["name"]),
                                             ("sd", EPISODE_FIELDS["source_description"])))
                if pattern.search(text):
                    await self.scoped(
                        group_id,
                        "MATCH (ep:Episodic {uuid: $u, group_id: $g}) "
                        "SET ep.content = '[redacted: GDPR erasure]', ep.name = '[redacted]', ep.source_description = '[redacted]'",
                        u=r["uuid"],
                    )
                    redacted += 1
        return {
            "entity_id": entity_id,
            "name": name,
            "facts_deleted": facts[0]["c"] if facts else 0,
            "facts_rewritten": rewritten,
            "summaries_rewritten": summaries,
            "episodes_redacted": redacted,
        }

    async def delete_group(self, group_id: str) -> int:
        """Remove every node (and its relationships) that belongs to the company."""
        total = 0
        while True:
            rows = await self.scoped(
                group_id,
                """
                MATCH (n) WHERE n.group_id = $g
                WITH n LIMIT 1000
                DETACH DELETE n
                RETURN count(*) AS c
                """,
            )
            c = rows[0]["c"] if rows else 0
            total += c
            if c == 0:
                return total

    # ---- encryption maintenance -------------------------------------------------------------

    async def reencrypt_episodes(self, group_id: str, cipher: CompanyCipher) -> int:
        """Rewrite the company's episode text under its active data key (key rotation, or
        encrypting episodes stored before encryption was on). Returns the episodes rewritten."""
        if not cipher.enabled:
            return 0
        rows = await self.scoped(
            group_id,
            "MATCH (ep:Episodic {group_id: $g}) "
            "RETURN ep.uuid AS uuid, ep.content AS content, ep.name AS name, ep.source_description AS source_description",
        )
        n = 0
        for r in rows:
            if not any(cipher.needs_rewrite(r[k]) for k in EPISODE_FIELDS if isinstance(r[k], str) and r[k]
                       and not r[k].startswith("[redacted")):
                continue
            new = {}
            for k, purpose in EPISODE_FIELDS.items():
                v = r[k]
                if isinstance(v, str) and v and not v.startswith("[redacted"):
                    new[k] = cipher.encrypt(cipher.decrypt(v, purpose, r["uuid"]), purpose, r["uuid"])
            await self.scoped(group_id, "MATCH (ep:Episodic {uuid: $u, group_id: $g}) SET ep += $props", u=r["uuid"], props=new)
            n += 1
        return n

    async def episode_texts(self, group_id: str, cipher: CompanyCipher) -> list[dict]:
        """Decrypted episode text of the company (export / tests)."""
        rows = await self.scoped(
            group_id,
            "MATCH (ep:Episodic {group_id: $g}) "
            "RETURN ep.uuid AS uuid, ep.content AS content, ep.name AS name, ep.source_description AS source_description",
        )
        return [{"uuid": r["uuid"], **{k: cipher.decrypt_or(r[k], p, r["uuid"]) for k, p in EPISODE_FIELDS.items()}} for r in rows]
