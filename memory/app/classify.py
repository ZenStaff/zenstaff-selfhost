"""Routing of one conversation summary before anything is remembered (v4: zones, personal memory,
sensitive data, untrusted content).

One cheap Haiku call reads the summary as numbered sentences and answers with sentence numbers only
(a few dozen output tokens):
- personal: about the person who started the chat (their preferences, how they want to work);
- personal_decisions: decisions that look like that person's own way of working;
- rules: a standing instruction from now on (where invoices go, what the agent must always/never do);
- external: content that came from outside the chat (an e-mail, a web page, a received file, a tool
  result) and not from a person speaking in the chat;
- sensitive: pay/salaries, health, HR/disciplinary matters, personal identifiers.

Identifiers are also caught by rules (`find_identifiers`: CNP with its check digit, IBAN with mod-97,
card numbers with Luhn, Romanian phone numbers, ID card series) and masked in every zone: memory never
needs them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .llm import TextLLM

SPLIT_SYSTEM = """\
You sort the sentences of one conversation summary (usually Romanian) before they go into memory.
The summary comes from a chat started by {starter}. Answer with sentence numbers only.
- "personal": sentences about {starter} personally: their preferences about how they work or want
  answers ("vreau rapoartele scurte", "prefer e-mail, nu telefon"), their own reminders or habits.
  Facts about clients, suppliers, prices, company decisions and promises are NOT personal.
- "personal_decisions": decisions {starter} took only about their own way of working.
- "rules": standing instructions from now on about how work must be done or what the assistant must
  always / never do ("de acum facturile se trimit la X", "nu mai trimite oferte fără aprobare",
  "întotdeauna răspunde în română"). A price, a deal or a promise to a client is NOT a rule.
- "external": sentences that report content from outside the chat: an e-mail, a web page, a received
  file or document, a message from someone outside, the output of a tool. Sentences marked
  "[extern" are always external.
