"""Romanian relative-date resolution, anchored on the episode's timestamp.

Used two ways:
* `calendar_hint(ref)` gives the extraction prompts a small table of what "mâine", "vineri",
  "lunea viitoare", "sfârșitul lunii" ... mean for this episode, so the model does not do
  weekday arithmetic itself (it is bad at it);
* `resolve_due(text, ref)` deterministically finds a deadline in a fact's text. The review step
  prefers it over the model's date when it finds one.
"""

from __future__ import annotations

import calendar
import re
import unicodedata
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

RO_TZ = ZoneInfo("Europe/Bucharest")
WEEKDAYS = ["luni", "marti", "miercuri", "joi", "vineri", "sambata", "duminica"]
WEEKDAYS_RO = ["luni", "marți", "miercuri", "joi", "vineri", "sâmbătă", "duminică"]
# articulated forms: "lunea viitoare", "vinerea viitoare"
WEEKDAYS_ART = ["lunea", "martea", "miercurea", "joia", "vinerea", "sambata", "duminica"]
WEEKDAYS_ART_RO = ["lunea", "marțea", "miercurea", "joia", "vinerea", "sâmbăta", "duminica"]
MONTHS = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august",
          "septembrie", "octombrie", "noiembrie", "decembrie"]
NUMBERS = {"o": 1, "un": 1, "una": 1, "doua": 2, "doi": 2, "trei": 3, "patru": 4, "cinci": 5, "sase": 6,
           "sapte": 7, "opt": 8, "noua": 9, "zece": 10}


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def local_date(ref: datetime) -> date:
    if ref.tzinfo is None:
        return ref.date()
    return ref.astimezone(RO_TZ).date()


def _next_weekday(d: date, wd: int, *, strictly_after: bool = True) -> date:
    delta = (wd - d.weekday()) % 7
    if delta == 0 and strictly_after:
        delta = 7
    return d + timedelta(days=delta)


def _end_of_month(d: date) -> date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _business_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def calendar_hint(ref: datetime) -> str:
    d = local_date(ref)
    monday = d - timedelta(days=d.weekday())
    nxt = monday + timedelta(days=7)
    lines = [
        f"Episode date (REFERENCE_TIME, Romania): {WEEKDAYS_RO[d.weekday()]} {d.isoformat()}.",
        "Resolve relative Romanian dates with this table (do not compute weekdays yourself):",
        f"- azi/astăzi = {d}; mâine = {d + timedelta(days=1)}; poimâine = {d + timedelta(days=2)}",
    ]
    for i, name in enumerate(WEEKDAYS_RO):
        lines.append(f"- (până) {name} = {_next_weekday(d, i)}; {WEEKDAYS_ART_RO[i]} viitoare / {name} viitoare = {nxt + timedelta(days=i)}")
    lines += [
        f"- săptămâna asta / până la sfârșitul săptămânii = {monday + timedelta(days=4)} (vineri)",
        f"- săptămâna viitoare = between {nxt} and {nxt + timedelta(days=6)}; use {nxt + timedelta(days=4)} as the deadline",
        f"- în două săptămâni = {d + timedelta(days=14)}; într-o săptămână = {d + timedelta(days=7)}",
        f"- sfârșitul lunii / final de lună = {_end_of_month(d)}; sfârșitul lunii viitoare = {_end_of_month(_add_months(d.replace(day=1), 1))}",
        f"- 5 zile lucrătoare = {_business_days(d, 5)}; 10 zile lucrătoare = {_business_days(d, 10)}",
        f"- \"pe 3 ale lunii viitoare\" = {_add_months(d.replace(day=1), 1).replace(day=3)}",
        "- A date written without a year is the next such date on or after the episode date.",
    ]
    return "\n".join(lines)


