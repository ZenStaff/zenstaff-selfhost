// The web dashboard: its pages and headers, the cookie session (httpOnly, SameSite=Strict, only on
// requests from the hub's own pages), and the read endpoints it uses, with their role checks.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { WEB_CSP } from "../src/routes/web.ts";
import * as team from "../src/storeTeam.ts";
import { connectRunner, type Hub, makeClient, type Person, startHub, tick } from "./harness.ts";

const ORIGIN = "http://hub.test";

/** Signs in through the web route and returns the cookie pair ("zen_web=..."). */
async function webSignIn(hub: Hub, client: ReturnType<typeof makeClient>, email: string) {
  assert.equal((await client.call(null, "POST", "/v1/auth/start", { email })).status, 200);
  const code = /: (\d{6})$/.exec(client.lastMail(email)!.subject)![1];
  const response = await fetch(`${hub.base}/v1/web/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zen-web": "1", origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" },
    body: JSON.stringify({ email, code }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { setCookie, cookie: setCookie.split(";")[0]!, json: (await response.json()) as any };
}

const web = (hub: Hub, cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${hub.base}${path}`, {
    method,
    headers: { "x-zen-web": "1", cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("web dashboard", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let owner: Person;
  let member: Person;
  let guest: Person;
  let outsider: Person;
  let acme = "";
  let runnerCredential = "";
  let runnerId = "";

  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
    owner = await client.signIn("owner@acme.test");
    member = await client.signIn("member@acme.test");
    guest = await client.signIn("guest@acme.test");
    outsider = await client.signIn("someone@else.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Acme" })).json.id;
    await client.enableTotp(owner);
    for (const [person, role] of [
      [member, "member"],
      [guest, "guest"],
    ] as const) {
      const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role });
      assert.equal((await client.call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    }
    const environment = await client.call(owner.token, "POST", "/v1/environments", { name: "Birou" });
    runnerId = environment.json.environmentId;
    runnerCredential = environment.json.credential;
    assert.equal((await client.call(owner.token, "PUT", `/v1/environments/${runnerId}/runner`, { companyId: acme })).status, 200);
  });
  after(() => hub.close());

  it("serves the shell on /app and its pages with a strict CSP; unknown pages are 404", async () => {
    for (const path of ["/app", "/app/acasa", "/app/echipa", "/app/intra"]) {
      const response = await fetch(`${hub.base}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-security-policy"), WEB_CSP);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text();
      assert.match(html, /<script src="\/app\/assets\/app\.js\?v=[\w-]+" type="module">/);
      assert.match(html, /integrity="sha384-/);
      assert.doesNotMatch(html, /<script>/);
    }
    assert.equal((await fetch(`${hub.base}/app/nope`)).status, 404);
    // The shell's language is a first guess the script settles: ?lang, else the browser's.
    assert.match(await (await fetch(`${hub.base}/app/intra`, { headers: { "accept-language": "en-US" } })).text(), /<html lang="en">/);
    assert.match(await (await fetch(`${hub.base}/app/intra?lang=ro`, { headers: { "accept-language": "en-US" } })).text(), /<html lang="ro">/);
    assert.doesNotMatch(WEB_CSP, /unsafe|\*/);
  });

  it("serves the script, styles, fonts and logo from the hub itself", async () => {
    const js = await fetch(`${hub.base}/app/assets/app.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    const etag = js.headers.get("etag")!;
    assert.equal((await fetch(`${hub.base}/app/assets/app.js`, { headers: { "if-none-match": etag } })).status, 304);
    assert.equal((await fetch(`${hub.base}/app/assets/app.css`)).headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await fetch(`${hub.base}/app/assets/fonts/young-serif-latin-ext.woff2`)).headers.get("content-type"), "font/woff2");
    assert.equal((await fetch(`${hub.base}/app/assets/logo.svg`)).headers.get("content-type"), "image/svg+xml");
    assert.equal((await fetch(`${hub.base}/app/assets/../db.ts`)).status, 404);
    // The painted backdrops and the title font are served from the hub (the CSP allows nothing else).
    const art = await fetch(`${hub.base}/app/assets/art/dealuri-zori.webp`);
    assert.equal(art.headers.get("content-type"), "image/webp");
    assert.equal(art.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal((await fetch(`${hub.base}/app/assets/fonts/young-serif-latin.woff2`)).headers.get("content-type"), "font/woff2");
    // The e-mail logo is the one file other origins (mail clients) may load.
    const mailLogo = await fetch(`${hub.base}/app/assets/mail/logo.png`);
    assert.equal(mailLogo.headers.get("content-type"), "image/png");
    assert.equal(mailLogo.headers.get("cross-origin-resource-policy"), "cross-origin");
  });

  it("the invitation page offers to accept in the browser, without inline script", async () => {
    const response = await fetch(`${hub.base}/invite`);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const html = await response.text();
    assert.match(html, /\/app\/invitatie/);
    assert.match(html, /src="\/app\/assets\/invite\.js"/);    // Download links and steps, one language at a time, no "hub".
    assert.match(html, /Zen-Staff-Setup-x64\.exe/);
    assert.match(html, /Am primit o invitație/);
    assert.doesNotMatch(html, /You are invited|\bhub\b/i);
    const en = await (await fetch(`${hub.base}/invite?lang=en`)).text();
    assert.match(en, /<html lang="en">/);
    assert.match(en, /I was invited/);
    assert.doesNotMatch(en, /Ai primit/);
    assert.match(en, /href="\/app\/invitatie\?lang=en"/, "the dashboard opens in the same language");
    // Without ?lang, the browser's language decides.
    assert.match(await (await fetch(`${hub.base}/invite`, { headers: { "accept-language": "de-DE,de;q=0.9" } })).text(), /<html lang="en">/);
    assert.match(await (await fetch(`${hub.base}/invite`, { headers: { "accept-language": "ro" } })).text(), /<html lang="ro">/);
  });

  it("the invitation preview names the company, who invites and the role, for a valid token only", async () => {
    const owner = await client.signIn("owner@preview.test");
    await client.call(owner.token, "PATCH", "/v1/me", { name: "Ion Popa" });
    const company = (await client.call(owner.token, "POST", "/v1/companies", { name: "Florăria Iris" })).json.id;
    await client.enableTotp(owner);
    const invite = await client.call(owner.token, "POST", `/v1/companies/${company}/invites`, { email: "maria@preview.test", role: "member" });
    assert.equal(invite.status, 200);
    const token = String(invite.json.link).split("#")[1];
    const preview = await client.call(null, "POST", "/v1/invites/preview", { token });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.companyName, "Florăria Iris");
    assert.equal(preview.json.roleName.ro, "Membru");
    assert.equal(preview.json.email, "maria@preview.test");
    assert.equal(preview.json.inviter, "Ion Popa");
    assert.equal((await client.call(null, "POST", "/v1/invites/preview", { token: "inv_nope" })).status, 404);
    await client.call(owner.token, "DELETE", `/v1/companies/${company}/invites/${invite.json.inviteId}`);
    assert.equal((await client.call(null, "POST", "/v1/invites/preview", { token })).status, 404, "revoked");
  });

  it("web sign-in puts the session in an httpOnly, SameSite=Strict cookie, never in the body", async () => {
    const signed = await webSignIn(hub, client, "browser@acme.test");
    assert.match(signed.setCookie, /^zen_web=zhs_[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1209600$/);
    assert.equal(signed.json.token, undefined);
    assert.equal(signed.json.twoFactor, "ok");
    const me = await web(hub, signed.cookie, "GET", "/v1/me");
    assert.equal(me.status, 200);
    const sessions = (await (await web(hub, signed.cookie, "GET", "/v1/me/sessions")).json()) as any;
    assert.equal(sessions.sessions[0].label, "Browser (Chrome, Windows)");
  });

  it("the cookie only counts on the hub's own requests (custom header, same origin)", async () => {
    const { cookie } = await webSignIn(hub, client, "csrf@acme.test");
    // No custom header: a plain cross-site form or image request.
    assert.equal((await fetch(`${hub.base}/v1/me`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${hub.base}/v1/companies`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"name":"x"}' })).status, 401);
    // Header present but the browser says the request came from elsewhere.
    assert.equal((await web(hub, cookie, "POST", "/v1/companies", { name: "x" }, { origin: "https://evil.example" })).status, 401);
    assert.equal((await web(hub, cookie, "GET", "/v1/me", undefined, { "sec-fetch-site": "cross-site" })).status, 401);
    assert.equal((await web(hub, cookie, "GET", "/v1/me", undefined, { "sec-fetch-site": "same-origin", origin: ORIGIN })).status, 200);
    // The web sign-in routes themselves refuse requests without the header (login CSRF).
    assert.equal((await client.call(null, "POST", "/v1/web/auth/verify", { email: "csrf@acme.test", code: "000000" })).status, 403);
    // The app's bearer tokens are unchanged.
    assert.equal((await client.call(member.token, "GET", "/v1/me")).status, 200);
  });

  it("logout ends the session and clears the cookie", async () => {
    const { cookie } = await webSignIn(hub, client, "bye@acme.test");
    const out = await web(hub, cookie, "POST", "/v1/web/auth/logout", {});
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /^zen_web=; .*Max-Age=0/);
    assert.equal((await web(hub, cookie, "GET", "/v1/me")).status, 401);
  });

  it("on https the cookie is __Host- and Secure", async () => {
    const secure = await startHub({ config: { publicUrl: "https://hub.example" } });
    try {
      const secureClient = makeClient(secure);
      await secureClient.call(null, "POST", "/v1/auth/start", { email: "s@acme.test" });
      const code = /: (\d{6})$/.exec(secureClient.lastMail("s@acme.test")!.subject)![1];
      const response = await fetch(`${secure.base}/v1/web/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zen-web": "1", origin: "https://hub.example" },
        body: JSON.stringify({ email: "s@acme.test", code }),
      });
      assert.match(response.headers.get("set-cookie") ?? "", /^__Host-zen_web=zhs_[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
      assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
    } finally {
      await secure.close();
    }
  });

  it("an owner's web session needs the two-factor code like the app's", async () => {
    const { cookie, json } = await webSignIn(hub, client, "owner@acme.test");
    assert.equal(json.twoFactor, "verify");
    const blocked = await web(hub, cookie, "GET", `/v1/companies/${acme}/overview`);
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as any).code, "two_factor_required");
    assert.equal((await web(hub, cookie, "POST", "/v1/auth/totp/verify", { code: client.totpCode(owner) })).status, 200);
    assert.equal((await web(hub, cookie, "GET", `/v1/companies/${acme}/overview`)).status, 200);
  });

  it("two-factor setup also returns the QR as an SVG path", async () => {
    const setup = await client.call(member.token, "POST", "/v1/auth/totp/setup");
    assert.equal(setup.status, 200);
    assert.ok(setup.json.qr.size >= 25);
    assert.match(setup.json.qr.path, /^M\d+ \d+h\d+v1h-\d+z/);
  });

  it("the overview: approvals, runners, plan and a week of activity, by role", async () => {
    // A runner reports the member's new device; the member asks the company runner twice.
    const runner = await connectRunner(hub, runnerCredential);
    try {
      const alert = await fetch(`${hub.base}/v1/runner/pending-device`, {
        method: "POST",
        headers: { authorization: `Runner ${runnerCredential}`, "content-type": "application/json" },
        body: JSON.stringify({ userId: member.userId, keyId: member.device.keyId, companyId: acme }),
      });
      assert.equal(alert.status, 200);
      for (const op of ["staff.task", "staff.list"]) {
        const input = { staffId: "contabil" };
        const asked = await client.call(member.token, "POST", `/v1/companies/${acme}/runner`, { op, input, sig: client.signRequest(member, op, `company:${acme}`, input) });
        assert.equal(asked.status, 200, JSON.stringify(asked.json));
      }
      await tick();
      const ownerView = await client.call(owner.token, "GET", `/v1/companies/${acme}/overview`);
      assert.equal(ownerView.status, 200);
      const view = ownerView.json;
      assert.equal(view.role, "owner");
      assert.deepEqual(view.plan, { kind: "selfhost", status: "none", access: "full", reason: "selfhost", graceEndsAt: null, seats: 2, guests: 1, pricePerSeatEur: 0 });
      assert.deepEqual(view.members.byRole, { owner: 1, admin: 0, member: 1, guest: 1 });
      assert.equal(view.runners.length, 1);
      assert.equal(view.runners[0].online, true);
      assert.equal(view.approvals.devices.length, 1);
      assert.equal(view.approvals.devices[0].email, member.email);
      assert.match(view.approvals.devices[0].fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/);
      assert.equal(view.activity.staffTasks, 1);
      assert.equal(view.activity.staffLists, 1);
      assert.equal(view.activity.days.length, 7);
      assert.equal(view.activity.days.at(-1).tasks, 1);
      assert.equal(JSON.stringify(view).includes("contabil"), false, "the overview never repeats request content");
      // 30 days of series for the sparklines and the activity chart (counts only).
      assert.equal(view.trend.activity.days.length, 30);
      assert.equal(view.trend.activity.days.at(-1).tasks, 1);
      assert.equal(view.trend.activity.staffTasks, 1);
      assert.equal(view.trend.members.length, 30);
      assert.equal(view.trend.members.at(-1).total, 3);
      assert.equal(view.trend.approvals.at(-1).n, 1);

      // The member sees only their own pending device and no manager counts.
      const memberView = (await client.call(member.token, "GET", `/v1/companies/${acme}/overview`)).json;
      assert.equal(memberView.approvals.devices.length, 1);
      assert.equal(memberView.members.withoutTwoFactor, null);
      assert.equal(memberView.invites.pending, null);
      assert.equal(memberView.trend.approvals.at(-1).n, 1, "the member's own device");
      // Guests: no activity, no company details, no staff.
      const guestView = (await client.call(guest.token, "GET", `/v1/companies/${acme}/overview`)).json;
      assert.equal(guestView.activity, null);
      assert.equal(guestView.trend, null);
      assert.equal(guestView.company.details, null);
      assert.equal(guestView.staff.visible, false);
      assert.equal(guestView.approvals.devices.length, 0);
      // Not a member: no such company.
      assert.equal((await client.call(outsider.token, "GET", `/v1/companies/${acme}/overview`)).status, 404);
    } finally {
      runner.close();
    }
  });

  it("the hosted plan shows the price per seat", async () => {
    const hosted = await startHub({ config: { plan: "hosted" } });
    try {
      const hostedClient = makeClient(hosted);
      const boss = await hostedClient.signIn("boss@hosted.test");
      const id = (await hostedClient.call(boss.token, "POST", "/v1/companies", { name: "H" })).json.id;
      await hostedClient.enableTotp(boss);
      const view = (await hostedClient.call(boss.token, "GET", `/v1/companies/${id}/overview`)).json;
      assert.deepEqual(view.plan, { kind: "hosted", status: "none", access: "full", reason: "none", graceEndsAt: null, seats: 1, guests: 0, pricePerSeatEur: 29 });
    } finally {
      await hosted.close();
    }
  });

  it("the staff summary has no ciphertext and is closed to guests", async () => {
    const summary = await client.call(member.token, "GET", `/v1/companies/${acme}/staff/summary`);
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.json.staff, []);
    assert.equal((await client.call(guest.token, "GET", `/v1/companies/${acme}/staff/summary`)).status, 403);
    assert.equal((await client.call(outsider.token, "GET", `/v1/companies/${acme}/staff/summary`)).status, 404);
  });

  it("owners and admins rename the company and keep its invoicing details; members cannot", async () => {
    assert.equal((await client.call(member.token, "PATCH", `/v1/companies/${acme}`, { name: "Mine" })).status, 403);
    assert.equal((await client.call(outsider.token, "PATCH", `/v1/companies/${acme}`, { name: "Mine" })).status, 404);
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, { details: { taxId: "RO12AB" } })).status, 400);
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, { details: { billingEmail: "nope" } })).status, 400);
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, { name: "" })).status, 400);
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, {})).status, 400);
    const saved = await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, {
      name: "Casa Verde",
      details: { legalName: "Casa Verde SRL", taxId: "ro 439 908 58", address: "Str. Lungă 1", city: "Reghin", county: "Mureș", country: "România", billingEmail: "Facturi@CasaVerde.test" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.company.name, "Casa Verde");
    assert.equal(saved.json.details.taxId, "RO43990858");
    assert.equal(saved.json.details.billingEmail, "facturi@casaverde.test");
    assert.equal(saved.json.details.registryNo, null);
    const memberView = (await client.call(member.token, "GET", `/v1/companies/${acme}/overview`)).json;
    assert.equal(memberView.company.name, "Casa Verde");
    assert.equal(memberView.company.details.city, "Reghin");
    const audit = (await client.call(owner.token, "GET", `/v1/companies/${acme}/audit`)).json.entries;
    assert.ok(audit.some((entry: any) => entry.action === "company.profile" && /renamed from "Acme" to "Casa Verde"/.test(entry.detail)));
  });

  it("each person reads only their own account audit", async () => {
    team.audit(hub.db, { companyId: null, actorUserId: member.userId, action: "passkey.add", detail: "Passkey added: Laptop" });
    const mine = (await client.call(member.token, "GET", "/v1/me/audit")).json.entries;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].action, "passkey.add");
    assert.deepEqual((await client.call(outsider.token, "GET", "/v1/me/audit")).json.entries, []);
  });
});
