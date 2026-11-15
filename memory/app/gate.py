"""Cheap pre-ingest check: is there anything worth remembering in this summary?

Graphiti spends several LLM calls per episode. One short Haiku call (or none, for very short
texts) lets us skip summaries with nothing new: small talk, "ok, mersi", status pings.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import settings
from .llm import TextLLM

GATE_SYSTEM = """\
You are a filter in front of a company's long-term memory. You receive the summary of one
finished conversation (usually in Romanian). Decide whether it contains anything worth
remembering for the company later: a decision, a promise or commitment (with or without a
deadline), a price or condition, a change to an earlier arrangement, or a new durable fact about
a client, supplier, person, product or project.
Small talk, greetings, generic questions, purely technical chatter with no business outcome, and
statements with no new information are NOT worth remembering.
Reply with only this JSON object:
{"new_information": true|false, "kinds": ["decision"|"promise"|"price"|"change"|"fact"], "reason": "<max 15 words>"}"""


# v2: the gate cannot see what the memory already holds, so a stated price, term or arrangement is
# kept even when the text calls it unchanged ("costă în continuare", "rămâne"); the extraction
# step dedupes it against the graph. Measured with eval/: v1 dropped such summaries.
GATE_SYSTEM_V2 = GATE_SYSTEM.replace(
    "Small talk, greetings,",
    "You do NOT know what the memory already contains: a price, term, schedule, quantity, contract or "
    "arrangement that is stated is worth remembering even when the text says it is unchanged or "
    "continues (\"în continuare\", \"rămâne\", \"este tot\"). An option that was discussed together with "
    "its figures (a cost, a commission, an offer) is worth remembering even when nothing was decided. "
    "A commitment that was completed, paid, delivered, filed or called off is worth remembering (it closes "
    "an open promise).\n"
    "Small talk, greetings,",
)


@dataclass
class GateResult:
    ingest: bool
    reason: str
    kinds: list[str]
    used_llm: bool


async def novelty_check(llm: TextLLM, summary: str, profile: str | None = None) -> GateResult:
    text = summary.strip()
    if len(text) < settings.min_summary_chars:
        return GateResult(False, f"summary shorter than {settings.min_summary_chars} characters", [], False)
    if not settings.novelty_gate:
        return GateResult(True, "novelty gate disabled", [], False)
    try:
        system = GATE_SYSTEM if (profile or settings.extraction_profile) == "baseline" else GATE_SYSTEM_V2
        data = await llm.complete_json(system, f"<summary>\n{text}\n</summary>", max_tokens=200, step="gate")
    except Exception as e:  # never lose a possibly-important memory because the gate failed
        return GateResult(True, f"gate error, ingesting anyway: {type(e).__name__}", [], True)
    keep = bool(data.get("new_information"))
    reason = str(data.get("reason") or ("new information" if keep else "nothing new"))[:200]
    kinds = [str(k) for k in (data.get("kinds") or [])][:5]
    return GateResult(keep, reason, kinds, True)
