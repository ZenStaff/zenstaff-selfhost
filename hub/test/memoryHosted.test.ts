// Hosted company memory (v13) over HTTP, against a fake zen-memory admin API: owner/admin activation
// (once, also when asked twice at the same time), one key per member machine (asking again replaces
// it), nothing for guests or other companies, revocation of a machine and of a member who leaves,
// own memory servers left alone, and a hub without the variables answering "not available".
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

interface FakeKey {
  id: string;
  company: string;
  raw: string;
  revoked: boolean;
}
const fake = { companies: [] as Array<{ id: string; name: string }>, keys: [] as Array<FakeKey>, calls: [] as Array<string>, down: false };
let n = 0;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  fake.calls.push(`${method} ${url.pathname}`);
  assert.equal(((init?.headers ?? {}) as Record<string, string>).authorization, "Bearer admin-secret");
  if (fake.down) throw new TypeError("fetch failed");
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const issue = (company: string) => {
    const key = { id: `k_${++n}`, company, raw: `zm_raw_${n}`, revoked: false };
    fake.keys.push(key);
    return key;
  };
  if (method === "GET" && url.pathname === "/admin/companies") {
    return json(200, { companies: fake.companies.map((row) => ({ company_id: row.id, name: row.name })) });
  }
  if (method === "POST" && url.pathname === "/admin/companies") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = `co_mem${++n}`;
    fake.companies.push({ id, name: JSON.parse(String(init?.body)).name });
    const key = issue(id);
    return json(201, { company_id: id, api_key: key.raw });
  }
  let match = /^\/admin\/companies\/([^/]+)\/keys$/.exec(url.pathname);
  if (match !== null && method === "GET") {
    return json(200, { keys: fake.keys.filter((key) => key.company === match![1]).map((key) => ({ key_id: key.id, revoked_at: key.revoked ? "x" : null })) });
  }
  if (match !== null && method === "POST") {
    const key = issue(match[1]!);
    return json(201, { key_id: key.id, api_key: key.raw });
  }
  if (method === "PUT" && /^\/admin\/companies\/[^/]+\/access$/.test(url.pathname)) return json(200, { zones_created: 0, members: 0 });
  match = /^\/admin\/companies\/([^/]+)\/keys\/([^/]+)$/.exec(url.pathname);
  if (match !== null && method === "DELETE") {
    const key = fake.keys.find((row) => row.company === match![1] && row.id === match![2] && !row.revoked);
    if (key !== undefined) key.revoked = true;
    return json(200, { revoked: key === undefined ? 0 : 1 });
  }
  return json(404, { detail: "not found" });
};
const live = (raw: string) => fake.keys.some((key) => key.raw === raw && !key.revoked);

let hub: Hub;
let plain: Hub;
let client: ReturnType<typeof makeClient>;
before(async () => {
  hub = await startHub({ config: { memory: { publicUrl: "https://memory.test", adminUrl: "http://zen-memory-api:8000", adminToken: "admin-secret", fetchImpl: fakeFetch } } });
  plain = await startHub();
  client = makeClient(hub);
});
after(async () => {
  await hub.close();
  await plain.close();
});
const call = (...args: Parameters<typeof client.call>) => client.call(...args);

let alex: Person;
let maria: Person;
let gina: Person;
let olga: Person;
let horeca = "";
let zedzen = "";
let other = "";

