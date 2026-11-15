"""Romanian-aware name matching for GDPR erasure (pure functions, no dependencies).

`NameMatcher("Ana Popa")` finds the name in free text in any case, with or without diacritics,
and in its declined forms:

- feminine names in -a take -ei / -ăi in the genitive-dative: Ana -> Anei, Maria -> Mariei
  (also the colloquial Marii), Ioana -> Ioanei, Popa -> Popei;
- names in -e take -i: Beatrice -> Beatricei, Ene -> Enei;
- names in a consonant take -ului: Ion -> Ionului, Pop -> Popului;
- names in -u / -o take -lui: Radu -> Radului;
- the analytic forms ("lui Ion Pop", "doamnei Popa") contain the base form and are found as is.

A multi-word name matches only as a whole (every word, in this or reversed order, each word in
any of its forms), never one word alone, so "Ana" in another context is not touched. Words are
matched whole: "Ana" does not match "Anabela", "Pop" does not match "Popescu", "Ana Popa" does
not match "Ana Popescu".

Matching runs on a per-character folded copy of the text (lowercase, diacritics removed, same
length), so spans map back 1:1 to the original text and replacements keep everything else intact.
"""

from __future__ import annotations

import re
import unicodedata

_MIN_LEN = 3  # a name shorter than this (after folding) is too ambiguous to erase by text


def _fold_char(c: str) -> str:
    d = unicodedata.normalize("NFKD", c)
    base = "".join(x for x in d if not unicodedata.combining(x))
    if not base:
        return c
    low = base.lower()
    return low[0] if low else c


def fold_text(text: str) -> str:
    """Lowercase, diacritics removed, exactly one output character per input character."""
    return "".join(_fold_char(c) for c in text)


def fold(text: str) -> str:
    return fold_text(text or "")


def word_forms(word: str) -> list[str]:
    """Folded forms of one name word: base + Romanian genitive/dative endings."""
    w = fold(word).strip()
    if not w:
        return []
    forms = {w}
    if len(w) < _MIN_LEN or not w[-1].isalpha():
        return sorted(forms)
    last = w[-1]
    if last == "a":
        stem = w[:-1]
        forms |= {stem + "ei", stem + "ai"}  # Ana -> Anei / Anăi, Popa -> Popei
        if stem.endswith("i"):
            forms.add(stem + "i")  # Maria -> Marii (colloquial)
        if stem.endswith(("c", "g")):
            forms.add(stem + "hei")  # Bianca -> Bianchei
    elif last == "e":
        forms.add(w + "i")  # Beatrice -> Beatricei, Ene -> Enei
    elif last in "uo":
        forms.add(w + "lui")  # Radu -> Radului
    elif last == "i":
        forms.add(w + "i")  # Mihai -> (rare) Mihaii
        forms.add(w + "ului")  # Mihai -> Mihaiului
    elif last.isalpha():
        forms.add(w + "ului")  # Ion -> Ionului, Pop -> Popului
    return sorted(forms, key=len, reverse=True)


def _words(name: str) -> list[str]:
    return [w for w in re.split(r"[\s]+", fold(name).strip()) if w]


class NameMatcher:
    """Finds a person's or organization's name (and its declined forms) in text."""

    def __init__(self, name: str):
        self.name = name or ""
        words = _words(self.name)
        self.valid = bool(words) and len("".join(words)) >= _MIN_LEN
        self._re: re.Pattern[str] | None = None
        if not self.valid:
            return
        alts = [self._seq(words)]
        if len(words) == 2:
            alts.append(self._seq(list(reversed(words))))  # "Popa Ana"
        self._re = re.compile(r"(?<![\w])(?:" + "|".join(alts) + r")(?![\w])")

    @staticmethod
    def _seq(words: list[str]) -> str:
        parts = []
        for w in words:
            forms = word_forms(w) if re.fullmatch(r"[a-z]+", w) else [w]
            parts.append("(?:" + "|".join(re.escape(f) for f in forms) + ")")
        # words separated by whitespace, optionally a hyphen ("Popa-Ionescu" keeps its hyphen)
        return r"[\s]+".join(parts)

    def spans(self, text: str | None) -> list[tuple[int, int]]:
        if not self.valid or not text:
            return []
        assert self._re is not None
        return [m.span() for m in self._re.finditer(fold_text(text))]

    def search(self, text: str | None) -> bool:
        return bool(self.spans(text))

    def sub(self, repl: str, text: str) -> str:
        """Replace every occurrence in `text` (original casing elsewhere is kept)."""
        out, last = [], 0
        for a, b in self.spans(text):
            out.append(text[last:a])
            out.append(repl)
            last = b
        out.append(text[last:])
        return "".join(out)
