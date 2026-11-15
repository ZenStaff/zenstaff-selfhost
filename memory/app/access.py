"""Who may read which memory zone (v4).

Zones of a company: the company itself (ref "company", the company's own graph group), its
departments ("team:<hub team id>") and projects ("project:<hub project id>"), each in its own graph
group. A person's personal memory is a separate space (companies.kind = 'person') with one zone,
"personal". Access comes from the hub (PUT /admin/companies/{id}/access, built from the hub roles:
`memorie:vede` for the whole company or for a team / project) and is looked up by the hub user the
API key was issued to (api_keys.user_ref). Nothing here trusts the caller: the zone list of a call
is always computed on the server.

- A key without a user (made before v4, or by an operator) sees the company zone only.
- A key with a user the hub has not synced yet sees nothing.
- Admins (owner/admin on the hub) see every zone, archived ones too.
"""

from __future__ import annotations

from fastapi import HTTPException

COMPANY = "company"
PERSONAL = "personal"


def company_zone(company: dict) -> dict:
    return {"ref": COMPANY, "kind": "company", "name": "Toată firma", "group_id": company["group_id"], "archived": False}


def personal_zone(person: dict) -> dict:
    return {"ref": PERSONAL, "kind": "personal", "name": "Memoria mea", "group_id": person["group_id"], "archived": False}


def _zone_view(z: dict) -> dict:
    return {"ref": z["ref"], "kind": z["kind"], "name": z["name"], "group_id": z["group_id"],
            "parent_ref": z.get("parent_ref"), "archived": z.get("archived_at") is not None}


def member_of(store, space: dict) -> dict | None:
    """The member record behind the calling key (None for a key with no user)."""
    ref = space.get("key_user_ref")
    if not ref or space.get("kind") == "person":
        return None
    return store.member(space["id"], ref) or {"user_ref": ref, "admin": 0, "company_read": 0, "zones": []}


def is_admin(store, space: dict) -> bool:
    m = member_of(store, space)
    return bool(m and m["admin"])


def visible_zones(store, space: dict) -> list[dict]:
    if space.get("kind") == "person":
        return [personal_zone(space)]
    if not space.get("key_user_ref"):
        return [company_zone(space)]
    m = member_of(store, space)
    out = []
    if m["admin"] or m["company_read"]:
        out.append(company_zone(space))
    for z in store.zones_of(space["id"], include_archived=bool(m["admin"])):
        if m["admin"] or z["ref"] in m["zones"]:
            out.append(_zone_view(z))
    return out


def zone_for(store, space: dict, ref: str | None) -> dict:
    """The zone `ref` if the caller may see it, else 404 (an invisible zone looks like a missing one)."""
    if space.get("kind") == "person":
        if ref not in (None, "", PERSONAL):
            raise HTTPException(404, "zone not found")
        return personal_zone(space)
    want = ref or COMPANY
    for z in visible_zones(store, space):
        if z["ref"] == want:
            if z.get("archived") and want != COMPANY:
                z = {**z}
            return z
    raise HTTPException(404, "zone not found")


def writable_zone(store, space: dict, ref: str | None) -> dict:
    z = zone_for(store, space, ref)
    if z.get("archived"):
        raise HTTPException(409, "this zone was removed on the hub; it is kept read-only")
    return z


def personal_for(store, space: dict, raw_key: str | None) -> dict | None:
    """The starter's personal space from X-Zen-Personal-Key, only when it belongs to the same hub user
    as the company key. A legacy company key (no user) can never be combined with a personal key."""
    if not raw_key:
        return None
    person = store.company_for_key(raw_key.strip())
    if person is None or person.get("kind") != "person":
        raise HTTPException(401, "invalid personal memory key")
    if space.get("kind") == "person":
        raise HTTPException(400, "send the personal key either as the bearer key or in X-Zen-Personal-Key, not both")
    if not space.get("key_user_ref") or space["key_user_ref"] != person.get("owner_ref"):
        raise HTTPException(403, "the personal key belongs to another person than this company key")
    return person
