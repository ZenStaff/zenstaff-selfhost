// Personal memory and memory zones (hub v17) over HTTP. By default against a small fake of
// zen-memory's admin API; with ZM_E2E_URL + ZM_E2E_ADMIN_TOKEN against a real (throwaway) zen-memory,
// where it also checks the isolation through zen-memory's own /v1 API with the keys the hub issued:
// the owner cannot read a member's personal memory, members cannot read each other's, a company key
// never returns personal items, and a scoped person reads only their project.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

const REAL = process.env.ZM_E2E_URL ?? "";
const REAL_ADMIN = process.env.ZM_E2E_ADMIN_TOKEN ?? "";

// ---- fake zen-memory (admin side only) -----------------------------------------------------------
const fake = {
  companies: [] as Array<{ id: string; name: string }>,
  persons: [] as Array<{ id: string; userRef: string; links: Set<string>; deleted: boolean }>,
  keys: [] as Array<{ id: string; space: string; raw: string; userRef: string | null; revoked: boolean }>,
  access: new Map<string, { zones: Array<{ ref: string; name: string }>; members: Array<{ user_ref: string; admin: boolean; company: boolean; zones: string[] }>; auto_promote_decisions?: boolean; sensitive_policy?: string }>(),
  forgets: [] as Array<string>,
};
let n = 0;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const p = url.pathname;
  const issue = (space: string, userRef: string | null) => {
    const key = { id: `k_${++n}`, space, raw: `zm_raw_${n}`, userRef, revoked: false };
    fake.keys.push(key);
    return key;
  };
  if (method === "GET" && p === "/admin/companies") return json(200, { companies: fake.companies.map((c) => ({ company_id: c.id, name: c.name })) });
  if (method === "POST" && p === "/admin/companies") {
    const id = `co_mem${++n}`;
    fake.companies.push({ id, name: body.name });
    return json(201, { company_id: id, api_key: issue(id, null).raw });
  }
  let m = /^\/admin\/companies\/([^/]+)\/keys$/.exec(p);
  if (m && method === "GET") return json(200, { keys: fake.keys.filter((k) => k.space === m![1]).map((k) => ({ key_id: k.id, revoked_at: k.revoked ? "x" : null })) });
  if (m && method === "POST") {
    const k = issue(m[1]!, url.searchParams.get("user_ref"));
    return json(201, { key_id: k.id, api_key: k.raw });
  }
  m = /^\/admin\/(companies|persons)\/([^/]+)\/keys\/([^/]+)$/.exec(p);
  if (m && method === "DELETE") {
    const k = fake.keys.find((row) => row.space === m![2] && row.id === m![3] && !row.revoked);
    if (k) k.revoked = true;
    return json(200, { revoked: k ? 1 : 0 });
  }
  m = /^\/admin\/companies\/([^/]+)\/access$/.exec(p);
  if (m && method === "PUT") {
    fake.access.set(m[1]!, body);
    return json(200, { zones_created: body.zones.length, members: body.members.length });
  }
  if (method === "POST" && p === "/admin/persons") {
    const existing = fake.persons.find((row) => row.userRef === body.user_ref && !row.deleted);
    if (existing) return json(200, { person_id: existing.id, created: false });
    const person = { id: `pe_${++n}`, userRef: body.user_ref, links: new Set<string>(), deleted: false };
    fake.persons.push(person);
    return json(201, { person_id: person.id, created: true });
  }
  m = /^\/admin\/persons\/([^/]+)\/keys$/.exec(p);
  if (m && method === "POST") {
    const person = fake.persons.find((row) => row.id === m![1] && !row.deleted)!;
    const k = issue(person.id, person.userRef);
    return json(201, { key_id: k.id, api_key: k.raw });
  }
  m = /^\/admin\/persons\/([^/]+)\/companies\/([^/]+)$/.exec(p);
  if (m && method === "PUT") {
    fake.persons.find((row) => row.id === m![1])!.links.add(m[2]!);
    return json(200, {});
  }
  if (m && method === "DELETE") {
    fake.persons.find((row) => row.id === m![1])!.links.delete(m[2]!);
    if (url.searchParams.get("forget") === "true") fake.forgets.push(`${m[1]}:${m[2]}`);
    return json(200, { detached: true, ...(url.searchParams.get("forget") === "true" ? { forgotten: { facts_deleted: 2 } } : {}) });
  }
  m = /^\/admin\/persons\/([^/]+)$/.exec(p);
  if (m && method === "DELETE") {
    const person = fake.persons.find((row) => row.id === m![1])!;
    person.deleted = true;
    for (const k of fake.keys) if (k.space === person.id) k.revoked = true;
    return json(200, { status: "deleted", data_keys_destroyed: 1 });
  }
  return json(404, { detail: "not found" });
};

