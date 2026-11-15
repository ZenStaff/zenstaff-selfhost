"""Business ontology handed to Graphiti as custom entity and edge types.

Decisions and promises are *edges* (facts between two entities) so they inherit Graphiti's
bi-temporal model: when a later conversation supersedes them, Graphiti sets `invalid_at`
(our `valid_to`) instead of deleting them.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Person(BaseModel):
    """A human: an employee, a client contact, a supplier contact."""

    role: str | None = Field(None, description="Job title or role, e.g. 'manager achiziții'.")


class Organization(BaseModel):
    """A company or institution: a client, a supplier, a partner, or our own company."""

    relationship: str | None = Field(
        None, description="One of: client, supplier, partner, own_company, other."
    )


class Product(BaseModel):
    """A product, service or price-list item that is bought or sold."""

    unit: str | None = Field(None, description="Unit of sale, e.g. 'kg', 'buc', 'lună'.")


class Decision(BaseModel):
    """A decision taken by the company or by a person on its behalf (choosing or dropping a
    supplier, changing a price, approving a plan). The fact text states what was decided."""

    decided_by: str | None = Field(None, description="Who took the decision (person or team name).")
    decision_date: str | None = Field(None, description="ISO date (YYYY-MM-DD) when it was decided.")
    status: str | None = Field(None, description="One of: active, reversed.")


class Promise(BaseModel):
    """A commitment someone made to someone else, usually with a deadline (deliver, call back,
    send an offer, pay). The fact text states what was promised."""

    promised_by: str | None = Field(None, description="Who made the promise.")
    promised_to: str | None = Field(None, description="Who the promise was made to.")
    due_date: str | None = Field(None, description="ISO date (YYYY-MM-DD) of the deadline, if any.")
    status: str | None = Field(None, description="One of: open, done, cancelled.")


ENTITY_TYPES: dict[str, type[BaseModel]] = {
    "Person": Person,
    "Organization": Organization,
    "Product": Product,
}

EDGE_TYPES: dict[str, type[BaseModel]] = {
    "Decision": Decision,
    "Promise": Promise,
}

# Any entity can be on either side of a decision or a promise.
EDGE_TYPE_MAP: dict[tuple[str, str], list[str]] = {("Entity", "Entity"): ["Decision", "Promise"]}

EXTRACTION_INSTRUCTIONS = """\
The text is a summary of a finished business conversation, usually in Romanian.
- Record every decision as a Decision fact and every commitment (with its deadline) as a
  Promise fact. Use ISO dates (YYYY-MM-DD) for decision_date and due_date; resolve relative
  dates ("vineri", "până la final de lună") against the episode reference time.
- Prices: state the amount, currency and unit in the fact text, and the date it applies from.
- When the text says something replaces or cancels an earlier arrangement (new price,
  new supplier, new deadline), state the new fact explicitly so the old one can be invalidated.
- Keep names exactly as written (diacritics included). Keep facts in the language of the text.
"""


# ---- v2 (current) ------------------------------------------------------------------------------
# Measured with eval/ (see README "Extraction quality"). The type descriptions are what the
# extractor reads, so they carry the rules: what is and is not a decision, what a promise must
# record, and when a fact replaces another.


class DecisionV2(BaseModel):
    """A choice that WAS MADE by a named person or organization, stated with a decision verb:
    a hotărât, a decis, a aprobat, a ales, a stabilit, a acceptat, a semnat, a convenit,
    a renunțat, a reziliat, a anulat, a revenit asupra deciziei. Examples: changing supplier,
    setting a price, approving a bonus, signing or ending a contract, hiring. Source = who decided.
    NOT a decision: a proposal ("a propus"), a discussion or an option under consideration
    ("am discutat", "se gândește", "vrea să", "nu s-a hotărât"), an opinion, a plain fact or
    price someone stated, an arrangement that simply continues, or a promise to do something
    (that is a Promise)."""


class PromiseV2(BaseModel):
    """A commitment by a named person or organization (source = who promised) to do something
    for another person or organization (target = to whom): trimite, livrează, plătește, sună,
    programează, termină, depune, anunță, răspunde, înlocuiește. The fact text must contain the
    deadline as written plus the resolved calendar date (YYYY-MM-DD). A changed deadline is a new
    Promise that replaces the old one. NOT a promise: a decision, a general plan owed to nobody,
    a habit ("livrează de obicei marțea"), or something already done."""


# Attribute fields cost one extra LLM call per entity/fact and episode. In v2 the review step
# (review.py) fills decided_by / promised_by / promised_to / due_date / status in one call per
# episode, and entity types carry only their description.
class PersonV2(BaseModel):
    """A human: an employee, a client contact, a supplier contact. Use the full name as written."""


class OrganizationV2(BaseModel):
    """A company, shop, restaurant, institution or team: a client, a supplier, a partner, or our own company."""


class ProductV2(BaseModel):
    """A product, service or price-list item that is bought or sold."""


ENTITY_TYPES_V2: dict[str, type[BaseModel]] = {"Person": PersonV2, "Organization": OrganizationV2, "Product": ProductV2}
EDGE_TYPES_V2: dict[str, type[BaseModel]] = {"Decision": DecisionV2, "Promise": PromiseV2}
EDGE_TYPE_MAP_V2: dict[tuple[str, str], list[str]] = {("Entity", "Entity"): ["Decision", "Promise"]}

EXTRACTION_INSTRUCTIONS_V2 = """\
# BUSINESS MEMORY RULES (the text is a summary of a finished business conversation, usually Romanian)
- Use relation_type "Decision" ONLY for a choice that was actually made, with a decision verb
  (a hotărât, a decis, a aprobat, a ales, a stabilit, a acceptat, a semnat, a reziliat, a revenit).
  Proposals, discussions, opinions, "nu s-a hotărât", plain facts and prices are NOT decisions.
- Use relation_type "Promise" for every commitment to do something for someone, with source = who
  promised and target = to whom. Copy the deadline wording into the fact AND write the resolved
  calendar date in the fact as YYYY-MM-DD, e.g. "... până vineri (2026-03-20)".
- Never invent generic relation names for decisions or promises (no DECIDED, PROMISED, COMMITS_TO,
  PRICE_CHANGE ...): use exactly Decision or Promise. Other facts get a specific predicate
  (SUPPLIES, SELLS_AT_PRICE, HAS_CONTRACT_WITH, WORKS_AT ...).
- An agreement that includes a delivery or completion deadline gives BOTH a Decision (what was
  agreed) and a Promise (who delivers what, to whom, by when).
- The source of a Decision is who decided (the person, or our own company), never the supplier,
  client or partner the decision is about.
- Prices: one fact per product with amount, currency, unit and the date it applies from.
- Opening hours and schedules: one fact per day or day range, e.g. "X are program luni-vineri
  8-16" and "X are program sâmbăta 9-13", so that a later change of one day replaces only that
  day's fact. A message that changes one day ("sâmbăta acum 10-14") is a fact about that day only.
- Something that "rămâne", "este tot", "în continuare" is a restatement: state it as a normal fact.
- Two people with similar names (Ana Popa / Ana Popescu) are different entities: always use the
  full name exactly as written.
- Keep names exactly as written (diacritics included). Write every fact in the language of the
  text: Romanian text gives Romanian facts, never English.
"""
