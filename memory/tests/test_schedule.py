"""Opening hours split into one fact per day group (pure, no database)."""

from __future__ import annotations

import pytest

from app.schedule import schedule_days, split_schedule


def test_split_long_form():
    f = "Cofetăria Dulce Vis are program de luni până vineri 8-16 și sâmbăta 9-13; duminica este închisă."
    assert split_schedule(f) == [
        "Cofetăria Dulce Vis are program de luni până vineri 8-16.",
        "Cofetăria Dulce Vis are program sâmbăta 9-13.",
        "Cofetăria Dulce Vis are program duminica este închisă.",
    ]


def test_split_abbreviations():
    f = "Service Auto Turbo din Brașov: program L-V 8-16, S 9-13"
    assert split_schedule(f) == ["Service Auto Turbo din Brașov: program L-V 8-16", "Service Auto Turbo din Brașov: program S 9-13"]


def test_split_with_colons_and_minutes():
    f = "Magazinul Bio Natura are program luni-vineri 9:00-20:00, sâmbătă 9:00-14:00, duminică închis"
    out = split_schedule(f)
    assert len(out) == 3 and out[1] == "Magazinul Bio Natura are program sâmbătă 9:00-14:00"
    assert out[2].endswith("duminică închis")


@pytest.mark.parametrize(
    "fact",
    [
        "Furnizorul livrează marțea și vinerea între 8 și 10.",  # one group, two days
        "Sâmbăta și duminica programul este 10-14.",
        "Cofetăria are program sâmbăta 10-14.",
        "Alex trimite oferta joi, iar contractul vineri.",  # no hours
        "Moara Verde livrează făina la două zile, 3,10 lei/kg.",
        "",
    ],
)
def test_not_split(fact):
    assert split_schedule(fact) == [fact]


def test_schedule_days():
    assert schedule_days("program de luni până vineri 8-16") == {0, 1, 2, 3, 4}
    assert schedule_days("program L-V 8-16") == {0, 1, 2, 3, 4}
    assert schedule_days("program S 9-13") == {5}
    assert schedule_days("sâmbăta acum 10-14") == {5}
    assert schedule_days("duminica este închisă") == {6}
    assert schedule_days("în weekend 10-14") == {5, 6}
    assert schedule_days("luni-sâmbătă 9-20") == {0, 1, 2, 3, 4, 5}
    assert schedule_days("Moara Verde livrează făina") == set()
