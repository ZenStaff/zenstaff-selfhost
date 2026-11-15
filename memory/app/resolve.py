"""Edge resolution in one LLM call per episode (EDGE_RESOLVE_MODE=batched, the default).

Graphiti 0.31 resolves every extracted fact on its own: one `dedupe_edges.resolve_edge` call per
fact that has anything to compare with, plus one `extract_edges.extract_timestamps` call per fact
without dates. Its contradiction candidates are the 10 best search hits in the whole group, so
once a company has a few dozen facts EVERY new fact pays a call, and an episode of 8 facts costs
~16 calls (measured with eval/growth.py: 2/3 of the calls of a mature company).

Here the same searches run (no LLM), then:
- contradiction candidates are only stored facts that share an entity with the new fact (our
  contradiction rule needs the same subject, and review.py already drops any invalidation whose
  facts share no subject), at most `max_candidates` per fact, current facts first;
- a fact with nothing to compare and with dates is resolved without the model, as in Graphiti;
- everything else goes into ONE call: for each new fact its duplicate candidates (same two
  entities), its contradiction candidates and, when it has no dates, a request for valid_at /
  invalid_at. The rules are Graphiti's resolve_edge and timestamp rules plus our strict
  contradiction rules, in a fixed (cached) system prompt.
The result has the same shape as `resolve_extracted_edges` (resolved, invalidated, new, and
`invalidated_by`), so review.py runs unchanged after it.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from graphiti_core.edges import EntityEdge, create_entity_edge_embeddings
from graphiti_core.helpers import semaphore_gather
from graphiti_core.nodes import EntityNode, EpisodicNode
from graphiti_core.search.search import search
from graphiti_core.search.search_config_recipes import EDGE_HYBRID_SEARCH_RRF
from graphiti_core.search.search_filters import SearchFilters
from graphiti_core.utils.datetime_utils import ensure_utc
from graphiti_core.utils.maintenance.dedup_helpers import _normalize_string_exact
from graphiti_core.utils.maintenance.edge_operations import (
    _apply_temporal_invalidation,
    _edge_types_for_endpoints,
    _pair_search_filter,
    _same_pair_edges,
    enforce_edge_type_signatures,
)
from graphiti_core.utils.maintenance.temporal_edge_utils import apply_extracted_timestamps

log = logging.getLogger("zen-memory.resolve")

RESOLVE_SYSTEM = """\
You compare NEW FACTS, extracted from one business conversation, with facts already stored in a
company's memory, and date the new facts that have no dates yet.

STORED FACTS is one numbered list. For each new fact you get its id, its text, and, when there
are any:
- "existing": numbers of stored facts between the same two entities (possible duplicates);
- "candidates": numbers of other stored facts about one of its entities (possible contradictions);
- "dates": true when you must give valid_at / invalid_at for it.

1. duplicate_of: numbers from its "existing" only, when the new fact states identical factual
   information. NEVER a duplicate when there are key differences, particularly numeric values,
   dates, amounts, products or key qualifiers. Empty list if none.
2. contradicts: numbers from its "existing" or "candidates" that the new fact makes false.
   - Only when the new fact and the stored fact cannot both be true: explicit evidence that the
     old fact stopped being true or was replaced (termination, replacement, transfer, mutually
     exclusive current state).
   - Not from recency alone, episode dates, meeting dates, status updates, or a new event
     involving the same entities. Work performed, progress, blockers or next steps do not
     contradict a role, ownership, responsibility or assignment.
   - A stored fact can be both a duplicate and contradicted only when the same assertion is
     restated with an explicit incompatible change.
   - Only the same subject and the same attribute, explicitly replaced: a new price for the same
     product from the same seller, a new deadline for the same commitment, another supplier for
     the same goods, a contract or subscription that ended, a decision that was withdrawn.
   - NOT contradictions: a different product, contract, month or customer; an additional
     arrangement; a value restated as unchanged ("rămâne", "este tot", "în continuare"); a promise
     being fulfilled; a separate decision about something else; a schedule or price for OTHER days,
     items or periods ("sâmbăta acum 10-14" does not contradict "luni-vineri 8-16"). When in
     doubt, no contradiction.
   Examples: stored "Moara Verde livrează făina T650 la 3,10 lei/kg", new "din 1 aprilie făina T650
   costă 3,60 lei/kg la Moara Verde" -> contradicts. Stored "Ana lucrează la Acme ca inginer", new
   "Ana lucrează la Acme ca inginer senior" -> contradicts, not a duplicate. Stored "Bob a alergat
   5 km marți", new "Bob a alergat 3 km miercuri" -> neither.
