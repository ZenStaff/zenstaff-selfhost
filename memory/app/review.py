"""Post-extraction review (profile v2): one cheap Haiku call per episode, plus rules.

Graphiti extracts facts, dedupes them and decides which older facts the new ones contradict.
Before anything is saved, this step:
1. classifies every NEW fact as decision / promise / plain fact, and fills owner, counterparty,
   deadline and status (so a generic relation name like PROMISED becomes a dated `Promise`);
2. checks every proposed invalidation and keeps it only if the new fact explicitly replaces the
   old one about the same subject (otherwise the old fact is restored);
3. marks earlier open promises of the company as done or cancelled when this episode says so;
4. adds a Promise for a delivery / launch / completion deadline that was folded into an agreement
   ("site nou ..., cu predarea site-ului până pe 15 decembrie");
5. merges duplicate or overlapping promises and decisions (same parties, same deadline, same
   subject; also against the company's earlier open promises), and checks decision owners (the
   person who decided, not the supplier or client the decision is about).

Schedules are split into one fact per day group first (`schedule.split_schedule`), so a later
change of one day replaces only that day.

Rules back the model up and work alone if the call fails: a decision needs a decision verb and
no "only discussed" marker, deadlines are resolved deterministically from the fact text
(`dates.resolve_due`), and an invalidation needs a shared endpoint (same subject).
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode

from .dates import calendar_hint, local_date, normalize_iso_date, resolve_due
from .names import NameMatcher, fold_text
from .quotas import QuotaExceeded
from .scope import only_group, scoped_query
from .schedule import schedule_days, split_schedule

log = logging.getLogger("zen-memory.review")

DECISION_NAMES = {"decision", "decided", "decides", "decided_to", "decides_to"}
PROMISE_NAMES = {"promise", "promised", "promises", "promised_to", "commits_to", "committed_to", "commitment", "will_deliver"}

_DECISION_VERBS = re.compile(
    r"\b(a |au |am |s-a |s-au )?(hotar\w*|decis|decide\w*|aprob\w*|ales|alege\w*|stabil\w*|accept\w*|semn\w*|"
    r"conven\w*|renunt\w*|rezili\w*|anul\w*|revenit|revine|revin|opri\w*|inchide\w*|inchider\w*|angaj\w*|"
    r"extind\w*|extinde\w*|schimb\w*|trec\w*|majora\w*|reduce\w*|scump\w*|ieftin\w*|introduc\w*|scoate\w*|elimin\w*|"
    r"decided|approved|agreed|chose|signed)\b"
)
_NOT_DECIDED = re.compile(
    r"nu s-a (hotarat|decis|luat)|nicio decizie|nu s-a stabilit|a propus|propune|propunere|se gandeste|"
    r"vrea sa se gandeasca|au discutat|am discutat|s-a discutat|in discutie|ia in calcul|decizia .{0,40}(o iau|o vor lua|dupa)"
)


def fold(s: str | None) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


def looks_like_decision(fact: str) -> bool:
    t = fold(fact)
    if _NOT_DECIDED.search(t):
        # "a propus 20%, dar Diana a hotărât 15%" is still a decision: needs a verb outside the marker
        stripped = _NOT_DECIDED.sub(" ", t)
        return bool(_DECISION_VERBS.search(stripped)) and not re.search(r"nu s-a (hotarat|decis)|nicio decizie", t)
    return bool(_DECISION_VERBS.search(t))


# ---- pure rules (unit-tested in tests/test_review_rules.py) -------------------------------------

_STOP = set("""
a ai al ale am ar are as au ca ce cei cel cele cu da daca de dar din dupa e ea el ei este fi fie
fost ia ii il in inca intr intre isi la le li lor lui mai ne nu o or pe pentru prin sa sau se si
sunt ta tot toate tu un una unei unui va vor vom ne noi voi acum din nou inca odata data iar cele
fata catre spre ori cand care cum unde cat cate pana ziua zile zi azi maine poimaine
luni marti miercuri joi vineri sambata duminica lunea martea miercurea joia vinerea saptamana
saptamanii luna lunii viitoare viitor viitoarea final finalul sfarsitul inceputul
ianuarie februarie martie aprilie mai iunie iulie august septembrie octombrie noiembrie decembrie
promis promite promisiune promisiunea angajat angajeaza confirmat confirma spus spune anuntat
anunta zis trimite trimis trimita trimiterea trebuie urmeaza obligat
""".split())
# generic decision / promise verbs say nothing about WHAT was decided or promised
_STOP_STEMS = {"hotar", "decis", "decid", "deciz", "aprob", "stabi", "conve", "accep", "promi", "angaj", "confi", "anunt"}
_NUM = re.compile(r"\d+(?:[.,]\d+)*")
_ISO = re.compile(r"\b20\d\d-\d\d-\d\d\b")


def content_stems(text: str, drop_names: list[str] | tuple[str, ...] = ()) -> tuple[set[str], set[str]]:
    """(word stems, numbers) of a fact without party names, stop words, dates and weekdays."""
    t = fold(text)
    for n in drop_names:
        m = NameMatcher(n or "")
        if m.valid:
            t = m.sub(" ", t)
    t = _ISO.sub(" ", t)
    nums = {re.sub(r"[.,]", "", n) for n in _NUM.findall(t)}
    words = {w[:5] for w in re.findall(r"[a-z]{3,}", t) if w not in _STOP} - _STOP_STEMS
    return words, nums


def overlap(a: tuple[set[str], set[str]], b: tuple[set[str], set[str]]) -> float:
    """Overlap coefficient of two content_stems results; 0 when their numbers disagree."""
    (wa, na), (wb, nb) = a, b
    if (na or nb) and not (na <= nb or nb <= na):
        return 0.0
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def same_party(a: str | None, b: str | None, fact_a: str = "", fact_b: str = "") -> bool:
    """The same person/organization, or a person and their company named together ("IT Rapid,
    prin Bogdan"): equal names, one name inside the other, or each fact names the other party."""
    fa, fb = fold(a).strip(), fold(b).strip()
    if not fa or not fb:
        return fa == fb
    if fa == fb:
        return True
    ma, mb = NameMatcher(a or ""), NameMatcher(b or "")
    if (mb.valid and mb.search(a)) or (ma.valid and ma.search(b)):
        return True
    return bool((mb.valid and mb.search(fact_a)) or (ma.valid and ma.search(fact_b)))


_DECIDE_AFTER = re.compile(
    r"^[^.;:]{0,80}?(?<![-\w])(?:a|au|am|l-a|le-a|i-a)\s+(?:luat\s+decizia|hotar|decis|decid|aprob|ales|stabil|accept|semnat|"
    r"convenit|renuntat|reziliat|anulat|revenit|ales)"
)
_DECIDE_BEFORE = re.compile(r"(?:luata|luat|hotarata?|hotarat|aprobata?|decisa?|semnata?|stabilita?|aleasa?)\s+de\s+(?:catre\s+)?$")


def decided_by_in_text(name: str, text: str) -> bool:
    """`name` is the grammatical decider in `text`: "Ioana (administrator) a hotărât ...",
    "Mihai a aprobat ...", "decizia a fost luată de Ioana"."""
    m = NameMatcher(name or "")
    if not m.valid:
        return False
    t = fold_text(text or "")
    for a, b in m.spans(text):
        if _DECIDE_BEFORE.search(t[max(0, a - 40):a]):
            return True
        after = t[b:b + 120]
        before = t[max(0, a - 40):a]
        in_parens = before.rfind("(") > before.rfind(")")  # "Mihai (contabil la Brutăria Spiga)"
        if (_DECIDE_AFTER.search(after) and not in_parens
                and not re.search(r"\b(?:cu|la|de la|catre|lui|pentru|al|ale|ai)\s+$", before)):
            return True
    return False


def pick_decider(by: str | None, subject: str | None, obj: str | None, episode_text: str,
                 candidates: list[str]) -> str | None:
    """The owner of a decision: keep `by` when the text says they decided; otherwise the one
    candidate the text names as decider; otherwise never the decision's object (the supplier or
    client the decision is about) when the subject differs."""
    if by and decided_by_in_text(by, episode_text):
        return by
    deciders = []
    for c in candidates:
        if c and decided_by_in_text(c, episode_text) and not any(same_party(c, d) for d in deciders):
            deciders.append(c)
    if len(deciders) == 1:
        return deciders[0]
    if len(deciders) > 1:
        # several deciders in the episode: the one this fact is about
        for d in deciders:
            if same_party(d, subject) or same_party(d, by):
                return d
    if by and obj and subject and fold(by).strip() == fold(obj).strip() and fold(subject).strip() != fold(obj).strip():
        return subject
    return by


DELIVERY_RE = re.compile(
    r"\b(?:cu\s+)?(?:livr|pred|lans|finaliz|termin|gata|punerea\s+online|darea\s+in\s+folosinta|montaj|instal)\w*"
    r"[^.;]{0,80}?\b(?:pana\s+(?:pe|la|in)?|cel\s+tarziu|pe|la|in|pentru)\s+"
    r"(?:\d{1,2}\s+(?:ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)"
    r"(?:\s+20\d\d)?|20\d\d-\d\d-\d\d|sfarsitul\s+lunii\w*|finalul\s+lunii\w*)"
)


def delivery_clause(text: str) -> str | None:
    """The 'delivery / launch by <date>' clause of an agreement, in the original spelling."""
    t = fold_text(text or "")
    m = DELIVERY_RE.search(t)
    if not m:
        return None
    a, b = m.span()
    clause = text[a:b]
    return re.sub(r"(?i)^cu\s+", "", clause).strip()


REVIEW_SYSTEM = """\
You check facts that were just extracted from ONE summary of a business conversation (usually
Romanian) before they are saved in a company's long-term memory. Return only JSON.

You get: EPISODE (the summary and its date, with a table of resolved relative dates), NEW_FACTS
(facts extracted from this episode, each with its subject and object), INVALIDATIONS (older facts
the system wants to mark as no longer true, with the new facts that would replace them) and
OPEN_PROMISES (earlier promises of this company that are still open).

1. For every NEW_FACT decide "kind":
   - "decision": a choice that WAS MADE by a named person/organization, with a decision verb
     (hotărât, decis, aprobat, ales, stabilit, acceptat, semnat, convenit, renunțat, reziliat,
     revenit asupra deciziei). Proposals ("a propus"), discussions ("am discutat", "s-a discutat"),
     opinions, "vrea să se gândească", "nu s-a hotărât nimic", a price or condition someone simply
     stated, something that "rămâne"/"este tot" unchanged, and promises are NOT decisions. But a
     decision verb about keeping something ("s-a hotărât ca prețul să rămână ...", "decizia a fost
     luată de Ioana") IS a decision.
   - "promise": a commitment by a named person/organization to do something for another one
     (trimite, livrează, plătește, sună, programează, termină, depune, anunță, răspunde, înlocuiește,
     returnează banii). A habit ("livrează de obicei marțea") or something already done is not a
     promise.
   - "fact": everything else (prices, contracts that exist, schedules, quantities, completed actions).
   For decisions give "by": the person (or own company) who made the choice - the subject of the
   decision verb or the "luată de X" - never the supplier, client or partner the decision is
   about ("Ioana a hotărât să cumpărăm de la Moara Verde": by = Ioana, not Moara Verde). For promises give "by" (who promised), "to" (to whom),
   "due" (YYYY-MM-DD, taken from the date table for relative dates such as "vineri", "mâine",
   "lunea viitoare", "până la sfârșitul lunii"; when the promise is tied to an event of the same
   episode - a reservation, a visit, a delivery day - its due date is that event's date; null only
   if there is no deadline at all) and "status" (open, or done / cancelled if this same episode
   says so). A sentence that only reports something already done ("a trimis", "a plătit") is a
   "fact", even if it mentions the earlier promise. Use full names exactly as written; never confuse two
   people with similar names (Ana Popa vs Ana Popescu, Marius Ene vs Marius Enache).

2. For every INVALIDATION decide "valid": true only if a NEW fact EXPLICITLY makes the old fact
   no longer true about the SAME subject and the SAME attribute: a new price for the same product
   from the same seller, a new deadline for the same commitment, a different supplier for the same
   goods, a contract or subscription that was ended, a decision that was withdrawn. Otherwise false:
   different products, different contracts, an additional arrangement (August rooms do not replace
   July rooms), a restatement of the same value, a related but separate event, a promise that was
   simply fulfilled (use OPEN_PROMISES "done" for that instead), or a fact whose value the episode
   says is unchanged.

3. "deadline_promises": an agreement or decision that fixes a delivery, hand-over, launch or
   completion date ("site nou ..., cu predarea site-ului până pe 15 decembrie", "lansarea
   site-ului până pe 1 martie") also creates a commitment. For every such deadline that no
   NEW_FACT promise already covers (same thing, same date), return {"i": index of the fact that
   contains it, "by": who must deliver, "to": for whom, "what": short Romanian phrase with a verb
   in the subjunctive ("predea site-ul refăcut"), "due": "YYYY-MM-DD"}. Otherwise an empty list.

4. For OPEN_PROMISES: report only those this episode says were fulfilled ("done": delivered, sent,
   paid, finished) or called off ("cancelled": no longer happens, replaced by something else).
   A promise whose deadline merely moved is "superseded" only if a NEW fact restates it with the
   new deadline; then mark it "cancelled" is wrong - leave it out.

Output exactly:
{"facts": [{"i": 0, "kind": "decision|promise|fact", "by": "...|null", "to": "...|null", "due": "YYYY-MM-DD|null", "status": "active|reversed|open|done|cancelled|null"}],
 "invalidations": [{"j": 0, "valid": true}],
 "deadline_promises": [{"i": 0, "by": "...", "to": "...", "what": "...", "due": "YYYY-MM-DD"}],
 "open_promises": [{"p": 0, "status": "done|cancelled"}]}
Include every NEW_FACT index and every INVALIDATION index exactly once."""


def _fmt_date(v: Any) -> str | None:
    if v is None:
        return None
    try:
        return v.date().isoformat() if isinstance(v, datetime) else str(v)[:10]
    except Exception:
        return None


async def _node_names(driver, nodes: list[EntityNode], uuids: set[str], group_id: str) -> dict[str, str]:
    names = {n.uuid: n.name for n in nodes}
    missing = [u for u in uuids if u not in names]
    if missing:
        for n in only_group(await EntityNode.get_by_uuids(driver, missing, group_id=group_id), group_id):
            names[n.uuid] = n.name
    return names


async def _open_promises(driver, group_id: str, exclude: set[str], entity_ids: set[str]) -> list[dict]:
    """The company's open promises the review may close or merge: only those that involve an
    entity of this episode (a promise reported done names its promiser or beneficiary), newest
    first. Before 2026-11-14 it was the 40 newest of the whole company on every episode, which
    grew the review prompt with the company instead of with the episode."""
    return await scoped_query(
        driver,
        group_id,
        """
        MATCH (s:Entity {group_id: $g})-[e:RELATES_TO {group_id: $g}]->(t:Entity {group_id: $g})
        WHERE toLower(e.name) IN $names AND e.expired_at IS NULL AND e.invalid_at IS NULL
          AND coalesce(toLower(e.status), 'open') = 'open' AND NOT e.uuid IN $exclude
          AND (s.uuid IN $ids OR t.uuid IN $ids)
        RETURN e.uuid AS uuid, e.fact AS fact, e.due_date AS due, s.name AS sn, t.name AS tn,
               e.promised_by AS by, e.promised_to AS to
        ORDER BY e.created_at DESC LIMIT 25
        """,
        names=sorted(PROMISE_NAMES), exclude=sorted(exclude), ids=sorted(entity_ids),
    )


async def review_edges(
    llm: Any,
    driver: Any,
    episode: Any,
    nodes: list[EntityNode],
    resolved: list[EntityEdge],
    invalidated: list[EntityEdge],
    new_edges: list[EntityEdge],
    invalidated_by: dict[str, list[str]],
    group_id: str,
) -> tuple[list[EntityEdge], list[EntityEdge], list[EntityEdge], dict]:
    ref = episode.valid_at
    ep_date = local_date(ref).isoformat() if ref else None
    stats = {"reclassified": 0, "decisions_rejected": 0, "invalidations_restored": 0, "promises_closed": 0,
             "duplicates_dropped": 0, "llm": False}

    # drop exact duplicates among this episode's new facts (same text between the same names)
    new_ids = {e.uuid for e in new_edges}
    seen: set[str] = set()
    dropped: set[str] = set()
    for e in new_edges:
        key = fold(e.fact).strip(" .")
        if key in seen:
            dropped.add(e.uuid)
        seen.add(key)
    if dropped:
        stats["duplicates_dropped"] = len(dropped)
        resolved = [e for e in resolved if e.uuid not in dropped]
        new_edges = [e for e in new_edges if e.uuid not in dropped]

    # Graphiti clears the attributes of an existing fact that this episode merely repeats when its
    # type has no attribute fields (ours are filled here): put the stored ones back.
    repeated = [e for e in resolved if e.uuid not in new_ids]
    if repeated:
        stored = {o.uuid: o for o in only_group(await EntityEdge.get_by_uuids(driver, [e.uuid for e in repeated]), group_id)}
        for e in repeated:
            o = stored.get(e.uuid)
            if o is not None and o.attributes and not e.attributes:
                e.attributes = dict(o.attributes)
            # Graphiti expires a repeated fact that carries a scheduled end ("contract până în
            # decembrie 2027") as soon as it is restated; it is still current until that date.
            if (o is not None and o.expired_at is None and e.expired_at is not None and ref is not None
                    and e.invalid_at is not None and e.invalid_at > ref):
                e.expired_at = None
                stats["scheduled_end_kept"] = stats.get("scheduled_end_kept", 0) + 1

    # a combined schedule ("L-V 8-16, S 9-13") becomes one fact per day group, so that a later
    # change of one day replaces only that day
    for e in list(new_edges):
        if e.name.lower() in DECISION_NAMES | PROMISE_NAMES:
            continue
        parts = split_schedule(e.fact)
        if len(parts) < 2:
            continue
        e.fact, e.fact_embedding = parts[0], None
        clones = [_clone(e, fact=p) for p in parts[1:]]
        for old_uuid, by in invalidated_by.items():
            if e.uuid in by:
                by.extend(c.uuid for c in clones)
        resolved.extend(clones)
        new_edges.extend(clones)
        new_ids.update(c.uuid for c in clones)
        stats["schedules_split"] = stats.get("schedules_split", 0) + 1

    endpoint_ids = {u for e in resolved + invalidated for u in (e.source_node_uuid, e.target_node_uuid)}
    names = await _node_names(driver, nodes, endpoint_ids, group_id)
    open_promises = await _open_promises(driver, group_id, new_ids, {n.uuid for n in nodes} | endpoint_ids)
    by_uuid = {e.uuid: e for e in resolved}

    facts_ctx = [
        {"i": i, "fact": e.fact, "subject": names.get(e.source_node_uuid), "object": names.get(e.target_node_uuid),
         "relation": e.name}
        for i, e in enumerate(new_edges)
    ]
    inv_ctx = []
    for j, old in enumerate(invalidated):
        replacing = [by_uuid[u].fact for u in invalidated_by.get(old.uuid, []) if u in by_uuid]
        inv_ctx.append({"j": j, "old_fact": old.fact, "old_since": _fmt_date(old.valid_at), "replaced_by": replacing})
    prom_ctx = [{"p": k, "fact": p["fact"], "by": p["sn"], "to": p["tn"], "due": p["due"]} for k, p in enumerate(open_promises)]

    data: dict = {}
    if facts_ctx or inv_ctx or prom_ctx:
        user = (
            f"<EPISODE date=\"{ep_date}\">\n{episode.content}\n</EPISODE>\n\n<DATE_TABLE>\n{calendar_hint(ref)}\n</DATE_TABLE>\n\n"
            f"<NEW_FACTS>\n{json.dumps(facts_ctx, ensure_ascii=False)}\n</NEW_FACTS>\n\n"
            f"<INVALIDATIONS>\n{json.dumps(inv_ctx, ensure_ascii=False)}\n</INVALIDATIONS>\n\n"
            f"<OPEN_PROMISES>\n{json.dumps(prom_ctx, ensure_ascii=False)}\n</OPEN_PROMISES>"
        )
        try:
            data = await llm.complete_json(REVIEW_SYSTEM, user, max_tokens=1500 + 120 * len(facts_ctx), step="zm.review")
            stats["llm"] = True
        except QuotaExceeded:
            raise  # the company's monthly token quota is used up: stop the ingest, save nothing
        except Exception as e:  # rules still apply
            log.warning("review call failed (%s); applying rules only", e)

    # 1. classify the new facts
    candidates = sorted({n.name for n in nodes if n.name} | {v for v in names.values() if v}, key=len, reverse=True)
    verdicts = {int(f.get("i", -1)): f for f in data.get("facts", []) if isinstance(f, dict)}
    for i, e in enumerate(new_edges):
        v = verdicts.get(i, {})
        kind = (v.get("kind") or "").lower()
        old_name = e.name
        if not kind:  # no model verdict: keep Graphiti's typing, normalized
            low = e.name.lower()
            kind = "decision" if low in DECISION_NAMES else "promise" if low in PROMISE_NAMES else "fact"
        if kind == "decision" and not (looks_like_decision(e.fact) and _DECISION_VERBS.search(fold(episode.content))):
            # the extractor sometimes writes "X a stabilit" for a plain statement: the verb must be
            # in the source text too
            kind = "fact"
            stats["decisions_rejected"] += 1
        subj, obj = names.get(e.source_node_uuid), names.get(e.target_node_uuid)
        attrs = dict(e.attributes or {})
        if kind == "decision":
            e.name = "Decision"
            by = v.get("by") or attrs.get("decided_by") or subj
            checked = pick_decider(by, subj, obj, episode.content or "", candidates)
            if checked != by:
                stats["owners_fixed"] = stats.get("owners_fixed", 0) + 1
            e.attributes = {
                "decided_by": checked,
                "decision_date": normalize_iso_date(attrs.get("decision_date")) or ep_date,
                "effective_date": normalize_iso_date(attrs.get("effective_date")),
                "status": "reversed" if (v.get("status") == "reversed") else "active",
            }
        elif kind == "promise":
            due = resolve_due(e.fact, ref) if ref else None
            due_s = due.isoformat() if due else (normalize_iso_date(v.get("due")) or normalize_iso_date(attrs.get("due_date")))
            status = (v.get("status") or attrs.get("status") or "open").lower()
            e.name = "Promise"
            p_by = v.get("by") or attrs.get("promised_by") or subj
            p_to = v.get("to") or attrs.get("promised_to") or obj
            if p_by and p_to and fold(p_by).strip() == fold(p_to).strip():  # nobody promises to themselves
                p_by, p_to = (subj, p_to) if fold(subj).strip() != fold(p_to).strip() else (p_by, obj)
            e.attributes = {
                "promised_by": p_by,
                "promised_to": p_to,
                "due_date": due_s,
                "status": status if status in ("open", "done", "cancelled") else "open",
            }
        else:
            if e.name.lower() in DECISION_NAMES | PROMISE_NAMES:
                e.name = "STATES"
            e.attributes = {k: v2 for k, v2 in attrs.items() if k not in ("decided_by", "decision_date", "effective_date", "promised_by", "promised_to", "due_date", "status")}
        if e.invalid_at is not None and ref is not None:
            day0 = ref.replace(hour=0, minute=0, second=0, microsecond=0)
            if (e.valid_at is not None and e.invalid_at <= e.valid_at) or (kind in ("decision", "promise") and e.invalid_at >= day0):
                # a zero-length interval, or a deadline / start date put into invalid_at: a decision
                # or promise made in this episode is current until something replaces it
                e.invalid_at = None
                e.expired_at = None
                stats["end_dates_cleared"] = stats.get("end_dates_cleared", 0) + 1
            elif e.invalid_at > ref:
                # a scheduled end ("contract valabil până în decembrie 2027"): still current today,
                # Graphiti would mark it expired at once
                e.expired_at = None
        if e.name != old_name:
            stats["reclassified"] += 1

    # 2. check the invalidations
    inv_verdicts = {int(x.get("j", -1)): bool(x.get("valid")) for x in data.get("invalidations", []) if isinstance(x, dict)}
    restore: list[EntityEdge] = []
    for j, old in enumerate(invalidated):
        replacing = [by_uuid[u] for u in invalidated_by.get(old.uuid, []) if u in by_uuid]
        shares = any({old.source_node_uuid, old.target_node_uuid} & {r.source_node_uuid, r.target_node_uuid} for r in replacing)
        ok = shares and inv_verdicts.get(j, True if not stats["llm"] else False)
        if not ok:
            restore.append(old)
    if restore:
        originals = {o.uuid: o for o in only_group(await EntityEdge.get_by_uuids(driver, [r.uuid for r in restore]), group_id)}
        for r in restore:
            o = originals.get(r.uuid)
            r.invalid_at = o.invalid_at if o else None
            r.expired_at = o.expired_at if o else None
        restored_ids = {r.uuid for r in restore}
        invalidated = [e for e in invalidated if e.uuid not in restored_ids]
        stats["invalidations_restored"] = len(restore)
    for old in invalidated:
        parts = split_schedule(old.fact)
        if len(parts) < 2:
            continue
        changed = set()
        for u in invalidated_by.get(old.uuid, []):
            if u in by_uuid:
                changed |= schedule_days(by_uuid[u].fact)
        if not changed:
            continue
        for part in parts:
            days = schedule_days(part)
            if days and not (days & changed):
                # this day group did not change: it stays current as its own fact
                keep = _clone(old, fact=part, invalid_at=None, expired_at=None)
                resolved.append(keep)
                new_edges.append(keep)
                stats["schedule_days_kept"] = stats.get("schedule_days_kept", 0) + 1

    # 3. close earlier promises this episode fulfilled or cancelled
    for x in data.get("open_promises", []) or []:
        try:
            p = open_promises[int(x.get("p"))]
        except (TypeError, ValueError, IndexError):
            continue
        status = (x.get("status") or "").lower()
        if status not in ("done", "cancelled"):
            continue
        await scoped_query(
            driver, group_id,
            "MATCH ()-[e:RELATES_TO {uuid: $u, group_id: $g}]->() SET e.status = $s, e.closed_at = $d",
            u=p["uuid"], s=status, d=ep_date,
        )
        stats["promises_closed"] += 1
    # a promise Graphiti invalidated because it was fulfilled: keep it, now with its status
    for e in invalidated + resolved:
        for x in data.get("open_promises", []) or []:
            try:
                p = open_promises[int(x.get("p"))]
            except (TypeError, ValueError, IndexError):
                continue
            if p["uuid"] == e.uuid and (x.get("status") or "") in ("done", "cancelled"):
                e.attributes = {**(e.attributes or {}), "status": x["status"], "closed_at": ep_date}

    # 4. a delivery / launch deadline inside an agreement becomes its own promise
    added = _deadline_promises(data.get("deadline_promises") or [], new_edges, nodes, names, episode, ref, ep_date)
    if added:
        resolved.extend(added)
        new_edges.extend(added)
        stats["deadline_promises_added"] = len(added)

    # 5. merge duplicate / overlapping promises and decisions
    persons = {n.name for n in nodes if n.name and "Person" in (n.labels or [])}
    drop, merged_into = _duplicates(new_edges, open_promises, names, persons)
    if drop:
        resolved = [e for e in resolved if e.uuid not in drop]
        new_edges = [e for e in new_edges if e.uuid not in drop]
        stats["duplicates_merged"] = len(drop)
    for existing_uuid in merged_into:
        # the restated promise keeps its provenance: this episode becomes one of its sources
        await scoped_query(
            driver, group_id,
            "MATCH ()-[e:RELATES_TO {uuid: $u, group_id: $g}]->() "
            "SET e.episodes = CASE WHEN $ep IN coalesce(e.episodes, []) THEN e.episodes ELSE coalesce(e.episodes, []) + $ep END",
            u=existing_uuid, ep=episode.uuid,
        )
    return resolved, invalidated, new_edges, stats


def _clone(e: EntityEdge, **update: Any) -> EntityEdge:
    c = e.model_copy(deep=True)
    c.uuid = str(uuid4())
    c.fact_embedding = None
    for k, v in update.items():
        setattr(c, k, v)
    return c


def _node_for(name: str | None, nodes: list[EntityNode], fallback: str | None) -> str | None:
    if name:
        for n in nodes:
            if fold(n.name).strip() == fold(name).strip():
                return n.uuid
        for n in nodes:
            if same_party(n.name, name):
                return n.uuid
    return fallback


def _deadline_promises(proposed: list, new_edges: list[EntityEdge], nodes: list[EntityNode], names: dict[str, str],
                       episode: Any, ref: datetime | None, ep_date: str | None) -> list[EntityEdge]:
    """Promise edges for delivery deadlines folded into an agreement: the review model proposes
    them; a rule adds one for a decision whose text states such a deadline if the model did not."""
    promised_dues = {(e.attributes or {}).get("due_date") for e in new_edges if e.name == "Promise"}
    by_index = {i: e for i, e in enumerate(new_edges)}
    out: list[EntityEdge] = []

    def make(base: EntityEdge, by: str | None, to: str | None, fact: str, due: str) -> None:
        src = _node_for(by, nodes, base.source_node_uuid)
        dst = _node_for(to, nodes, base.target_node_uuid)
        if src == dst:
            src, dst = base.source_node_uuid, base.target_node_uuid
        p = _clone(base, name="Promise", fact=fact, source_node_uuid=src, target_node_uuid=dst, invalid_at=None,
                   expired_at=None, created_at=datetime.now(timezone.utc))
        p.attributes = {"promised_by": by or names.get(src), "promised_to": to or names.get(dst), "due_date": due, "status": "open"}
        out.append(p)
        promised_dues.add(due)

    for x in proposed:
        if not isinstance(x, dict):
            continue
        try:
            base = by_index[int(x.get("i"))]
        except (TypeError, ValueError, KeyError):
            continue
        due = normalize_iso_date(x.get("due"))
        what = (x.get("what") or "").strip()
        if not due or not what or due in promised_dues or (ep_date and due < ep_date):
            continue
        by, to = x.get("by") or names.get(base.source_node_uuid), x.get("to") or names.get(base.target_node_uuid)
        make(base, by, to, f"{by} s-a angajat față de {to} să {what} până pe {due}.", due)

    for e in list(new_edges):
        if e.name != "Decision" or ref is None:
            continue
        clause = delivery_clause(e.fact)
        due_d = resolve_due(clause, ref) if clause else None
        due = due_d.isoformat() if due_d else None
        if not due or due in promised_dues or (ep_date and due < ep_date):
            continue
        by, to = names.get(e.source_node_uuid), names.get(e.target_node_uuid)
        make(e, by, to, f"{by} s-a angajat față de {to}: {clause} ({due}).", due)
    return out


def _duplicates(new_edges: list[EntityEdge], open_promises: list[dict], names: dict[str, str],
                persons: set[str] | frozenset[str] = frozenset()) -> tuple[set[str], set[str]]:
    """Duplicate promises/decisions among this episode's new facts and against earlier open
    promises. Returns (uuids of new facts to drop, uuids of earlier promises they restate).

    Two promises are the same when they have the same deadline, the same promiser and the same
    beneficiary (a person and their company count as the same party when named together) and
    the same subject (content words overlap >= 0.6, numbers agree). Decisions: same decider and
    content overlap >= 0.75. Of two duplicates in one episode the one made by a person (not
    their company) is kept, then the more complete text."""
    drop: set[str] = set()
    merged_into: set[str] = set()
    every_name = [n for n in set(names.values()) if n]

    def stems(fact: str):
        return content_stems(fact, every_name)

    def same_promise(a_fact, a_by, a_to, a_due, b_fact, b_by, b_to, b_due) -> bool:
        if (a_due or None) != (b_due or None):
            return False
        if not (same_party(a_by, b_by, a_fact, b_fact) and same_party(a_to, b_to, a_fact, b_fact)):
            return False
        return overlap(stems(a_fact), stems(b_fact)) >= 0.6

    proms = [e for e in new_edges if e.name == "Promise" and (e.attributes or {}).get("status", "open") == "open"]
    pf = {fold(p).strip() for p in persons}

    def rank(e: EntityEdge, field: str):
        return (fold((e.attributes or {}).get(field)).strip() not in pf, -len(e.fact or ""))

    proms.sort(key=lambda e: rank(e, "promised_by"))
    kept: list[EntityEdge] = []
    for e in proms:
        a = e.attributes or {}
        twin = next((o for o in open_promises if same_promise(
            e.fact, a.get("promised_by"), a.get("promised_to"), a.get("due_date"),
            o["fact"], o.get("by") or o.get("sn"), o.get("to") or o.get("tn"), normalize_iso_date(o.get("due")))), None)
        if twin is not None:
            drop.add(e.uuid)
            merged_into.add(twin["uuid"])
            continue
        if any(same_promise(e.fact, a.get("promised_by"), a.get("promised_to"), a.get("due_date"),
                            k.fact, (k.attributes or {}).get("promised_by"), (k.attributes or {}).get("promised_to"),
                            (k.attributes or {}).get("due_date")) for k in kept):
            drop.add(e.uuid)
            continue
        kept.append(e)

    decs = sorted([e for e in new_edges if e.name == "Decision"], key=lambda e: rank(e, "decided_by"))
    kept = []
    for e in decs:
        by = (e.attributes or {}).get("decided_by")
        if any(same_party(by, (k.attributes or {}).get("decided_by"), e.fact, k.fact)
               and overlap(stems(e.fact), stems(k.fact)) >= 0.75 for k in kept):
            drop.add(e.uuid)
            continue
        kept.append(e)
    return drop, merged_into