const join_ = async (owner: Person, companyId: string, person: Person, role: "member" | "guest" | "admin") => {
  const invite = await call(owner.token, "POST", `/v1/companies/${companyId}/invites`, { role });
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  assert.equal((await call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
};

describe("hosted company memory", () => {
  it("sets up companies", async () => {
    alex = await client.signIn("alex@zedzen.test");
    maria = await client.signIn("maria@horeca.test");
    gina = await client.signIn("gina@outside.test");
    olga = await client.signIn("olga@other.test");
    horeca = (await call(alex.token, "POST", "/v1/companies", { name: "HoReCaOS" })).json.id;
    await client.enableTotp(alex);
    zedzen = (await call(alex.token, "POST", "/v1/companies", { name: "ZEDZEN" })).json.id;
    other = (await call(olga.token, "POST", "/v1/companies", { name: "Other" })).json.id;
    await client.enableTotp(olga);
    await join_(alex, horeca, maria, "member");
    await join_(alex, horeca, gina, "guest");
  });

  it("shows available but not active, and refuses keys before activation", async () => {
    const status = await call(maria.token, "GET", `/v1/companies/${horeca}/memory/hosted`);
    assert.equal(status.status, 200);
    assert.deepEqual(
      { ...status.json, machines: undefined },
      { available: true, activated: false, active: false, url: "https://memory.test", activatedAt: null, machines: undefined, rules: null, accessSyncedAt: null },
    );
    const settings = await call(maria.token, "GET", `/v1/companies/${horeca}/settings`);
    assert.deepEqual(settings.json.hosted, { available: true, activated: false, active: false, url: "https://memory.test" });
    const detail = await call(maria.token, "GET", `/v1/companies/${horeca}`);
    assert.deepEqual(detail.json.settings.hosted, { available: true, activated: false, active: false, url: "https://memory.test" });
    const key = await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "laptop-maria" });
    assert.equal(key.status, 409);
    assert.equal(key.json.code ?? key.json.error, "memory_not_activated");
  });

  it("only owners and admins activate; activation happens once even when asked twice at once", async () => {
    assert.equal((await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, {})).status, 403);
    assert.equal((await call(gina.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, {})).status, 403);
    assert.equal((await call(olga.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, {})).status, 404);
    const [a, b] = await Promise.all([
      call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, {}),
      call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, {}),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(fake.companies.length, 1);
    assert.match(fake.companies[0]!.name, new RegExp(`^HoReCaOS \\(hub ${horeca}\\)$`));
    assert.equal(a.json.active, true);
    // The creation key is revoked at once: no key exists that the hub did not hand to a machine.
    assert.ok(fake.keys.filter((key) => key.company === fake.companies[0]!.id).every((key) => key.revoked));
    const settings = await call(maria.token, "GET", `/v1/companies/${horeca}/settings`);
    assert.deepEqual(settings.json.memory, { url: "https://memory.test", saveConversations: true });
    assert.equal(settings.json.hosted.active, true);
  });

  it("gives each member machine its own key; asking again from the same machine replaces it", async () => {
    const first = await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "laptop-maria" });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.url, "https://memory.test");
    assert.ok(live(first.json.apiKey));
    const again = await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "laptop-maria" });
    assert.ok(live(again.json.apiKey));
    assert.ok(!live(first.json.apiKey), "the old key of that machine is revoked");
    const phone = await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "pc-acasa" });
    assert.ok(live(phone.json.apiKey) && live(again.json.apiKey));
    const alexKey = await call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "server-1" });
    assert.ok(live(alexKey.json.apiKey));
    // The hub keeps ids, never keys.
    const dump = JSON.stringify(hub.db.prepare("SELECT * FROM company_memory_keys").all());
    assert.ok(!dump.includes("zm_raw_"));
    const status = await call(maria.token, "GET", `/v1/companies/${horeca}/memory/hosted`);
    assert.deepEqual(status.json.machines.map((m: { machine: string }) => m.machine).sort(), ["laptop-maria", "pc-acasa"]);
  });

  it("guests, outsiders and companies without hosted memory get nothing", async () => {
    assert.equal((await call(gina.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "x" })).status, 403);
    assert.equal((await call(olga.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "x" })).status, 404);
    assert.equal((await call(alex.token, "POST", `/v1/companies/${zedzen}/memory/hosted/keys`, { machine: "x" })).status, 409);
    assert.equal((await call(olga.token, "GET", `/v1/companies/${horeca}/memory/hosted`)).status, 404);
    assert.equal((await call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "" })).status, 400);
  });

  it("a person removes their own machine; admins remove anyone's; members not others'", async () => {
    const mine = (await call(maria.token, "GET", `/v1/companies/${horeca}/memory/hosted`)).json.machines as Array<{ keyId: string; machine: string }>;
    const alexKeys = (await call(alex.token, "GET", `/v1/companies/${horeca}/memory/hosted`)).json.machines as Array<{ keyId: string }>;
    assert.equal((await call(maria.token, "DELETE", `/v1/companies/${horeca}/memory/hosted/keys/${alexKeys[0]!.keyId}`)).status, 403);
    const home = mine.find((m) => m.machine === "pc-acasa")!;
    assert.equal((await call(maria.token, "DELETE", `/v1/companies/${horeca}/memory/hosted/keys/${home.keyId}`)).status, 200);
    assert.ok(fake.keys.find((key) => key.id === home.keyId)!.revoked);
    assert.equal((await call(maria.token, "DELETE", `/v1/companies/${horeca}/memory/hosted/keys/${home.keyId}`)).status, 404);
  });

  it("a member who leaves loses every memory key of that company", async () => {
    const before_ = await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "laptop-maria" });
    assert.ok(live(before_.json.apiKey));
    assert.equal((await call(alex.token, "DELETE", `/v1/companies/${horeca}/members/${maria.userId}`)).status, 200);
    for (let i = 0; i < 50 && live(before_.json.apiKey); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!live(before_.json.apiKey));
    assert.equal((await call(maria.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "laptop-maria" })).status, 404);
  });

  it("a company pointed at its own memory server gets no hosted keys; activating again switches back", async () => {
    const own = await call(alex.token, "PUT", `/v1/companies/${horeca}/settings`, { memory: { url: "https://mem.firma.ro", saveConversations: true } });
    assert.equal(own.status, 200);
    assert.equal(own.json.hosted.active, false);
    const refused = await call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "server-1" });
    assert.equal(refused.status, 409);
    const back = await call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/activate`, { saveConversations: false });
    assert.equal(back.json.active, true);
    assert.equal(fake.companies.length, 1, "the same memory company");
    assert.deepEqual((await call(alex.token, "GET", `/v1/companies/${horeca}/settings`)).json.memory, { url: "https://memory.test", saveConversations: false });
  });

  it("a memory outage is a 502 with nothing recorded", async () => {
    fake.down = true;
    const before_ = hub.db.prepare("SELECT COUNT(*) AS n FROM company_memory_keys").get() as { n: number };
    const failed = await call(alex.token, "POST", `/v1/companies/${horeca}/memory/hosted/keys`, { machine: "server-1" });
    assert.equal(failed.status, 502);
    const zed = await call(alex.token, "POST", `/v1/companies/${zedzen}/memory/hosted/activate`, {});
    assert.equal(zed.status, 502);
    fake.down = false;
    assert.equal((hub.db.prepare("SELECT COUNT(*) AS n FROM company_memory_keys").get() as { n: number }).n, before_.n);
    assert.equal((await call(alex.token, "GET", `/v1/companies/${zedzen}/memory/hosted`)).json.activated, false);
    void other;
  });

  it("adopts a memory company made for this hub company before, and revokes the keys made outside the hub", async () => {
    const pre = { id: "co_pre1", name: `ZEDZEN (hub ${zedzen})` };
    fake.companies.push(pre);
    fake.keys.push({ id: "k_ops", company: pre.id, raw: "zm_ops", revoked: false });
    const count = fake.companies.length;
    const activated = await call(alex.token, "POST", `/v1/companies/${zedzen}/memory/hosted/activate`, {});
    assert.equal(activated.status, 200, JSON.stringify(activated.json));
    assert.equal(fake.companies.length, count, "no second memory company");
    assert.ok(!live("zm_ops"));
    const key = await call(alex.token, "POST", `/v1/companies/${zedzen}/memory/hosted/keys`, { machine: "server-1" });
    assert.ok(fake.keys.find((row) => row.raw === key.json.apiKey)?.company === pre.id);
  });

  it("a hub without the memory variables says not available", async () => {
    const c = makeClient(plain);
    const owner = await c.signIn("self@host.test");
    const id = (await c.call(owner.token, "POST", "/v1/companies", { name: "Self" })).json.id;
    await c.enableTotp(owner);
    const status = await c.call(owner.token, "GET", `/v1/companies/${id}/memory/hosted`);
    assert.equal(status.json.available, false);
    assert.equal((await c.call(owner.token, "POST", `/v1/companies/${id}/memory/hosted/activate`, {})).status, 409);
    assert.equal((await c.call(owner.token, "GET", `/v1/companies/${id}/settings`)).json.hosted.available, false);
  });
});