3. Dates (only for facts marked "dates"; REFERENCE TIME = when the conversation ended):
   - valid_at = when the fact became true; invalid_at = when it stopped being true.
   - Resolve relative expressions ("ieri", "săptămâna trecută") against REFERENCE TIME.
   - Ongoing (present tense) fact: valid_at = REFERENCE TIME.
   - Future plan, promise, scheduled event or deadline: valid_at = REFERENCE TIME, never the
     future date; keep the future date in the text. A soft deadline ("până pe 15 martie") is NOT
     invalid_at.
   - A future invalid_at only for an ongoing state that ends then ("contract valabil până în
     decembrie 2027", "indisponibil până pe 25 decembrie").
   - A change or end that is expressed: invalid_at = that time.
   - null when no time is stated or resolvable. Date only: 00:00:00. ISO 8601 with Z.
   - Never invent dates.

Reply with only this JSON object, one entry per new fact you received, in any order:
{"facts": [{"id": 0, "duplicate_of": [], "contradicts": [], "valid_at": null, "invalid_at": null}]}"""


def _shares_entity(new: EntityEdge, other: EntityEdge) -> bool:
    ends = {new.source_node_uuid, new.target_node_uuid}
    return other.source_node_uuid in ends or other.target_node_uuid in ends


def _is_current(e: EntityEdge) -> bool:
    return e.expired_at is None


def _append_provenance(resolved: EntityEdge, extracted: EntityEdge, episode: EpisodicNode) -> None:
    for ep_uuid in [*extracted.episodes, episode.uuid]:
        if ep_uuid not in resolved.episodes:
            resolved.episodes.append(ep_uuid)


def _int_list(v: Any) -> list[int]:
    out = []
    for x in v or []:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


async def resolve_edges_batched(
    clients,
    extracted_edges: list[EntityEdge],
    episode: EpisodicNode,
    entities: list[EntityNode],
    edge_types: dict,
    edge_type_map: dict,
    invalidated_by: dict[str, list[str]] | None = None,
    *,
    max_candidates: int = 8,
    strict_edge_types: bool = False,
) -> tuple[list[EntityEdge], list[EntityEdge], list[EntityEdge]]:
    """Drop-in for graphiti's `resolve_extracted_edges` with one LLM call in total."""
    driver, llm, embedder = clients.driver, clients.llm_client, clients.embedder
    if not extracted_edges:
        return [], [], []

    uuid_entity_map: dict[str, EntityNode] = {e.uuid: e for e in entities}
    missing = {u for e in extracted_edges for u in (e.source_node_uuid, e.target_node_uuid)} - set(uuid_entity_map)
    if missing:
        for node in await EntityNode.get_by_uuids(driver, list(missing), group_id=extracted_edges[0].group_id):
            uuid_entity_map[node.uuid] = node

    types_lst = [_edge_types_for_endpoints(e, uuid_entity_map, edge_types, edge_type_map) for e in extracted_edges]
    extracted_edges, types_lst = enforce_edge_type_signatures(extracted_edges, types_lst, edge_type_map, strict_edge_types)

    # same fast path as Graphiti: the same fact twice in one episode (either direction) is one fact
    seen: dict[tuple[str, str, str], EntityEdge] = {}
    edges: list[EntityEdge] = []
    for e in extracted_edges:
        key = (e.source_node_uuid, e.target_node_uuid, _normalize_string_exact(e.fact))
        if key in seen:
            continue
        rev = seen.get((e.target_node_uuid, e.source_node_uuid, _normalize_string_exact(e.fact)))
        if rev is not None and rev.name == e.name:
            continue
        seen[key] = e
        edges.append(e)

    await create_entity_edge_embeddings(embedder, edges)
    mc = getattr(clients, "max_coroutines", None)
    related_res = await semaphore_gather(
        *[search(clients, e.fact, group_ids=[e.group_id], config=EDGE_HYBRID_SEARCH_RRF,
                 search_filter=_pair_search_filter(e), query_vector=e.fact_embedding) for e in edges],
        max_coroutines=mc,
    )
    related = [_same_pair_edges(e, r.edges) for e, r in zip(edges, related_res, strict=True)]
    cand_res = await semaphore_gather(
        *[search(clients, e.fact, group_ids=[e.group_id], config=EDGE_HYBRID_SEARCH_RRF,
                 search_filter=SearchFilters(), query_vector=e.fact_embedding) for e in edges],
        max_coroutines=mc,
    )
    candidates: list[list[EntityEdge]] = []
    for e, rel, res in zip(edges, related, cand_res, strict=True):
        rel_ids = {x.uuid for x in rel}
        own = [x for x in res.edges if x.uuid not in rel_ids and x.uuid != e.uuid and _shares_entity(e, x)]
        own.sort(key=lambda x: not _is_current(x))  # current facts first, search rank otherwise
        candidates.append(own[:max_candidates])

    stored: dict[str, int] = {}  # stored fact uuid -> its number in STORED FACTS (shared by all new facts)
    stored_edges: list[EntityEdge] = []

    def number(x: EntityEdge) -> int:
        if x.uuid not in stored:
            stored[x.uuid] = len(stored_edges)
            stored_edges.append(x)
        return stored[x.uuid]

    resolved: list[EntityEdge | None] = [None] * len(edges)
    # None = resolved without the model: no temporal invalidation step (as in Graphiti)
    contradicted: list[list[EntityEdge] | None] = [None for _ in edges]
    items: list[dict] = []
    for i, (e, rel, cands) in enumerate(zip(edges, related, candidates, strict=True)):
        # verbatim restatement of a stored fact between the same entities: reuse it, no model
        norm = _normalize_string_exact(e.fact)
        same = next((r for r in rel if r.source_node_uuid == e.source_node_uuid
                     and r.target_node_uuid == e.target_node_uuid and _normalize_string_exact(r.fact) == norm), None)
        if same is not None:
            _append_provenance(same, e, episode)
            resolved[i] = same
            continue
        needs_dates = e.valid_at is None and e.invalid_at is None
        if not rel and not cands and not needs_dates:
            resolved[i] = e
            continue
        item: dict[str, Any] = {"id": i, "fact": e.fact}
        if rel:
            item["existing"] = [number(r) for r in rel]
        if cands:
            item["candidates"] = [number(c) for c in cands]
        if needs_dates:
            item["dates"] = True
        items.append(item)

    reference_time = ensure_utc(episode.valid_at)
    answers: dict[int, dict] = {}
    if items:
        stored_ctx = "\n".join(f"{k}. {x.fact}" for k, x in enumerate(stored_edges))
        user = (
            f"<REFERENCE TIME>\n{reference_time.isoformat() if reference_time else 'unknown'}\n</REFERENCE TIME>\n\n"
            f"<STORED FACTS>\n{stored_ctx}\n</STORED FACTS>\n\n"
            f"<NEW FACTS>\n" + "\n".join(json.dumps(it, ensure_ascii=False) for it in items) + "\n</NEW FACTS>"
        )
        try:
            data = await llm.complete_json(RESOLVE_SYSTEM, user, max_tokens=400 + 80 * len(items), step="zm.resolve_edges")
            log.debug("batched resolution for episode %s:\n%s\n-> %s", episode.uuid, user, data)
            for a in data.get("facts") or []:
                if isinstance(a, dict) and isinstance(a.get("id"), int):
                    answers[a["id"]] = a
        except Exception:
            # never lose the new facts because the comparison failed: keep them as new, undated
            log.warning("batched edge resolution failed for episode %s; keeping new facts as new", episode.uuid, exc_info=True)

    for item in items:
        i = item["id"]
        e, rel, cands = edges[i], related[i], candidates[i]
        a = answers.get(i, {})
        if item.get("dates"):
            apply_extracted_timestamps(e, a.get("valid_at") or None, a.get("invalid_at") or None, reference_time)
        # numbers outside this fact's own lists are ignored, as Graphiti ignores out-of-range idx
        own_rel = {stored[x.uuid]: x for x in rel}
        own_all = {**own_rel, **{stored[x.uuid]: x for x in cands}}
        dup = [own_rel[k] for k in _int_list(a.get("duplicate_of")) if k in own_rel]
        r = e
        if dup:
            r = dup[0]
            _append_provenance(r, e, episode)
        resolved[i] = r
        contradicted[i] = [own_all[k] for k in dict.fromkeys(_int_list(a.get("contradicts"))) if k in own_all]

    resolved_edges = [r for r in resolved if r is not None]
    new_edges = [r for r, e in zip(resolved, edges) if r is not None and r.uuid == e.uuid]
    invalidated_edges: list[EntityEdge] = []
    for r, cands in zip(resolved, contradicted):
        if r is None or cands is None:
            continue
        inv = _apply_temporal_invalidation(r, cands)
        invalidated_edges.extend(inv)
        if invalidated_by is not None:
            for x in inv:
                invalidated_by.setdefault(x.uuid, []).append(r.uuid)

    await semaphore_gather(
        create_entity_edge_embeddings(embedder, resolved_edges),
        create_entity_edge_embeddings(embedder, invalidated_edges),
        max_coroutines=mc,
    )
    log.info("resolved %d facts with %d in one call (%d duplicates, %d invalidated)", len(edges), len(items),
             len(edges) - len(new_edges), len(invalidated_edges))
    return resolved_edges, invalidated_edges, new_edges
