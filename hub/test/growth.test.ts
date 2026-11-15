// Growth (v18): funnel events from the existing flows (no personal data), the token-only API for
// the growth team (summary, leads, partner codes, opt-outs, events), the partner links /r/<code>
// and the audit trail of every write.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { openDb } from "../src/db.ts";
import * as growth from "../src/growth.ts";
import { maskEmail } from "../src/routes/growth.ts";
import * as store from "../src/store.ts";
import * as approvals from "../src/storeApprovals.ts";
import { type Hub, makeClient, startHub } from "./harness.ts";

const TOKEN = "g".repeat(16) + "0123456789abcdef0123456789abcdef";

const eventsOf = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT event, company_id AS companyId, user_id AS userId, meta FROM growth_events ORDER BY rowid").all() as Array<{
    event: string;
    companyId: string | null;
    userId: string | null;
    meta: string | null;
  }>;

describe("growth config", () => {
  it("is on only with a token of 32+ characters; the landing defaults to zenstaff.app", () => {
    const lines: string[] = [];
    assert.equal(growth.growthConfigFromEnv({}), undefined);
    assert.equal(growth.growthConfigFromEnv({ HUB_GROWTH_TOKEN: "tiny-secret" }, (line) => lines.push(line)), undefined);
    assert.match(lines[0] ?? "", /shorter than 32/);
    assert.ok(!lines.join("").includes("tiny-secret"));
    assert.deepEqual(growth.growthConfigFromEnv({ HUB_GROWTH_TOKEN: TOKEN }), { token: TOKEN, landingUrl: "https://zenstaff.app/" });
  });
});

describe("funnel events from the existing flows", () => {
  it("count sign-up, company, invitation sent/accepted and approval link created/decided, with ids only", () => {
    const db = openDb(":memory:");
    const owner = store.upsertUser(db, "owner@firma.test");
    store.upsertUser(db, "owner@firma.test"); // signing in again is not a new sign-up
    const company = store.createCompany(db, owner.id, "Firma Test");
    const invite = store.createInvite(db, { companyId: company.id, email: "coleg@firma.test", role: "member", createdBy: owner.id });
    const colleague = store.upsertUser(db, "coleg@firma.test");
    assert.equal(store.acceptInviteToken(db, invite.token, colleague).ok, true);
    const { approval } = approvals.createApproval(db, {
      companyId: company.id,
      createdBy: owner.id,
      title: "Afiș",
      note: "",
      clientName: "Client",
      clientColor: null,
      language: "ro",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      files: [{ role: "file", kind: "pdf", name: "a.pdf", mime: "application/pdf", size: 10, sha256: "0".repeat(64), width: null, height: null }],
    });
    assert.equal(approvals.decide(db, approval.id, { decision: "approved", comment: null, name: "Ana" }), true);
    assert.equal(approvals.decide(db, approval.id, { decision: "changes", comment: null, name: null }), false);

    const events = eventsOf(db);
    assert.deepEqual(
      events.map((row) => row.event),
      ["signup", "company_created", "invite_sent", "signup", "invite_accepted", "approval_link_created", "approval_link_decided"],
    );
    assert.deepEqual(events.find((row) => row.event === "invite_sent")!.meta, JSON.stringify({ role: "member", byEmail: true }));
    assert.equal(events.find((row) => row.event === "approval_link_decided")!.companyId, company.id);
    // No e-mail, name or title ends up in the funnel.
    const raw = JSON.stringify(db.prepare("SELECT * FROM growth_events").all());
    for (const secret of ["@firma.test", "Firma Test", "Afiș", "Ana", "Client"]) assert.ok(!raw.includes(secret), secret);
    db.close();
  });

  it("never break the flow they count", () => {
    const db = openDb(":memory:");
    growth.recordEvent(db, "signup", { userId: "usr_missing" }); // foreign key fails, silently
    growth.recordEvent(db, "signup", { meta: { big: "x".repeat(2000) } });
    assert.equal(eventsOf(db).length, 0);
    db.close();
  });
});