let hub: Hub;
let client: ReturnType<typeof makeClient>;
before(async () => {
  hub = await startHub({
    config: {
      memory: REAL
        ? { publicUrl: REAL, adminUrl: REAL, adminToken: REAL_ADMIN }
        : { publicUrl: "https://memory.test", adminUrl: "http://zen-memory-api:8000", adminToken: "admin-secret", fetchImpl: fakeFetch },
    },
  });
  client = makeClient(hub);
});
after(async () => {
  await hub.close();
});
const call = (...args: Parameters<typeof client.call>) => client.call(...args);
const mem = async (key: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await fetch(`${REAL}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

let owner: Person;
let ana: Person;
let bogdan: Person;
let scoped: Person;
let firma = "";
let team = "";
const keys: Record<string, { company: string; personal: string }> = {};

const join_ = async (companyId: string, person: Person, role: "member" | "guest" | "admin") => {
  const invite = await call(owner.token, "POST", `/v1/companies/${companyId}/invites`, { role });
  assert.equal((await call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
};

describe("personal memory and memory zones", () => {
  it("sets up a company with a department, a project and a person who sees only that project", async () => {
    owner = await client.signIn("owner@firma.test");
    ana = await client.signIn("ana@firma.test");
    bogdan = await client.signIn("bogdan@firma.test");
    scoped = await client.signIn("contabil@extern.test");
    firma = (await call(owner.token, "POST", "/v1/companies", { name: `Firma E2E ${Date.now()}` })).json.id;
    await client.enableTotp(owner);
    await join_(firma, ana, "member");
    await join_(firma, bogdan, "member");
    await join_(firma, scoped, "guest");
    team = (await call(owner.token, "POST", `/v1/companies/${firma}/teams`, { name: "Vânzări" })).json.id;
    assert.equal((await call(owner.token, "PUT", `/v1/companies/${firma}/projects/proj-site`, { name: "Site nou", teamId: team })).status, 200);
    assert.equal((await call(owner.token, "PUT", `/v1/companies/${firma}/projects/proj-salarii`, { name: "Salarii" })).status, 200);
    const role = await call(owner.token, "POST", `/v1/companies/${firma}/roles`, { name: "Cititor memorie", permissions: ["memorie:vede", "chats:vede"] });
    assert.equal(role.status, 200, JSON.stringify(role.json));
    const grant = await call(owner.token, "PUT", `/v1/companies/${firma}/members/${scoped.userId}/access`, {
      customRoleId: null,
      scoped: [{ roleId: role.json.id, kind: "project", id: "proj-salarii" }],
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.json));
    assert.equal((await call(owner.token, "POST", `/v1/companies/${firma}/memory/hosted/activate`, {})).status, 200);
    // payroll is restricted: members' company-wide "memorie: vede" does not open it
    assert.equal((await call(ana.token, "PUT", `/v1/companies/${firma}/memory/hosted/zones/project:proj-salarii`, { restricted: true })).status, 403);
    const r = await call(owner.token, "PUT", `/v1/companies/${firma}/memory/hosted/zones/project:proj-salarii`, { restricted: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it("issues company keys bound to each person, after sending the zones and who reads them", async () => {
    for (const [name, person] of Object.entries({ owner, ana, bogdan, scoped })) {
      const r = await call(person.token, "POST", `/v1/companies/${firma}/memory/hosted/keys`, { machine: `pc-${name}` });
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
      keys[name] = { company: r.json.apiKey, personal: "" };
    }
    if (!REAL) {
      const k = fake.keys.find((row) => row.raw === keys.ana!.company)!;
      assert.equal(k.userRef, ana.userId);
      const access = [...fake.access.values()].at(-1)!;
      const by = (u: Person) => access.members.find((row) => row.user_ref === u.userId)!;
      assert.deepEqual(access.zones.map((z) => z.ref).sort(), ["project:proj-salarii", "project:proj-site", `team:${team}`].sort());
      assert.equal(by(owner).admin, true);
      assert.equal(by(ana).company, true);
      assert.deepEqual(by(scoped).zones, ["project:proj-salarii"]);
      assert.equal(by(scoped).company, false);
    }
    // the guest reads only its project: the zones page is for owners/admins
    assert.equal((await call(scoped.token, "GET", `/v1/companies/${firma}/memory/hosted/zones`)).status, 403);
    const zones = await call(owner.token, "GET", `/v1/companies/${firma}/memory/hosted/zones`);
    assert.equal(zones.status, 200);
    const salarii = zones.json.zones.find((z: { ref: string }) => z.ref === "project:proj-salarii");
    assert.deepEqual(salarii.readers.map((r: { userId: string }) => r.userId).sort(), [owner.userId, scoped.userId].sort());
  });

  it("each person turns on their own memory and gets one key per device; the same memory on every device", async () => {
    for (const [name, person] of Object.entries({ owner, ana, bogdan })) {
      assert.equal((await call(person.token, "POST", "/v1/me/memory/keys", { machine: "pc" })).status, 409); // not on yet
      const on = await call(person.token, "POST", "/v1/me/memory/activate", {});
      assert.equal(on.status, 200, JSON.stringify(on.json));
      assert.equal(on.json.active, true);
      const k = await call(person.token, "POST", "/v1/me/memory/keys", { machine: `pc-${name}` });
      assert.equal(k.status, 200, JSON.stringify(k.json));
      keys[name]!.personal = k.json.apiKey;
    }
    const again = await call(ana.token, "POST", "/v1/me/memory/activate", {});
    assert.equal(again.status, 200);
    const phone = await call(ana.token, "POST", "/v1/me/memory/keys", { machine: "telefon-ana" });
    assert.equal(phone.status, 200);
    const status = await call(ana.token, "GET", "/v1/me/memory");
    assert.deepEqual(status.json.machines.map((m: { machine: string }) => m.machine).sort(), ["pc-ana", "telefon-ana"]);
    assert.equal(status.json.companies[0].companyId, firma);
    // only ids are kept on the hub
    assert.ok(!JSON.stringify(hub.db.prepare("SELECT * FROM user_memory_keys").all()).includes("zm_"));
    // the owner sees no route to anyone else's memory: /v1/me is always the caller
    const ownerView = await call(owner.token, "GET", "/v1/me/memory");
    assert.ok(!JSON.stringify(ownerView.json).includes("telefon-ana"));
    const anaKeyId = status.json.machines[0].keyId;
    assert.equal((await call(owner.token, "DELETE", `/v1/me/memory/keys/${anaKeyId}`)).status, 404);
    if (REAL) {
      const a = await mem(phone.json.apiKey, "GET", "/v1/me");
      const b = await mem(keys.ana!.personal, "GET", "/v1/me");
      assert.equal(a.json.company_id, b.json.company_id, "same personal memory on both devices");
      assert.equal(a.json.kind, "person");
    }
  });

  it("isolation through zen-memory itself (real stack only)", { skip: !REAL }, async () => {
    // Ana writes a personal chat and a company chat; the summaries are short and clear
    const personal = await mem(keys.ana!.personal, "POST", "/v1/episodes", {
      summary: "Ana vrea ca rapoartele pentru Furnizor Alfa SRL să fie scurte, pe trei puncte, și a hotărât să le citească lunea.",
      source: { thread_id: "e2e-ana-personal", timestamp: new Date().toISOString(), user: "ana" },
    });
    assert.ok([200, 202].includes(personal.status), JSON.stringify(personal.json));
    const company = await mem(keys.ana!.company, "POST", "/v1/episodes", {
      summary: "Ana a hotărât că prețul la Furnizor Alfa SRL rămâne 3,25 lei/kg din decembrie. Ana preferă să primească ofertele pe e-mail, nu pe telefon. Salariul lui Bogdan crește la 7.000 lei.",
      source: { thread_id: "e2e-ana-company", timestamp: new Date().toISOString(), user: "ana" },
    }, { "x-zen-personal-key": keys.ana!.personal });
    assert.equal(company.status, 202, JSON.stringify(company.json));
    assert.ok(company.json.sorting.to_personal >= 1, JSON.stringify(company.json.sorting));
    const salarii = await mem(keys.scoped!.company, "POST", "/v1/episodes", {
      zone: "project:proj-salarii",
      summary: "Contabilul a hotărât ca statul de plată pentru Furnizor Alfa SRL să fie gata pe 25 ale lunii.",
      source: { thread_id: "e2e-salarii", timestamp: new Date().toISOString(), user: "contabil" },
    });
    assert.equal(salarii.status, 202, JSON.stringify(salarii.json));
    // wait for the ingests (Haiku, ~20-40 s each)
    for (let i = 0; i < 90; i++) {
      const facts = await mem(keys.owner!.company, "GET", "/v1/facts?zone=project:proj-salarii");
      const mine = await mem(keys.ana!.personal, "GET", "/v1/facts");
      const comp = await mem(keys.owner!.company, "GET", "/v1/facts");
      if (facts.json.facts?.length && mine.json.facts?.length && comp.json.facts?.length) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const anaFacts = (await mem(keys.ana!.personal, "GET", "/v1/facts")).json.facts as Array<{ id: string; fact: string }>;
    assert.ok(anaFacts.length > 0, "Ana's personal memory has items");
    const anaIds = new Set(anaFacts.map((f) => f.id));
    const leak = (body: any) => (body.facts ?? []).filter((f: { id: string }) => anaIds.has(f.id));
    for (const who of ["owner", "bogdan", "scoped"] as const) {
      for (const q of ["Furnizor Alfa SRL", "rapoartele scurte", "ofertele pe e-mail", "Ana"]) {
        assert.deepEqual(leak((await mem(keys[who]!.company, "GET", `/v1/search?q=${encodeURIComponent(q)}&limit=50`)).json), [], `${who} company key, ${q}`);
        if (keys[who]!.personal) {
          const both = await mem(keys[who]!.company, "GET", `/v1/search?q=${encodeURIComponent(q)}&limit=50`, undefined, { "x-zen-personal-key": keys[who]!.personal });
          assert.deepEqual(leak(both.json), [], `${who} with own personal key, ${q}`);
        }
      }
      for (const f of anaFacts) assert.equal((await mem(keys[who]!.company, "GET", `/v1/facts/${f.id}`)).status, 404);
      if (keys[who]!.personal) {
        for (const f of anaFacts) assert.equal((await mem(keys[who]!.personal, "GET", `/v1/facts/${f.id}`)).status, 404);
        // someone else's personal key next to my company key is refused
        assert.equal((await mem(keys[who]!.company, "GET", "/v1/search?q=x", undefined, { "x-zen-personal-key": keys.ana!.personal })).status, 403);
      }
    }
    // the salary sentence never reached the company zone
    const companyFacts = (await mem(keys.owner!.company, "GET", "/v1/facts")).json.facts as Array<{ fact: string }>;
    assert.ok(!companyFacts.some((f) => /7\.000|salariul/i.test(f.fact)), JSON.stringify(companyFacts));
    // zones: Ana and Bogdan do not see the payroll project; the scoped person sees only it
    const salariiFacts = (await mem(keys.owner!.company, "GET", "/v1/facts?zone=project:proj-salarii")).json.facts as Array<{ id: string }>;
    assert.ok(salariiFacts.length > 0);
    for (const who of ["ana", "bogdan"] as const) {
      const r = await mem(keys[who]!.company, "GET", `/v1/search?q=${encodeURIComponent("statul de plată Furnizor Alfa SRL")}&limit=50`);
      assert.ok(!r.json.facts.some((f: { id: string }) => salariiFacts.some((s) => s.id === f.id)), `${who} sees payroll`);
      assert.equal((await mem(keys[who]!.company, "GET", "/v1/facts?zone=project:proj-salarii")).status, 404);
    }
    const sc = await mem(keys.scoped!.company, "GET", `/v1/search?q=${encodeURIComponent("Furnizor Alfa SRL")}&limit=50`);
    assert.ok(sc.json.facts.every((f: { zone: { ref: string } }) => f.zone.ref === "project:proj-salarii"), JSON.stringify(sc.json.facts.map((f: any) => f.zone)));
    // Ana sends one item to the company memory, with consent
    const promoted = await mem(keys.ana!.personal, "POST", `/v1/facts/${anaFacts[0]!.id}/promote`, { consent: true }, { "x-zen-company-key": keys.ana!.company });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    const consents = (await mem(keys.owner!.company, "GET", "/v1/consents")).json.consents;
    assert.equal(consents[0].mode, "manual");
  });

  it("rules: owners and admins only; they reach the memory", async () => {
    assert.equal((await call(ana.token, "PUT", `/v1/companies/${firma}/memory/hosted/rules`, { autoPromoteDecisions: true })).status, 403);
    const r = await call(owner.token, "PUT", `/v1/companies/${firma}/memory/hosted/rules`, { autoPromoteDecisions: true, sensitivePolicy: "drop" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.rules, { autoPromoteDecisions: true, sensitivePolicy: "drop" });
    if (!REAL) assert.equal([...fake.access.values()].at(-1)!.sensitive_policy, "drop");
    assert.equal((await call(owner.token, "PUT", `/v1/companies/${firma}/memory/hosted/rules`, { sensitivePolicy: "keep" })).status, 400);
  });

  it("a person who leaves keeps their own memory, or deletes what came from the company, at their choice", async () => {
    // Bogdan is removed by the owner: his memory is detached, nothing is deleted (not his choice)
    assert.equal((await call(owner.token, "DELETE", `/v1/companies/${firma}/members/${bogdan.userId}`, { forgetMemory: true })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!REAL) {
      const person = fake.persons.find((row) => row.userRef === bogdan.userId)!;
      assert.ok(!person.links.size && !fake.forgets.some((f) => f.startsWith(person.id)));
      assert.ok(fake.keys.find((k) => k.raw === keys.bogdan!.company)!.revoked);
      assert.ok(!fake.keys.find((k) => k.raw === keys.bogdan!.personal)!.revoked, "his personal key still works");
    } else {
      assert.equal((await mem(keys.bogdan!.personal, "GET", "/v1/me")).status, 200);
    }
    // Ana leaves and chooses to delete what her memory got from this company
    assert.equal((await call(ana.token, "DELETE", `/v1/companies/${firma}/members/${ana.userId}`, { forgetMemory: true })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!REAL) {
      const person = fake.persons.find((row) => row.userRef === ana.userId)!;
      assert.ok(fake.forgets.includes(`${person.id}:${fake.companies.at(-1)!.id}`));
    } else {
      for (let i = 0; i < 20; i++) {
        const left = await mem(keys.ana!.personal, "GET", "/v1/facts");
        if (left.json.facts.every((f: any) => !f.sources?.some((s: any) => s.thread_id === "e2e-ana-company"))) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const left = await mem(keys.ana!.personal, "GET", "/v1/facts");
      assert.ok(left.json.facts.every((f: any) => !f.sources?.some((s: any) => s.thread_id === "e2e-ana-company")), "company items gone");
      assert.ok(left.json.facts.some((f: any) => f.sources?.some((s: any) => s.thread_id === "e2e-ana-personal")), "personal chat items stay");
    }
  });

  it("deleting one's own memory destroys it (and asks for a confirmation word)", async () => {
    assert.equal((await call(ana.token, "DELETE", "/v1/me/memory", {})).status, 400);
    const r = await call(ana.token, "DELETE", "/v1/me/memory", { confirm: "sterge" });
    assert.equal(r.status, 200);
    assert.equal(r.json.deleted, true);
    assert.equal((await call(ana.token, "GET", "/v1/me/memory")).json.active, false);
    if (REAL) assert.equal((await mem(keys.ana!.personal, "GET", "/v1/me")).status, 401);
    else assert.ok(fake.keys.filter((k) => k.userRef === ana.userId && k.space.startsWith("pe_")).every((k) => k.revoked));
  });
});
