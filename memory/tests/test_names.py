"""Romanian name matcher used by GDPR erasure (pure, no database)."""

from __future__ import annotations

import pytest

from app.names import NameMatcher, fold_text, word_forms

E = "[șters la cerere]"


@pytest.mark.parametrize(
    "name, text",
    [
        ("Ana Popa", "Am trimis factura Anei Popa ieri."),
        ("Ana Popa", "Am trimis factura ANEI POPA ieri."),
        ("Ana Popa", "Contractul doamnei Ana Popa expiră."),
        ("Ana Popa", "I-am scris Popa Ana pe email."),  # reversed order
        ("Ana Popa", "Am vorbit cu ana popa."),
        ("Ion Pop", "Am dat banii lui Ion Pop."),
        ("Ion Pop", "Mașina Ionului Pop e gata."),
        ("Maria", "I-am trimis Mariei oferta."),
        ("Maria", "I-am trimis Marii oferta."),
        ("Popa", "Am vorbit cu doamna Popei despre factură."),
        ("Ioana", "Contractul Ioanei a fost semnat."),
        ("Bianca", "Biancăi i s-a trimis contractul."),
        ("Bianca", "Bianchei i s-a trimis contractul."),
        ("Radu", "Oferta Radului a sosit."),
        ("Beatrice", "Am dat cheile Beatricei."),
        ("Ștefan Țepeș", "Factura lui Stefan Tepes e plătită."),  # no diacritics in text
        ("Stefan Tepes", "Factura lui Ștefan Țepeș e plătită."),  # no diacritics in name
        ("Ana Popa", "Ana\nPopa a sunat."),
    ],
)
def test_matches_declined_and_variant_forms(name, text):
    assert NameMatcher(name).search(text), (name, text)


@pytest.mark.parametrize(
    "name, text",
    [
        ("Ana", "Anabela a sunat."),
        ("Ana", "Ioana a sunat."),
        ("Ana", "Am vorbit cu Anastasia."),
        ("Pop", "Popescu a trimis factura."),
        ("Pop", "Cabinetul Notarial Popovici."),
        ("Ana Popa", "Ana Popescu a promis oferta."),
        ("Ana Popa", "Anei Popescu i-am trimis oferta."),
        ("Ana Popa", "Ana a vorbit cu Popa Ion."),  # both words, but not as one name
        ("Ana Popa", "Ana a sunat. Popa a răspuns."),
        ("Ion Pop", "Ionel Pop a sunat."),
        ("Ion Pop", "Ion Popa a sunat."),
        ("Maria", "Marian a sunat."),
        ("Maria", "Mariana a sunat."),
        ("Radu", "Radulescu a sunat."),
        ("Marius Ene", "Marius Enache a anunțat clienții."),
        ("Ene", "Enescu a cântat."),
    ],
)
def test_no_false_positives(name, text):
    assert not NameMatcher(name).search(text), (name, text)


def test_sub_keeps_the_rest_of_the_text():
    m = NameMatcher("Ana Popa")
    text = "Ștefan i-a trimis Anei Popa contractul; ANA POPA a confirmat. Ana Popescu nu."
    assert m.sub(E, text) == f"Ștefan i-a trimis {E} contractul; {E} a confirmat. Ana Popescu nu."
    assert NameMatcher("Ion Pop").sub(E, "Banii lui Ion Pop.") == f"Banii lui {E}."


def test_short_or_empty_names_never_match():
    for n in ("", "  ", "Al", "I"):
        m = NameMatcher(n)
        assert not m.valid and not m.search("Al a venit. I a plecat.")
        assert m.sub(E, "Al a venit.") == "Al a venit."


def test_fold_keeps_length():
    s = "ȘȚĂÎÂ șțăîâ şţ ÉÖ"
    assert len(fold_text(s)) == len(s)
    assert fold_text(s) == "staia staia st eo"


def test_word_forms():
    assert {"ana", "anei"} <= set(word_forms("Ana"))
    assert {"popa", "popei"} <= set(word_forms("Popa"))
    assert {"maria", "mariei", "marii"} <= set(word_forms("Maria"))
    assert {"ion", "ionului"} <= set(word_forms("Ion"))
    assert {"radu", "radului"} <= set(word_forms("Radu"))