describe("opt-out matching", () => {
  it("matches the address, its domain and parent domains", () => {
    const db = openDb(":memory:");
    assert.deepEqual(growth.exclusionOf(" Ana@Firma.EXAMPLE "), { value: "ana@firma.example", kind: "email" });
    assert.deepEqual(growth.exclusionOf("@firma.example"), { value: "firma.example", kind: "domain" });
    assert.equal(growth.exclusionOf("not an address"), null);
    assert.equal(growth.exclusionOf("a@b"), null);
    growth.addOptout(db, { value: "firma.example", kind: "domain", reason: null, source: null });
    growth.addOptout(db, { value: "ion@other.example", kind: "email", reason: null, source: null });
    assert.equal(growth.excludedBy(db, "x@firma.example")?.value, "firma.example");
    assert.equal(growth.excludedBy(db, "x@mail.firma.example")?.value, "firma.example");
    assert.equal(growth.excludedBy(db, "x@notfirma.example"), null);
    assert.equal(growth.excludedBy(db, "ion@other.example")?.kind, "email");
    assert.equal(growth.excludedBy(db, "maria@other.example"), null);
    db.close();
  });

  it("masks e-mails for the audit log", () => {
    assert.equal(maskEmail("ana@firma.example"), "a***@firma.example");
    assert.equal(maskEmail(null), null);
  });
});

