// The platform admin (/v1/admin/*): who may use which tab, plans set by hand, suspensions and
// their effects (sign-in, sessions, runners), the support actions, the platform audit chain and
// the server-side pages.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

import { PLATFORM_CHAIN } from "../src/auditChain.ts";
import { addMonths, normalizeSubscription } from "../src/storeAdmin.ts";
import { connectRunner, type Hub, makeClient, type Person, startHub, tick } from "./harness.ts";

const ADMIN_GETS = [
  "/v1/admin/companies",
  "/v1/admin/accounts",
  "/v1/admin/staff",
  "/v1/admin/journal",
  "/v1/admin/stats",
];

describe("platform admin", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let alex: Person; // operator, from HUB_ADMIN_EMAILS
  let stela: Person; // operator, from the older HUB_STATS_EMAILS
  let rita: Person; // reviewer (hub_staff)
  let sam: Person; // support (hub_staff)
  let maria: Person; // a customer, owner of Acme
  let ion: Person; // member of Acme
  let companyId = "";

  const platformEvents = () => hub.auditLog.search({ companyId: PLATFORM_CHAIN, limit: 1000 });

  before(async () => {
    hub = await startHub({ config: { plan: "hosted", adminEmails: ["alex@zed.test"], stats: { emails: ["stela@zed.test"] } } });
    client = makeClient(hub);
    alex = await client.signIn("alex@zed.test");
    stela = await client.signIn("stela@zed.test");
    rita = await client.signIn("rita@zed.test");
    sam = await client.signIn("sam@zed.test");
    maria = await client.signIn("maria@acme.test");
    ion = await client.signIn("ion@acme.test");
    const created = await client.call(maria.token, "POST", "/v1/companies", { name: "Acme" });
    companyId = created.json.id ?? created.json.company?.id;
    assert.ok(companyId, JSON.stringify(created.json));
  });
  after(() => hub.close());

  it("is not there for people who are not staff (404 everywhere, no admin in /v1/me)", async () => {
    await client.enableTotp(maria);
    assert.equal((await client.call(maria.token, "GET", "/v1/me")).json.admin, null);
    for (const path of [...ADMIN_GETS, `/v1/admin/companies/${companyId}`, `/v1/admin/subscriptions/${companyId}`, "/v1/admin/me"]) {
      assert.equal((await client.call(maria.token, "GET", path)).status, 404, path);
    }
    assert.equal((await client.call(maria.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "hosted" })).status, 404);
    assert.equal((await client.call(maria.token, "POST", `/v1/admin/companies/${companyId}/suspend`, { reason: "nothing here" })).status, 404);
    assert.equal((await client.call(null, "GET", "/v1/admin/companies")).status, 401);
  });

  it("blocks staff whose session did not pass two-factor", async () => {
    const me = await client.call(alex.token, "GET", "/v1/me");
    assert.deepEqual(me.json.admin.roles, ["operator"]);
    for (const path of ADMIN_GETS) {
      const answer = await client.call(alex.token, "GET", path);
      assert.deepEqual([answer.status, answer.json.code], [403, "admin_two_factor"], path);
    }
    await client.enableTotp(alex);
    await client.enableTotp(stela);
    for (const path of ADMIN_GETS) assert.equal((await client.call(alex.token, "GET", path)).status, 200, path);
    // HUB_STATS_EMAILS keeps working: an operator too.
    assert.deepEqual((await client.call(stela.token, "GET", "/v1/admin/me")).json.roles, ["operator"]);
    assert.equal((await client.call(stela.token, "GET", "/v1/admin/accounts")).status, 200);
  });

  it("lets an operator add reviewers and support staff (and not change their own role)", async () => {
    assert.equal((await client.call(alex.token, "PUT", "/v1/admin/staff", { email: "rita@zed.test", role: "reviewer" })).status, 200);
    assert.equal((await client.call(alex.token, "PUT", "/v1/admin/staff", { email: "sam@zed.test", role: "support" })).status, 200);
    assert.equal((await client.call(alex.token, "PUT", "/v1/admin/staff", { email: "nobody@zed.test", role: "support" })).status, 404);
    assert.equal((await client.call(alex.token, "PUT", "/v1/admin/staff", { email: "rita@zed.test", role: "owner" })).status, 400);
    assert.equal((await client.call(alex.token, "PUT", "/v1/admin/staff", { email: "alex@zed.test", role: "support" })).status, 400);
    const staff = (await client.call(alex.token, "GET", "/v1/admin/staff")).json.staff;
    assert.deepEqual(
      staff.map((entry: any) => [entry.email, entry.role, entry.source]),
      [
        ["alex@zed.test", "operator", "env"],
        ["stela@zed.test", "operator", "env"],
        ["rita@zed.test", "reviewer", "table"],
        ["sam@zed.test", "support", "table"],
      ],
    );
    await client.enableTotp(rita);
    await client.enableTotp(sam);
    // A reviewer from hub_staff reaches the library review queue.
    assert.equal((await client.call(rita.token, "GET", "/v1/library/review/queue")).status, 200);
    // So does an operator (no HUB_LIBRARY_REVIEWERS needed).
    assert.equal((await client.call(alex.token, "GET", "/v1/library/review/queue")).status, 200);
    assert.equal((await client.call(sam.token, "GET", "/v1/library/review/queue")).status, 403);
  });

  it("keeps the reviewer out of billing, companies, accounts and the journal", async () => {
    assert.deepEqual((await client.call(rita.token, "GET", "/v1/admin/me")).json.caps, ["library"]);
    for (const path of [`/v1/admin/subscriptions/${companyId}`, "/v1/admin/companies", "/v1/admin/accounts", "/v1/admin/journal", "/v1/admin/stats", "/v1/admin/staff"]) {
      const answer = await client.call(rita.token, "GET", path);
      assert.deepEqual([answer.status, answer.json.code], [403, "admin_forbidden"], path);
    }
    assert.equal((await client.call(rita.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "free" })).status, 403);
    assert.ok(platformEvents().some((event) => event.action === "admin.denied" && event.actorEmail === "rita@zed.test" && event.target === "billing.view"));
  });

  it("lets support see companies and accounts without plans, and not change plans or staff", async () => {
    assert.deepEqual((await client.call(sam.token, "GET", "/v1/admin/me")).json.caps, ["companies", "accounts", "support"]);
    const companies = await client.call(sam.token, "GET", "/v1/admin/companies");
    assert.equal(companies.status, 200);
    assert.equal(companies.json.items[0].name, "Acme");
    assert.equal(companies.json.items[0].plan, undefined);
    assert.equal(companies.json.items[0].pricePerSeat, undefined);
    assert.equal((await client.call(sam.token, "GET", `/v1/admin/subscriptions/${companyId}`)).status, 403);
    assert.equal((await client.call(sam.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "founder", seats: 3 })).status, 403);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/subscriptions/${companyId}/trial`, { days: 7, reason: "client asked" })).status, 403);
    assert.equal((await client.call(sam.token, "PUT", "/v1/admin/staff", { email: "ion@acme.test", role: "support" })).status, 403);
    assert.equal((await client.call(sam.token, "GET", "/v1/admin/journal")).status, 403);
    assert.equal((await client.call(sam.token, "GET", `/v1/admin/companies/${companyId}`)).json.subscription, undefined);
  });

  it("shows companies with owner, plan, seats and members (operator)", async () => {
    await client.call(maria.token, "POST", `/v1/companies/${companyId}/invites`, { role: "member", email: "ion@acme.test" });
    const me = await client.call(ion.token, "GET", "/v1/me");
    assert.equal((await client.call(ion.token, "POST", "/v1/invites/accept", { inviteId: me.json.invites[0].id })).status, 200);
    const list = await client.call(alex.token, "GET", "/v1/admin/companies");
    const acme = list.json.items[0];
    assert.equal(acme.owner.email, "maria@acme.test");
    assert.deepEqual([acme.plan, acme.status, acme.planSet, acme.pricePerSeat], ["hosted", "trial", false, 29]);
    assert.deepEqual([acme.members, acme.seatsUsed, acme.seatsPaid, acme.runners, acme.runnersOnline, acme.packsPublished], [2, 2, 0, 0, 0, 0]);
    assert.equal(acme.suspended, null);
    // Search, filter.
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?q=acm")).json.total, 1);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?q=maria%40acme")).json.total, 1);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?q=zzz")).json.total, 0);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?plan=founder")).json.total, 0);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?plan=hosted&status=trial")).json.total, 1);
  });

  it("never returns chat, memory or file content: metadata only", async () => {
    const detail = await client.call(alex.token, "GET", `/v1/admin/companies/${companyId}`);
    assert.deepEqual(Object.keys(detail.json).sort(), ["company", "invites", "members", "runners", "subscription"]);
    const text = JSON.stringify(detail.json);
    for (const word of ["memory_url", "memoryUrl", "title", "comment", "sealed", "prompt"]) assert.ok(!text.includes(word), word);
    // There is no "sign in as" route.
    for (const path of ["/v1/admin/impersonate", `/v1/admin/accounts/${ion.userId}/impersonate`, `/v1/admin/accounts/${ion.userId}/session`]) {
      assert.equal((await client.call(alex.token, "POST", path, {})).status, 404, path);
    }
  });

  it("sets a plan by hand, keeps the history and writes the audit chain", async () => {
    const bad = await client.call(alex.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "free", pricePerSeat: 29 });
    assert.equal(bad.status, 400);
    assert.equal((await client.call(alex.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "hosted", periodStart: "2026-12-01", periodEnd: "2026-11-01" })).status, 400);
    assert.equal((await client.call(alex.token, "PUT", `/v1/admin/subscriptions/${companyId}`, { plan: "hosted", invoiceRef: "<script>" })).status, 400);
    const set = await client.call(alex.token, "PUT", `/v1/admin/subscriptions/${companyId}`, {
      plan: "founder",
      seats: 5,
      status: "active",
      periodStart: "2026-11-08",
      invoiceRef: "ZEN 0001",
      note: "Transfer bancar, oferta de fondator",
    });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.deepEqual(
      [set.json.subscription.plan, set.json.subscription.pricePerSeat, set.json.subscription.seats, set.json.subscription.periodEnd, set.json.subscription.invoiceRef],
      ["founder", 19, 5, "2027-11-08", "ZEN 0001"],
    );
    const trial = await client.call(alex.token, "POST", `/v1/admin/subscriptions/${companyId}/trial`, { days: 10, reason: "a cerut încă o săptămână" });
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    assert.equal(trial.json.subscription.status, "trial");
    assert.equal((await client.call(alex.token, "POST", `/v1/admin/subscriptions/${companyId}/trial`, { days: 10, reason: "" })).status, 400);
    const read = await client.call(alex.token, "GET", `/v1/admin/subscriptions/${companyId}`);
    assert.deepEqual(read.json.history.map((entry: any) => entry.action), ["trial", "set"]);
    assert.equal(read.json.history[1].before, null);
    assert.equal(read.json.history[0].before.plan, "founder");
    assert.equal(read.json.payments.available, false);
    assert.deepEqual(read.json.prices, { free: 0, hosted: 29, founder: 19, selfhost: 0 });
    const list = await client.call(alex.token, "GET", "/v1/admin/companies?plan=founder");
    assert.deepEqual([list.json.total, list.json.items[0].seatsPaid], [1, 5]);
    const event = platformEvents().find((entry) => entry.action === "admin.plan.set")!;
    assert.equal(event.actorEmail, "alex@zed.test");
    assert.equal(event.target, `company:${companyId}`);
    assert.equal(event.companyId, null);
    assert.equal(event.ip, "127.0.0.1");
    assert.ok(event.deviceId);
    assert.equal((event.detail.after as any).plan, "founder");
    // Not in the company's own chain: the customer's journal does not hold our admin work.
    assert.ok(!hub.auditLog.search({ companyId, limit: 1000 }).some((entry) => entry.action.startsWith("admin.")));
  });

  it("shows the payments data (v12) read-only once a company has a billing row", async () => {
    // Payments (Stripe) are off in tests: the tables exist since v12, but the page says "off" until
    // a company has a billing account or an invoice.
    hub.db.exec(`INSERT INTO billing_accounts (company_id, plan, status, seats, servers, cancel_at_period_end, updated_at) VALUES ('${companyId}', 'hosted', 'active', 5, 0, 0, '2026-11-08');
      INSERT INTO billing_invoices (stripe_invoice_id, company_id, kind, amount_cents, currency, paid_at, fiscal_status, fiscal_series, fiscal_number, efactura_status, created_at, updated_at)
        VALUES ('in_1', '${companyId}', 'subscription', 9500, 'eur', 1, 'issued', 'ZEN', '0007', 'ok', '2026-11-08', '2026-11-08');`);
    const read = await client.call(alex.token, "GET", `/v1/admin/subscriptions/${companyId}`);
    assert.equal(read.json.payments.available, true);
    assert.equal(read.json.payments.account.status, "active");
    assert.deepEqual([read.json.payments.invoices[0].fiscalSeries, read.json.payments.invoices[0].fiscalNumber], ["ZEN", "0007"]);
    hub.db.exec(`DELETE FROM billing_invoices WHERE company_id = '${companyId}'; DELETE FROM billing_accounts WHERE company_id = '${companyId}';`);
  });

  it("validates plans: founder 19 for 12 months, free plans cost nothing", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(normalizeSubscription({ plan: "founder", periodStart: "2026-02-10" }).periodEnd, "2027-02-10");
    assert.equal(normalizeSubscription({ plan: "hosted" }).pricePerSeat, 29);
    assert.equal(normalizeSubscription({ plan: "selfhost" }).pricePerSeat, 0);
    assert.throws(() => normalizeSubscription({ plan: "gold" }));
    assert.throws(() => normalizeSubscription({ plan: "hosted", seats: -1 }));
    assert.throws(() => normalizeSubscription({ plan: "hosted", periodStart: "2026-02-30" }));
    assert.equal(normalizeSubscription({ plan: "hosted", status: "trial" }).trialEnd !== null, true);
  });

  it("pages accounts on the server with page numbers", async () => {
    for (let index = 0; index < 7; index += 1) await client.signIn(`extra${index}@else.test`);
    const first = await client.call(alex.token, "GET", "/v1/admin/accounts?per=5&page=1");
    assert.deepEqual([first.json.total, first.json.pages, first.json.page, first.json.items.length], [13, 3, 1, 5]);
    const last = await client.call(alex.token, "GET", "/v1/admin/accounts?per=5&page=3");
    assert.equal(last.json.items.length, 3);
    const seen = new Set([...first.json.items, ...(await client.call(alex.token, "GET", "/v1/admin/accounts?per=5&page=2")).json.items, ...last.json.items].map((item: any) => item.id));
    assert.equal(seen.size, 13);
    const ionRow = (await client.call(alex.token, "GET", "/v1/admin/accounts?q=ion%40acme")).json.items[0];
    assert.deepEqual([ionRow.email, ionRow.twoFactor, ionRow.devices, ionRow.companies[0].name], ["ion@acme.test", false, 1, "Acme"]);
    assert.ok(ionRow.lastSignInAt);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/accounts?twofa=on")).json.total, 5);
    assert.equal((await client.call(alex.token, "GET", `/v1/admin/accounts?company=${companyId}`)).json.total, 2);
    // Out of range pages are empty, not errors; per is capped.
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/accounts?per=5&page=9")).json.items.length, 0);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/accounts?per=1000")).json.per, 100);
  });

  it("support: resends an invitation with a fresh link", async () => {
    const invited = await client.call(maria.token, "POST", `/v1/companies/${companyId}/invites`, { role: "member", email: "nou@acme.test" });
    const oldLink = invited.json.link as string;
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/invites/${invited.json.inviteId}/resend`, {})).status, 400);
    const resent = await client.call(sam.token, "POST", `/v1/admin/invites/${invited.json.inviteId}/resend`, { reason: "nu a primit e-mailul" });
    assert.equal(resent.status, 200, JSON.stringify(resent.json));
    const mail = client.lastMail("nou@acme.test")!;
    assert.match(mail.subject, /Acme/);
    assert.ok(!mail.text.includes(oldLink));
    const nou = await client.signIn("nou@acme.test");
    assert.notEqual((await client.call(nou.token, "POST", "/v1/invites/accept", { token: oldLink })).status, 200);
  });

  it("support: revokes every session of an account", async () => {
    const second = await client.signIn("ion@acme.test");
    const revoked = await client.call(sam.token, "POST", `/v1/admin/accounts/${ion.userId}/sessions/revoke`, { reason: "laptop pierdut" });
    assert.deepEqual([revoked.status, revoked.json.sessions], [200, 2]);
    assert.equal((await client.call(ion.token, "GET", "/v1/me")).status, 401);
    assert.equal((await client.call(second.token, "GET", "/v1/me")).status, 401);
    ion = await client.signIn("ion@acme.test");
  });

  it("support: resets two-factor only after the typed e-mail and a reason, and e-mails the person", async () => {
    await client.enableTotp(ion);
    const path = `/v1/admin/accounts/${ion.userId}/two-factor/reset`;
    assert.equal((await client.call(sam.token, "POST", path, { reason: "telefon pierdut", confirm: "ion@acme" })).json.code, "confirm_mismatch");
    assert.equal((await client.call(sam.token, "POST", path, { reason: "", confirm: "ion@acme.test" })).status, 400);
    assert.equal((await client.call(ion.token, "GET", "/v1/me")).json.twoFactor.enabled, true);
    const reset = await client.call(sam.token, "POST", path, { reason: "telefon pierdut", confirm: "ION@acme.test" });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal((await client.call(ion.token, "GET", "/v1/me")).status, 401);
    const mail = client.lastMail("ion@acme.test")!;
    assert.match(mail.subject, /doi pași/);
    assert.match(mail.text, /telefon pierdut/);
    ion = await client.signIn("ion@acme.test");
    assert.equal((await client.call(ion.token, "GET", "/v1/me")).json.twoFactor.enabled, false);
    const event = platformEvents().find((entry) => entry.action === "admin.twofactor.reset")!;
    assert.deepEqual([event.actorEmail, event.target, (event.detail as any).reason], ["sam@zed.test", `user:${ion.userId}`, "telefon pierdut"]);
  });

  it("support cannot act on staff accounts or on themselves", async () => {
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/accounts/${alex.userId}/suspend`, { reason: "probă de test" })).status, 403);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/accounts/${sam.userId}/suspend`, { reason: "probă de test" })).status, 400);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/accounts/${alex.userId}/sessions/revoke`, { reason: "probă de test" })).status, 403);
  });

  it("a suspended account cannot sign in, its sessions end and its runner is refused", async () => {
    const registered = await client.call(ion.token, "POST", "/v1/environments", { name: "Ion server" });
    const runner = await connectRunner(hub, registered.json.credential);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/accounts/${ion.userId}/suspend`, { reason: "nu" })).status, 400);
    const suspended = await client.call(sam.token, "POST", `/v1/admin/accounts/${ion.userId}/suspend`, { reason: "plată refuzată, frauda" });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.json));
    assert.equal((await client.call(ion.token, "GET", "/v1/me")).status, 401);
    // Signing in again is refused (the code is right, the account is not).
    assert.equal((await client.call(null, "POST", "/v1/auth/start", { email: "ion@acme.test" })).status, 200);
    const code = /: (\d{6})$/.exec(client.lastMail("ion@acme.test")!.subject)![1];
    const again = await client.call(null, "POST", "/v1/auth/verify", { email: "ion@acme.test", code });
    assert.deepEqual([again.status, again.json.code], [403, "account_suspended"]);
    // The runner is refused when it dials in again.
    const socket = new WebSocket(`${hub.base.replace("http", "ws")}/v1/runner`);
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ t: "hello", credential: registered.json.credential }));
    assert.equal(await new Promise((resolve) => socket.on("close", (closeCode) => resolve(closeCode))), 4004);
    const listed = await client.call(alex.token, "GET", "/v1/admin/accounts?suspended=yes");
    assert.deepEqual(listed.json.items.map((item: any) => [item.email, item.suspended.reason]), [["ion@acme.test", "plată refuzată, frauda"]]);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/accounts/${ion.userId}/unsuspend`, { reason: "a plătit, reactivat" })).status, 200);
    ion = await client.signIn("ion@acme.test");
    runner.close();
  });

  it("a suspended company's runner refuses every request", async () => {
    const registered = await client.call(maria.token, "POST", "/v1/environments", { name: "Acme runner" });
    const runner = await connectRunner(hub, registered.json.credential);
    assert.equal((await client.call(maria.token, "PUT", `/v1/environments/${registered.json.environmentId}/runner`, { companyId })).status, 200);
    const shared = await client.call(maria.token, "POST", "/v1/shares", {
      environmentId: registered.json.environmentId,
      companyId,
      threadId: "t-1",
      kind: "personal",
      audienceUserId: null,
      title: "x",
    });
    const shareId = shared.json.id;
    assert.equal((await client.relay(ion, `/v1/shares/${shareId}/view`, "thread.view", shareId)).status, 200);
    const online = (await client.call(alex.token, "GET", "/v1/admin/companies")).json.items[0];
    assert.deepEqual([online.runners, online.runnersOnline], [1, 1]);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/companies/${companyId}/suspend`, { reason: "factură neplătită 60 zile" })).status, 200);
    const refused = await client.relay(ion, `/v1/shares/${shareId}/view`, "thread.view", shareId);
    assert.equal(refused.status, 423);
    const asked = runner.asked.length;
    await tick();
    assert.equal(runner.asked.length, asked);
    assert.equal((await client.call(alex.token, "GET", "/v1/admin/companies?suspended=yes")).json.total, 1);
    assert.equal((await client.call(sam.token, "POST", `/v1/admin/companies/${companyId}/unsuspend`, { reason: "plătit integral" })).status, 200);
    assert.equal((await client.relay(ion, `/v1/shares/${shareId}/view`, "thread.view", shareId)).status, 200);
    runner.close();
  });

  it("writes every admin request to the platform chain, which verifies, searches, pages and exports", async () => {
    const events = platformEvents();
    const actions = new Set(events.map((event) => event.action));
    for (const action of ["admin.view", "admin.staff.set", "admin.plan.set", "admin.plan.trial", "admin.invite.resend", "admin.sessions.revoke", "admin.twofactor.reset", "admin.account.suspend", "admin.account.unsuspend", "admin.company.suspend", "admin.company.unsuspend", "admin.denied"]) {
      assert.ok(actions.has(action), action);
    }
    assert.ok(events.every((event) => event.chain === PLATFORM_CHAIN && event.companyId === null && event.ip !== null));
    const verify = await client.call(alex.token, "GET", "/v1/admin/journal/verify");
    assert.deepEqual([verify.status, verify.json.ok], [200, true]);
    const page = await client.call(alex.token, "GET", "/v1/admin/journal?per=5&page=2");
    assert.equal(page.json.items.length, 5);
    assert.ok(page.json.pages >= 3);
    const suspensions = await client.call(alex.token, "GET", "/v1/admin/journal?action=admin.company");
    assert.deepEqual(suspensions.json.items.map((event: any) => event.action), ["admin.company.unsuspend", "admin.company.suspend"]);
    // The search is itself written first (admin.view with its filters), then answered.
    const byText = await client.call(alex.token, "GET", "/v1/admin/journal?q=telefon%20pierdut");
    assert.deepEqual(byText.json.items.map((event: any) => event.action), ["admin.view", "admin.twofactor.reset"]);
    const bySam = await client.call(alex.token, "GET", "/v1/admin/journal?actor=sam@zed.test&action=admin.account");
    assert.equal(bySam.json.total, 2);
    const csv = await client.call(alex.token, "GET", "/v1/admin/journal/export?format=csv&action=admin.plan");
    assert.match(csv.json.filename, /^jurnal-platforma-.*\.csv$/);
    assert.equal(csv.json.body.trim().split("\r\n").length, 3);
    const json = JSON.parse((await client.call(alex.token, "GET", "/v1/admin/journal/export?format=json")).json.body);
    assert.equal(json.chain, "platform");
    assert.ok(platformEvents().some((event) => event.action === "admin.journal.export"));
  });

  it("serves the admin pages", async () => {
    for (const path of ["/app/admin", "/app/admin/firme", "/app/admin/conturi", "/app/admin/abonamente", "/app/admin/suport", "/app/admin/biblioteca", "/app/admin/jurnal", "/app/admin/cifre"]) {
      assert.equal((await fetch(`${hub.base}${path}`)).status, 200, path);
    }
  });

  it("an operator removes a staff member from the table, not the bootstrap ones", async () => {
    assert.equal((await client.call(alex.token, "DELETE", `/v1/admin/staff/${stela.userId}`)).status, 404);
    assert.equal((await client.call(alex.token, "DELETE", `/v1/admin/staff/${rita.userId}`)).status, 200);
    assert.equal((await client.call(rita.token, "GET", "/v1/admin/me")).status, 404);
    assert.equal((await client.call(rita.token, "GET", "/v1/library/review/queue")).status, 403);
  });
});
