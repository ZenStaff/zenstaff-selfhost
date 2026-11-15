"""Deterministic review rules (pure, no database, no LLM)."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode

from app.review import (
    _deadline_promises,
    _duplicates,
    content_stems,
    decided_by_in_text,
    delivery_clause,
    overlap,
    pick_decider,
    same_party,
)

NOW = datetime(2026, 11, 2, 10, 0, tzinfo=timezone.utc)


def node(name: str) -> EntityNode:
    return EntityNode(name=name, group_id="g", labels=["Entity"], created_at=NOW)


def edge(src: EntityNode, dst: EntityNode, name: str, fact: str, **attrs) -> EntityEdge:
    return EntityEdge(group_id="g", source_node_uuid=src.uuid, target_node_uuid=dst.uuid, name=name, fact=fact,
                      episodes=["ep"], created_at=NOW, valid_at=NOW, attributes=attrs)


# ---- decision owners --------------------------------------------------------------------------


def test_decider_found_in_text():
    t = ("La întâlnirea cu Moara Verde (furnizorul de făină) s-a hotărât ca prețul făinii T650 să rămână "
         "3,10 lei/kg; decizia a fost luată de Ioana, administratorul Brutăriei Spiga.")
    assert decided_by_in_text("Ioana", t)
    assert not decided_by_in_text("Moara Verde", t)
    assert not decided_by_in_text("Brutăria Spiga", t)
    assert decided_by_in_text("Mihai", "Mihai (contabil la Brutăria Spiga) a aprobat plata facturii.")
    assert not decided_by_in_text("Brutăria Spiga", "Mihai (contabil la Brutăria Spiga) a aprobat plata facturii.")
    assert decided_by_in_text("Ioana", "Ioana a hotărât ca de la 1 aprilie să cumpărăm de la Morărit Sud.")
    assert not decided_by_in_text("Morărit Sud", "Ioana a hotărât ca de la 1 aprilie să cumpărăm de la Morărit Sud.")


def test_pick_decider_replaces_the_counterparty():
    t = ("La întâlnirea cu Moara Verde s-a hotărât ca prețul să rămână 3,10 lei/kg; decizia a fost luată de Ioana, "
         "administratorul Brutăriei Spiga.")
    cands = ["Brutăria Spiga", "Moara Verde", "Ioana"]
    assert pick_decider("Moara Verde", "Moara Verde", "Brutăria Spiga", t, cands) == "Ioana"
    assert pick_decider("Ioana", "Ioana", "Moara Verde", t, cands) == "Ioana"
    # no decider in the text: at least never the decision's object
    assert pick_decider("Moara Verde", "Ioana", "Moara Verde", "Prețul rămâne 3,10 lei.", cands) == "Ioana"
    # the decider named in the text wins over a wrong guess
    t2 = "Managerul Vlad a aprobat cererea Anei Popescu de a avea o zi liberă."
    assert pick_decider("Ana Popescu", "Ana Popescu", "Vlad", t2, ["Ana Popescu", "Vlad"]) == "Vlad"


# ---- duplicates -------------------------------------------------------------------------------


def test_same_party_person_and_company():
    a = "IT Rapid, prin Bogdan, a promis Cabinetului Notarial Pop că înlocuiește routerul."
    b = "Bogdan a promis Cabinetului Notarial Pop că înlocuiește routerul."
    assert same_party("IT Rapid", "Bogdan", a, b)
    assert same_party("Pavel Construct", "Ion Pavel", "Pavel Construct, prin Ion Pavel, plătește", "Ion Pavel plătește")
    assert not same_party("Ana Popa", "Ana Popescu")


def test_overlap_numbers_must_agree():
    a = content_stems("Cristina trimite oferta pentru 2.000 de meniuri tipărite până joi (2026-10-08).", ["Cristina"])
    b = content_stems("Cristina a confirmat că oferta pentru cele 2.000 de meniuri ajunge pe email până joi.", ["Cristina"])
    c = content_stems("Cristina trimite oferta pentru 500 de meniuri până joi.", ["Cristina"])
    d = content_stems("Cristina trimite contractul până joi.", ["Cristina"])
    assert overlap(a, b) >= 0.6
    assert overlap(a, c) == 0.0
    assert overlap(a, d) < 0.6


def test_duplicate_promises_merged_and_distinct_kept():
    cristina, dan, boema = node("Cristina"), node("Dan Pavel"), node("Cafeneaua Boema")
    names = {n.uuid: n.name for n in (cristina, dan, boema)}
    p1 = edge(cristina, dan, "Promise", "Cristina i-a promis lui Dan Pavel că trimite oferta pentru 2.000 de meniuri tipărite până joi (2026-10-08).",
              promised_by="Cristina", promised_to="Dan Pavel", due_date="2026-10-08", status="open")
    p2 = edge(cristina, dan, "Promise", "Cristina a confirmat că oferta pentru meniuri ajunge la Dan Pavel pe email până joi (2026-10-08).",
              promised_by="Cristina", promised_to="Dan Pavel", due_date="2026-10-08", status="open")
    other = edge(cristina, dan, "Promise", "Cristina trimite lui Dan Pavel contractul de colaborare până joi (2026-10-08).",
                 promised_by="Cristina", promised_to="Dan Pavel", due_date="2026-10-08", status="open")
    later = edge(cristina, boema, "Promise", "Cristina trimite oferta pentru meniuri până vineri (2026-10-09).",
                 promised_by="Cristina", promised_to="Cafeneaua Boema", due_date="2026-10-09", status="open")
    drop, merged = _duplicates([p1, p2, other, later], [], names)
    assert drop == {p2.uuid} and merged == set()

    # restated in a later episode: the new edge is dropped and the earlier promise gets the source
    open_prev = [{"uuid": "old-1", "fact": p1.fact, "due": "2026-10-08", "by": "Cristina", "to": "Dan Pavel",
                  "sn": "Cristina", "tn": "Dan Pavel"}]
    again = edge(cristina, dan, "Promise", "Cristina i-a spus din nou lui Dan Pavel că îi trimite oferta pentru cele 2.000 de meniuri până joi (2026-10-08).",
                 promised_by="Cristina", promised_to="Dan Pavel", due_date="2026-10-08", status="open")
    drop, merged = _duplicates([again], open_prev, names)
    assert drop == {again.uuid} and merged == {"old-1"}


def test_duplicate_promise_person_and_company():
    ion, firm, agency = node("Ion Pavel"), node("Pavel Construct"), node("Agenția Pixel")
    names = {n.uuid: n.name for n in (ion, firm, agency)}
    a = edge(ion, agency, "Promise", "Ion Pavel (Pavel Construct) a promis Agenției Pixel că plătește avansul de 3.000 lei până pe 10 septembrie (2026-09-10).",
             promised_by="Ion Pavel", promised_to="Agenția Pixel", due_date="2026-09-10", status="open")
    b = edge(firm, agency, "Promise", "Pavel Construct, prin reprezentantul Ion Pavel, a promis Agenției Pixel că plătește avansul de 3.000 lei până pe 10 septembrie (2026-09-10).",
             promised_by="Pavel Construct", promised_to="Agenția Pixel", due_date="2026-09-10", status="open")
    drop, _ = _duplicates([a, b], [], names)
    assert len(drop) == 1
    # the person's promise is kept, even when the company's text is longer
    drop, _ = _duplicates([b, a], [], names, {"Ion Pavel"})
    assert drop == {b.uuid}


def test_duplicate_decisions_merged():
    radu, pixel, simona, brazi = node("Radu"), node("WebStudio Pixel"), node("Simona Dinu"), node("Pensiunea Brazilor")
    names = {n.uuid: n.name for n in (radu, pixel, simona, brazi)}
    d1 = edge(radu, simona, "Decision", "Radu (WebStudio Pixel) a convenit cu Simona Dinu de la Pensiunea Brazilor refacerea site-ului pensiunii pentru 4.500 lei.",
              decided_by="Radu")
    d2 = edge(pixel, brazi, "Decision", "WebStudio Pixel a convenit cu Pensiunea Brazilor refacerea site-ului pensiunii pentru 4.500 lei.",
              decided_by="WebStudio Pixel")
    d3 = edge(radu, simona, "Decision", "Radu a hotărât să mute găzduirea site-ului pe alt server.", decided_by="Radu")
    drop, _ = _duplicates([d1, d2, d3], [], names)
    assert drop == {d2.uuid}


# ---- deadline promises -----------------------------------------------------------------------


def test_delivery_clause():
    f = "Radu a convenit cu Simona refacerea site-ului pentru 4.500 lei, cu predarea site-ului până pe 15 decembrie."
    assert delivery_clause(f) == "predarea site-ului până pe 15 decembrie"
    assert delivery_clause("Agenția Creativ trebuie să lanseze site-ul până pe 1 martie 2027") == "lanseze site-ul până pe 1 martie 2027"
    assert delivery_clause("Ioana a hotărât să cumpărăm de la Morărit Sud din 1 aprilie.") is None
    assert delivery_clause("Moara Verde livrează la două zile.") is None


def test_deadline_promise_from_decision():
    radu, simona = node("Radu"), node("Simona Dinu")
    names = {radu.uuid: "Radu", simona.uuid: "Simona Dinu"}
    dec = edge(radu, simona, "Decision", "Radu a convenit cu Simona Dinu refacerea site-ului pentru 4.500 lei, cu predarea site-ului până pe 15 decembrie.",
               decided_by="Radu")
    contract = edge(radu, simona, "Promise", "Radu trimite contractul mâine (2026-11-03).", promised_by="Radu",
                    promised_to="Simona Dinu", due_date="2026-11-03", status="open")
    ep = SimpleNamespace(content=dec.fact, uuid="ep", valid_at=NOW)
    out = _deadline_promises([], [dec, contract], [radu, simona], names, ep, NOW, "2026-11-02")
    assert len(out) == 1
    p = out[0]
    assert p.name == "Promise" and p.attributes["due_date"] == "2026-12-15" and p.attributes["promised_by"] == "Radu"
    assert "predarea site-ului" in p.fact and p.uuid != dec.uuid
    # already covered by a promise with that date: nothing added
    site = edge(radu, simona, "Promise", "Radu predă site-ul până pe 15 decembrie (2026-12-15).", promised_by="Radu",
                promised_to="Simona Dinu", due_date="2026-12-15", status="open")
    assert _deadline_promises([], [dec, site], [radu, simona], names, ep, NOW, "2026-11-02") == []
    # proposed by the review model
    out = _deadline_promises([{"i": 0, "by": "Radu", "to": "Simona Dinu", "what": "predea site-ul refăcut", "due": "2026-12-15"}],
                             [dec], [radu, simona], names, ep, NOW, "2026-11-02")
    assert len(out) == 1 and out[0].fact == "Radu s-a angajat față de Simona Dinu să predea site-ul refăcut până pe 2026-12-15."