describe("growth API", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  const as = (token: string | null, method: string, path: string, body?: unknown) => client.call(token, method, path, body);
  const api = (method: string, path: string, body?: unknown) => as(TOKEN, method, path, body);

  before(async () => {
    hub = await startHub({ config: { growth: { token: TOKEN, landingUrl: "https://zenstaff.app/" } } });
    client = makeClient(hub);
  });
  after(() => hub.close());

  it("is 404 when the hub has no growth token", async () => {
    const off = await startHub();
    try {
      const offClient = makeClient(off);
      assert.equal((await offClient.call(TOKEN, "GET", "/v1/growth/summary")).status, 404);
      assert.equal((await offClient.call(TOKEN, "POST", "/v1/growth/leads", { email: "a@b.example" })).status, 404);
      const page = await fetch(`${off.base}/r/anything`, { redirect: "manual" });
      assert.equal(page.status, 404);
    } finally {
      await off.close();
    }
  });

  it("refuses a missing or wrong token with 401, and a user's session too", async () => {
    assert.equal((await as(null, "GET", "/v1/growth/summary")).status, 401);
    assert.equal((await as(`${TOKEN}x`, "GET", "/v1/growth/summary")).status, 401);
    assert.equal((await as(TOKEN.slice(1), "GET", "/v1/growth/leads")).json.code, "growth_token");
    const person = await client.signIn("someone@firma.test");
    assert.equal((await as(person.token, "GET", "/v1/growth/summary")).status, 401);
  });

  it("creates, lists, reads and changes leads, with validation", async () => {
    const created = await api("POST", "/v1/growth/leads", {
      email: "Maria@Agentie.EXAMPLE",
      name: "Maria",
      company: "Agenția X",
      country: "RO",
      source: "linkedin",
      seats: 8,
      owner: "agent-outreach",
      consentBasis: "legitimate_interest",
      nextStepAt: "2020-01-01",
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const lead = created.json.lead;
    assert.equal(lead.email, "maria@agentie.example");
    assert.equal(lead.stage, "new");
    assert.equal(lead.nextStepAt, "2020-01-01T00:00:00.000Z");
    assert.equal(created.json.optedOut, false);

    const duplicate = await api("POST", "/v1/growth/leads", { email: "maria@agentie.example" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.id, lead.id);

    for (const body of [
      {},
      { email: "not-an-email" },
      { company: "X", stage: "hot" },
      { company: "X", seats: -1 },
      { company: "X", seats: 1.5 },
      { company: "X", nextStepAt: "tomorrow-ish" },
      { company: "X", notes: "n".repeat(4001) },
      { company: "X", password: "x" },
    ]) {
      assert.equal((await api("POST", "/v1/growth/leads", body)).status, 400, JSON.stringify(body));
    }

    const patched = await api("PATCH", `/v1/growth/leads/${lead.id}`, { stage: "contacted", lastContactAt: "2026-11-15T10:00:00Z", notes: "Primul e-mail trimis." });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.stage, "contacted");
    assert.equal(patched.json.name, "Maria");
    assert.equal((await api("PATCH", `/v1/growth/leads/${lead.id}`, {})).status, 400);
    assert.equal((await api("PATCH", "/v1/growth/leads/lead_missing", { stage: "won" })).status, 404);

    await api("POST", "/v1/growth/leads", { company: "Firma Fără Mail", stage: "qualified", owner: "agent-sdr" });
    const list = await api("GET", "/v1/growth/leads?stage=contacted");
    assert.equal(list.json.total, 1);
    assert.equal(list.json.leads[0].id, lead.id);
    assert.equal((await api("GET", "/v1/growth/leads?owner=agent-sdr")).json.total, 1);
    assert.equal((await api("GET", "/v1/growth/leads?due=1")).json.leads[0].id, lead.id);
    assert.equal((await api("GET", "/v1/growth/leads?limit=1")).json.leads.length, 1);
    assert.equal((await api("GET", "/v1/growth/leads?limit=500")).status, 400);
    assert.equal((await api("GET", "/v1/growth/leads?stage=hot")).status, 400);
    assert.equal((await api("GET", `/v1/growth/leads/${lead.id}`)).json.email, "maria@agentie.example");
    assert.equal((await api("GET", "/v1/growth/leads/lead_missing")).status, 404);
  });

  it("keeps opt-outs: adding moves leads to opted_out, check answers for the address and its domain", async () => {
    const lead = (await api("POST", "/v1/growth/leads", { email: "dan@stop.example", company: "Stop SRL" })).json.lead;
    const added = await api("POST", "/v1/growth/optouts", { domain: "stop.example", reason: "a cerut să nu mai primească", source: "reply" });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.equal(added.json.created, true);
    assert.equal(added.json.leadsMoved, 1);
    assert.equal((await api("GET", `/v1/growth/leads/${lead.id}`)).json.stage, "opted_out");
    // Adding it again changes nothing.
    assert.equal((await api("POST", "/v1/growth/optouts", { domain: "STOP.example" })).json.created, false);
    // An opted-out lead can not be moved back while the address is excluded.
    assert.equal((await api("PATCH", `/v1/growth/leads/${lead.id}`, { stage: "contacted" })).status, 409);
    // A new lead on an excluded domain starts opted out.
    const late = await api("POST", "/v1/growth/leads", { email: "ana@stop.example" });
    assert.equal(late.json.optedOut, true);
    assert.equal(late.json.lead.stage, "opted_out");

    assert.equal((await api("POST", "/v1/growth/optouts", { email: "ion@altundeva.example" })).status, 200);
    const check = async (value: string) => (await api("GET", `/v1/growth/optouts/check?email=${encodeURIComponent(value)}`)).json;
    assert.equal((await check("ion@altundeva.example")).excluded, true);
    assert.equal((await check("ION@altundeva.example")).excluded, true);
    assert.equal((await check("maria@altundeva.example")).excluded, false);
    assert.equal((await check("cineva@sub.stop.example")).excluded, true);
    assert.equal((await check("cineva@sub.stop.example")).match.value, "stop.example");
    assert.equal((await api("GET", "/v1/growth/optouts/check?email=nimic")).status, 400);
    assert.equal((await api("POST", "/v1/growth/optouts", { email: "x" })).status, 400);
    const listed = await api("GET", "/v1/growth/optouts");
    assert.equal(listed.json.total, 2);
  });

  it("creates partner codes, redirects /r/<code> with UTM and counts one click per visitor", async () => {
    const created = await api("POST", "/v1/growth/partners", { code: "Contabil-Ion", partnerName: "Cabinet Ion", partnerEmail: "ion@cabinet.example" });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.partner.code, "contabil-ion");
    assert.equal(created.json.partner.commissionPct, 20);
    assert.equal(created.json.partner.active, true);
    assert.equal(created.json.link, "http://hub.test/r/contabil-ion");
    assert.equal((await api("POST", "/v1/growth/partners", { code: "x" })).status, 400);
    assert.equal((await api("POST", "/v1/growth/partners", { code: "fara-nume" })).status, 400);
    assert.equal((await api("POST", "/v1/growth/partners", { code: "ok-code", partnerName: "P", commissionPct: 101 })).status, 400);

    const go = (path: string, ip = "203.0.113.7") => fetch(`${hub.base}${path}`, { redirect: "manual", headers: { "x-test-ip": ip } });
    const first = await go("/r/contabil-ion");
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "https://zenstaff.app/?utm_source=partner&utm_medium=referral&utm_campaign=contabil-ion");
    await go("/r/CONTABIL-ION/");
    assert.equal((await go("/r/necunoscut")).headers.get("location"), "https://zenstaff.app/");
    assert.equal((await go("/r/%E0%A4%A")).headers.get("location"), "https://zenstaff.app/");

    let partners = (await api("GET", "/v1/growth/partners")).json.partners;
    assert.equal(partners[0].clicks, 1);

    // Turned off: the link still lands on the site, without UTM and without a click.
    const off = await api("POST", "/v1/growth/partners", { code: "contabil-ion", active: false });
    assert.equal(off.json.created, false);
    assert.equal(off.json.partner.partnerName, "Cabinet Ion");
    assert.equal((await go("/r/contabil-ion")).headers.get("location"), "https://zenstaff.app/");
    partners = (await api("GET", "/v1/growth/partners")).json.partners;
    assert.equal(partners[0].clicks, 1);
    // No address of the visitor is kept with the click.
    const raw = JSON.stringify(hub.db.prepare("SELECT * FROM growth_events WHERE event = 'partner_click'").all());
    assert.ok(!raw.includes("127.0.0.1"));
  });

  it("records events the hub can not see itself, refusing personal data in meta", async () => {
    const ok = await api("POST", "/v1/growth/events", { event: "download", utmSource: "newsletter", meta: { os: "win", version: "0.2.4" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await api("POST", "/v1/growth/events", { event: "hack" })).status, 400);
    assert.equal((await api("POST", "/v1/growth/events", { event: "payment", meta: { who: "ana@firma.example" } })).status, 400);
    assert.equal((await api("POST", "/v1/growth/events", { event: "payment", meta: { nested: { a: 1 } } })).status, 400);
    assert.equal((await api("POST", "/v1/growth/events", { event: "payment", meta: { big: "x".repeat(1100) } })).status, 400);
    assert.equal((await api("POST", "/v1/growth/events", { event: "first_task", userId: "usr_nobody" })).status, 400);
  });

  it("sums events per day and type, leads per stage, partner clicks and opt-outs", async () => {
    const result = await api("GET", "/v1/growth/summary?days=7");
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const summary = result.json;
    assert.equal(summary.days, 7);
    assert.ok(summary.eventTotals.signup >= 1);
    assert.equal(summary.eventTotals.partner_click, 1);
    assert.equal(summary.eventTotals.download, 1);
    assert.deepEqual(summary.partnerClicks, [{ code: "contabil-ion", n: 1 }]);
    assert.equal(summary.leadsByStage.opted_out, 2);
    assert.equal(summary.leadsByStage.contacted, 1);
    assert.equal(summary.leadsByStage.won, 0);
    assert.equal(summary.leadsDue, 1);
    assert.deepEqual(summary.optouts, { total: 2, emails: 1, domains: 1 });
    assert.ok(summary.eventsByDay.every((row: { day: string }) => /^\d{4}-\d{2}-\d{2}$/.test(row.day)));
    assert.equal((await api("GET", "/v1/growth/summary?days=0")).status, 400);
    assert.equal((await api("GET", "/v1/growth/summary?days=999")).status, 400);
  });

  it("puts every write in the platform audit chain, with e-mails masked", () => {
    const actions = hub.auditLog.actions("platform");
    for (const action of ["growth.lead.create", "growth.lead.update", "growth.optout.add", "growth.partner.create", "growth.partner.update", "growth.event.record"]) {
      assert.ok(actions.includes(action), action);
    }
    const raw = JSON.stringify(hub.auditLog.db.prepare("SELECT * FROM audit_events WHERE action LIKE 'growth.%'").all());
    for (const address of ["maria@agentie.example", "ion@altundeva.example", "ion@cabinet.example", "dan@stop.example"]) assert.ok(!raw.includes(address), address);
    assert.ok(raw.includes("m***@agentie.example"));
  });

  it("refuses bodies over 16 KB", async () => {
    // The hub answers 413 and closes the connection, so the client may see either.
    const status = await api("POST", "/v1/growth/leads", { company: "Prea Mare", notes: "n".repeat(20_000) }).then(
      (response) => response.status,
      () => 413,
    );
    assert.equal(status, 413);
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM growth_leads WHERE company = 'Prea Mare'").get()!.n, 0);
  });
});