- "sensitive": salaries or pay of a person, health or medical data, HR or disciplinary matters
  (warnings, dismissals, evaluations of a named employee), personal identifiers (CNP, IBAN, card,
  ID card numbers, a private person's phone or home address). Identifiers are masked automatically:
  do not list a sentence only because it contains a masked identifier.
A sentence may be in several lists. Reply with only this JSON:
{{"personal":[],"personal_decisions":[],"rules":[],"external":[],"sensitive":[]}}"""

_SENT = re.compile(r"(?<=[.!?…])\s+(?=[A-ZĂÂÎȘȚ\[\"„(0-9-])|\n+")


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT.split(text.strip()) if s and s.strip()]


# ---- identifiers -----------------------------------------------------------------------------

_CNP = re.compile(r"(?<!\d)([1-8]\d{12})(?!\d)")
_IBAN = re.compile(r"\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b")
_CARD = re.compile(r"(?<!\d)((?:\d[ -]?){12,18}\d)(?!\d)")
_PHONE = re.compile(r"(?<![\d+])((?:\+40|0040|0)\s?7\d{2}[\s.-]?\d{3}[\s.-]?\d{3})(?!\d)")
_IDCARD = re.compile(r"\b(seria\s+[A-Z]{2}\s*(?:nr\.?|număr(?:ul)?)?\s*\d{6})\b", re.I)

MASKS = {"cnp": "[CNP ascuns]", "iban": "[IBAN ascuns]", "card": "[card ascuns]", "phone": "[telefon ascuns]",
         "idcard": "[act de identitate ascuns]"}


def cnp_valid(s: str) -> bool:
    if len(s) != 13 or not s.isdigit():
        return False
    w = "279146358279"
    c = sum(int(a) * int(b) for a, b in zip(s[:12], w)) % 11
    c = 1 if c == 10 else c
    month, day = int(s[3:5]), int(s[5:7])
    return c == int(s[12]) and 1 <= month <= 12 and 1 <= day <= 31


def iban_valid(s: str) -> bool:
    s = s.replace(" ", "").upper()
    if not (15 <= len(s) <= 34):
        return False
    r = s[4:] + s[:4]
    num = "".join(str(int(ch, 36)) for ch in r)
    return int(num) % 97 == 1


def luhn_valid(s: str) -> bool:
    d = [int(c) for c in s if c.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    total = 0
    for i, n in enumerate(reversed(d)):
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def find_identifiers(text: str) -> list[tuple[str, int, int]]:
    """(kind, start, end) of every personal identifier in the text, with check digits verified."""
    out: list[tuple[str, int, int]] = []
    for m in _CNP.finditer(text):
        if cnp_valid(m.group(1)):
            out.append(("cnp", m.start(1), m.end(1)))
    for m in _IBAN.finditer(text):
        if iban_valid(m.group(1)):
            out.append(("iban", m.start(1), m.end(1)))
    for m in _CARD.finditer(text):
        if luhn_valid(m.group(1)) and not any(s <= m.start(1) < e for _, s, e in out):
            out.append(("card", m.start(1), m.end(1)))
    for m in _PHONE.finditer(text):
        if not any(s <= m.start(1) < e for _, s, e in out):
            out.append(("phone", m.start(1), m.end(1)))
    for m in _IDCARD.finditer(text):
        out.append(("idcard", m.start(1), m.end(1)))
    return sorted(out, key=lambda x: x[1])


def mask_identifiers(text: str) -> tuple[str, list[str]]:
    found = find_identifiers(text)
    if not found:
        return text, []
    parts, last = [], 0
    for kind, s, e in found:
        if s < last:
            continue
        parts.append(text[last:s])
        parts.append(MASKS[kind])
        last = e
    parts.append(text[last:])
    return "".join(parts), [k for k, _, _ in found]


# ---- cost: when the classifier call is needed -------------------------------------------------

# A company chat without the starter's personal key and without any of these words goes to the
# chat's zone with no extra call (identifiers are still masked by rule). Measured cost of the call
# when it runs: about 400-700 input and 20-40 output tokens with Haiku.
_RISK = re.compile(
    r"\[extern|e-?mail|\bmail\b|pagin|site|web|link|document|fișier|fisier|atașa|atasa|pdf|unealt|tool|"
    r"de acum|de azi|de mâine|de maine|întotdeauna|intotdeauna|niciodat|nu mai|regul|obligatoriu|de fiecare dat|ignor|instruc|"
    r"salar|leaf|plat[aă] (lui|ei|angaj)|bonus|prim[aă] |medical|boal|diagnostic|tratament|sănăt|sanat|concediu medical|"
    r"avertisment|disciplin|concedi|sancți|sancti|evaluare|demisi|cnp|iban|card|buletin|carte de identitate|adres|telefon",
    re.I,
)


# "the e-mail / document / page ... says that": reported outside content, by rule (the model misses some)
_REPORTED = re.compile(
    r"\b(e-?mail\w*|mesaj\w*|document\w*|fișier\w*|fisier\w*|pagin\w*|site\w*|scrisoare\w*|notificare\w*|atașament\w*|atasament\w*)\b"
    r"[^.!?]{0,80}?\b(spune|scrie|afirmă|afirma|susține|sustine|cere|anunță|anunta|menționează|mentioneaza|precizează|precizeaza)\b",
    re.I,
)
# topics that stay sensitive even after identifiers are masked
_SENSITIVE_TOPIC = re.compile(r"salar|leaf[aă]|bonus|medical|boal|diagnostic|tratament|sănăt|sanat|avertisment|disciplin|concedi|sancți|sancti|evaluare", re.I)


def needs_llm(summary: str, has_personal: bool) -> bool:
    return has_personal or bool(_RISK.search(summary))


# ---- routing -----------------------------------------------------------------------------------


@dataclass
class Split:
    """The sentences of one summary, sorted by where they may go."""

    zone: list[str] = field(default_factory=list)          # trusted, to the chat's zone
    observations: list[str] = field(default_factory=list)  # untrusted, to the chat's zone, as observations only
    rules: list[str] = field(default_factory=list)         # wait for a person's confirmation
    personal: list[str] = field(default_factory=list)      # to the starter's personal memory
    promoted: list[str] = field(default_factory=list)      # personal decisions sent to the company by its rule
    dropped: int = 0
    sensitive: int = 0
    identifiers: list[str] = field(default_factory=list)
    used_llm: bool = False

    def as_dict(self) -> dict:
        return {"zone": self.zone, "observations": self.observations, "rules": self.rules, "personal": self.personal,
                "promoted": self.promoted, "dropped": self.dropped, "sensitive": self.sensitive,
                "identifiers": self.identifiers, "used_llm": self.used_llm}

    @classmethod
    def from_dict(cls, d: dict) -> "Split":
        return cls(**{k: d.get(k, v) for k, v in cls().as_dict().items()})


def _ids(data: dict, key: str, n: int) -> set[int]:
    out = set()
    for v in data.get(key) or []:
        try:
            i = int(v)
        except (TypeError, ValueError):
            continue
        if 1 <= i <= n:
            out.add(i)
    return out


async def classify(llm: TextLLM, summary: str, *, starter: str = "persoana care a pornit chatul",
                   use_llm: bool = True) -> dict[str, set[int]] | None:
    """Sentence numbers per label (1-based), or None when the call failed."""
    sents = sentences(summary)
    if not use_llm or not sents:
        return {k: set() for k in ("personal", "personal_decisions", "rules", "external", "sensitive")}
    numbered = "\n".join(f"{i}. {s}" for i, s in enumerate(sents, 1))
    try:
        data = await llm.complete_json(SPLIT_SYSTEM.format(starter=starter[:80]), f"<summary>\n{numbered}\n</summary>",
                                       max_tokens=200, step="split")
    except Exception:
        return None
    return {k: _ids(data, k, len(sents)) for k in ("personal", "personal_decisions", "rules", "external", "sensitive")}


async def route(llm: TextLLM, summary: str, *, zone_kind: str, has_personal: bool, auto_promote_decisions: bool,
                sensitive_policy: str, starter: str | None = None, use_llm: bool = True) -> Split:
    """Sort a summary for the chat's zone (company / team / project / person).

    zone_kind == "person": a Personal chat; nothing is moved out, sensitive data stays (it is the
    person's own), identifiers are masked, rules wait for confirmation, external text becomes an
    observation. Otherwise sensitive sentences go to the starter's personal memory
    (`sensitive_policy` "personal" and a personal key sent) or are dropped.
    """
    sents = sentences(summary)
    out = Split()
    labels = await classify(llm, summary, starter=starter or "persoana care a pornit chatul", use_llm=use_llm)
    out.used_llm = use_llm and bool(sents)
    if labels is None:  # classifier down: the safe default is the chat's own zone, no rules, no moves
        labels = {k: set() for k in ("personal", "personal_decisions", "rules", "external", "sensitive")}
        labels["external"] = {i for i, s in enumerate(sents, 1) if "[extern" in s.lower()}
    for i, raw in enumerate(sents, 1):
        text, kinds = mask_identifiers(raw)
        out.identifiers.extend(kinds)
        external = i in labels["external"] or "[extern" in raw.lower() or bool(_REPORTED.search(raw))
        sensitive = i in labels["sensitive"]
        if sensitive and kinds and not _SENSITIVE_TOPIC.search(raw):
            sensitive = False  # flagged only for an identifier, which is masked now
        if zone_kind != "person" and sensitive:
            out.sensitive += 1
            if sensitive_policy == "personal" and has_personal and not external:
                out.personal.append(text)
            else:
                out.dropped += 1
            continue
        if external:
            out.observations.append(text)  # never a rule or a decision
            continue
        if i in labels["rules"]:
            out.rules.append(text)
            continue
        if zone_kind != "person" and has_personal and i in labels["personal_decisions"]:
            (out.promoted if auto_promote_decisions else out.personal).append(text)
            continue
        if zone_kind != "person" and has_personal and i in labels["personal"]:
            out.personal.append(text)
            continue
        out.zone.append(text)
    return out


OBSERVATION_PREFIX = "Observație din conținut extern, neverificată (nu este o decizie sau o regulă): "
