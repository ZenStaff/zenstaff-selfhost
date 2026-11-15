"""Opening hours as one fact per day group (pure functions, no dependencies).

A combined schedule ("program L-V 8-16, S 9-13; duminica închis") stored as ONE fact is replaced
as a whole when only one day changes. `split_schedule` cuts such a fact into one fact per day
group, each keeping the subject prefix ("Service Auto Turbo: program L-V 8-16",
"Service Auto Turbo: program S 9-13"), so a later "sâmbăta acum 10-14" replaces only Saturday.
`schedule_days` tells which weekdays (0 = Monday) a segment covers.
"""

from __future__ import annotations

import re

from .names import fold_text

_DAYS = {
    "luni": 0, "lunea": 0, "marti": 1, "martea": 1, "miercuri": 2, "miercurea": 2, "joi": 3, "joia": 3,
    "vineri": 4, "vinerea": 4, "sambata": 5, "sambetele": 5, "sambata-duminica": 5, "duminica": 6, "duminicile": 6,
}
_ABBR = {"l": 0, "lu": 0, "ma": 1, "mi": 2, "j": 3, "jo": 3, "v": 4, "vi": 4, "s": 5, "sa": 5, "sb": 5, "d": 6, "du": 6}
_DAY_WORD = r"(?:lunea|luni|martea|marti|miercurea|miercuri|joia|joi|vinerea|vineri|sambetele|sambata|duminicile|duminica)"
_DAY_ABBR = r"(?:lu|ma|mi|jo|vi|sa|sb|du|l|j|v|s|d)"
# A day expression: a range ("de luni pana vineri", "luni-vineri", "L-V"), "weekend", "zilele
# lucratoare", a single day name, or a one/two-letter abbreviation directly followed by hours.
_TIME = r"\d{1,2}(?:[:.]\d{2})?"
_HOURS = rf"(?:{_TIME}\s*(?:-|–|pana la|la|si)\s*{_TIME}|non-?stop|inchis\w*|liber)"
DAY_EXPR = re.compile(
    rf"(?<![\w-])(?:"
    rf"(?:de\s+)?{_DAY_WORD}\s*(?:-|–|pana\s+(?:in|la)?\s*)\s*{_DAY_WORD}"
    rf"|{_DAY_ABBR}\s*-\s*{_DAY_ABBR}(?=[\s:,]*(?:\(|{_HOURS}|program|intre|de la))"
    rf"|(?:in\s+)?weekend(?:ul)?"
    rf"|(?:in\s+)?zilele\s+lucratoare|in\s+timpul\s+saptamanii"
    rf"|{_DAY_WORD}"
    rf"|{_DAY_ABBR}(?=[\s:]*(?:{_TIME}\s*(?:-|–)\s*{_TIME}|inchis|liber))"
    rf")(?![\w])"
)
_HAS_HOURS = re.compile(rf"{_HOURS}|intre\s+(?:orele\s+)?{_TIME}\s+si\s+{_TIME}|de la\s+(?:ora\s+)?{_TIME}")
# where a new day group may start: after ",", ";", " si ", " iar ", "/" (plus optional "in"/"de")
_SEP = re.compile(r"(?:\s*[;,/]\s*|\s+(?:si|iar|plus)\s+|\s*[;,]\s*(?:si|iar)\s+)")


def _day_of(token: str) -> int | None:
    t = token.strip()
    if t in _DAYS:
        return _DAYS[t]
    return _ABBR.get(t)


def schedule_days(text: str) -> set[int]:
    """Weekdays (0 = Monday ... 6 = Sunday) a schedule segment talks about."""
    t = fold_text(text or "")
    days: set[int] = set()
    for m in DAY_EXPR.finditer(t):
        expr = re.sub(r"^(?:de|in)\s+", "", m.group(0)).strip()
        if "weekend" in expr:
            days |= {5, 6}
            continue
        if "lucratoare" in expr or "saptamanii" in expr:
            days |= {0, 1, 2, 3, 4}
            continue
        parts = [p for p in re.split(r"\s*(?:-|–|pana\s+(?:in|la)?)\s*", expr) if p]
        if len(parts) == 2:
            a, b = _day_of(parts[0]), _day_of(parts[1])
            if a is not None and b is not None:
                days |= set(range(a, b + 1)) if a <= b else set(range(a, 7)) | set(range(0, b + 1))
                continue
        d = _day_of(parts[0]) if parts else None
        if d is not None:
            days.add(d)
    return days


def split_schedule(fact: str) -> list[str]:
    """[fact] unless it is a schedule with two or more day groups that each carry hours (or
    "închis"); then one fact per day group, each with the subject prefix of the original."""
    if not fact:
        return [fact]
    t = fold_text(fact)
    starts = [m for m in DAY_EXPR.finditer(t)]
    if len(starts) < 2:
        return [fact]
    # cut points: a day expression right after a separator
    cuts: list[tuple[int, int]] = []  # (separator start, day expression start)
    for m in starts[1:]:
        before = t[: m.start()]
        sep = re.search(r"(?:\s*[;,/]\s*(?:(?:si|iar)\s+)?|\s+(?:si|iar|plus)\s+)(?:(?:in|de)\s+)?$", before)
        if sep:
            cuts.append((sep.start(), m.start()))
    if not cuts:
        return [fact]
    first = starts[0]
    bounds = [(0, cuts[0][0])]
    for i, (sep_start, day_start) in enumerate(cuts):
        end = cuts[i + 1][0] if i + 1 < len(cuts) else len(fact)
        bounds.append((day_start, end))
    segs = [fact[a:b].strip(" ,;/") for a, b in bounds]
    folded = [fold_text(s) for s in segs]
    if len(segs) < 2 or not all(_HAS_HOURS.search(f) and DAY_EXPR.search(f) for f in folded):
        return [fact]
    prefix = fact[: first.start()]
    # "are program de luni până vineri": the "de " belongs to the range, not to the prefix
    prefix = re.sub(r"(?i)\bde\s+$", "", prefix)
    out = [segs[0].rstrip(" .")]
    for s in segs[1:]:
        s = s.rstrip(" .")
        out.append((prefix + s) if prefix and not s.lower().startswith(prefix.lower()) else s)
    end = "." if fact.rstrip().endswith(".") else ""
    return [s + end for s in out]