def _abs_date(day: int, month: int, ref: date) -> date | None:
    try:
        cand = date(ref.year, month, day)
    except ValueError:
        return None
    if cand < ref - timedelta(days=60):
        try:
            cand = date(ref.year + 1, month, day)
        except ValueError:
            return None
    return cand


def resolve_due(text: str, ref: datetime) -> date | None:
    """The deadline stated in `text`, or None. Only clear expressions are resolved."""
    t = _fold(text)
    d = local_date(ref)
    m = re.search(r"\b(20\d\d)-(\d\d)-(\d\d)\b", t)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            pass
    m = re.search(r"\b(?:pe|la|din|pana pe|pana la|pana in)?\s*(\d{1,2})\s+(" + "|".join(MONTHS) + r")(?:\s+(20\d\d))?\b", t)
    if m:
        day, month = int(m[1]), MONTHS.index(m[2]) + 1
        if m[3]:
            try:
                return date(int(m[3]), month, day)
            except ValueError:
                return None
        return _abs_date(day, month, d)
    m = re.search(r"\bpe (\d{1,2}) ale lunii viitoare\b", t)
    if m:
        try:
            return _add_months(d.replace(day=1), 1).replace(day=int(m[1]))
        except ValueError:
            return None
    m = re.search(r"\bpe (\d{1,2}) ale lunii\b|\bpana pe (\d{1,2})\b(?! ale)", t)
    if m:
        day = int(m[1] or m[2])
        try:
            cand = d.replace(day=day)
        except ValueError:
            return None
        return cand if cand >= d else _add_months(cand, 1)
    if re.search(r"\bpoimaine\b", t):
        return d + timedelta(days=2)
    if re.search(r"\bmaine\b", t):
        return d + timedelta(days=1)
    if re.search(r"\b(azi|astazi)\b", t) and re.search(r"\bpana\b", t):
        return d
    m = re.search(r"\b(\d+|" + "|".join(NUMBERS) + r") zile lucratoare\b", t)
    if m:
        n = int(m[1]) if m[1].isdigit() else NUMBERS[m[1]]
        return _business_days(d, n)
    m = re.search(r"\b(?:in|peste) (\d+|" + "|".join(NUMBERS) + r") (zile|saptamani|saptamana)\b", t)
    if m:
        n = int(m[1]) if m[1].isdigit() else NUMBERS[m[1]]
        return d + timedelta(days=n * (1 if m[2] == "zile" else 7))
    if re.search(r"\b(in|peste) o saptamana\b|\bintr-o saptamana\b", t):
        return d + timedelta(days=7)
    if re.search(r"\bsfarsitul lunii viitoare\b|\bfinalul lunii viitoare\b", t):
        return _end_of_month(_add_months(d.replace(day=1), 1))
    if re.search(r"\b(sfarsitul|finalul|final de|sfarsit de) (lunii|luna)\b", t):
        return _end_of_month(d)
    if re.search(r"\b(sfarsitul|finalul) saptamanii\b|\bsaptamana (asta|aceasta|curenta)\b", t):
        return d - timedelta(days=d.weekday()) + timedelta(days=4)
    if re.search(r"\bsaptamana viitoare\b", t):
        return d - timedelta(days=d.weekday()) + timedelta(days=11)
    for i, wd in enumerate(WEEKDAYS):
        if re.search(rf"\b({wd}|{WEEKDAYS_ART[i]}) viito(are|r)\b", t):
            return d - timedelta(days=d.weekday()) + timedelta(days=7 + i)
    for i, wd in enumerate(WEEKDAYS):
        if re.search(rf"\b({wd}|{WEEKDAYS_ART[i]})\b", t):
            return _next_weekday(d, i)
    return None


def normalize_iso_date(value: object) -> str | None:
    """'2026-03-20', '2026-03-20T00:00:00Z' -> '2026-03-20'; anything else -> None."""
    if value is None:
        return None
    m = re.match(r"^\s*(20\d\d)-(\d\d)-(\d\d)", str(value))
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None
