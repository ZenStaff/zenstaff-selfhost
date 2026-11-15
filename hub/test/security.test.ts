// Two-factor authentication, sessions and devices, Enterprise grants, company settings, Academy,
// cross-company isolation, OAuth sign-in and rate limits, end to end over HTTP.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { OauthProvider } from "../src/oauth.ts";
import { checkIdToken } from "../src/oauth.ts";
import { connectRunner, type Hub, makeClient, type Person, startHub, tick } from "./harness.ts";

describe("two-factor, sessions, grants, isolation", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let outsider: Person;
  let acme = "";
  let other = "";
  let ownerRecovery: Array<string> = [];

  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
    owner = await client.signIn("owner@acme.test");
    admin = await client.signIn("admin@acme.test");
    member = await client.signIn("member@acme.test");
    outsider = await client.signIn("boss@other.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Acme" })).json.id;
    ownerRecovery = await client.enableTotp(owner);
    other = (await client.call(outsider.token, "POST", "/v1/companies", { name: "Other" })).json.id;
    await client.enableTotp(outsider);
    for (const [person, role] of [
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role });
      assert.equal((await client.call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    }
  });
  after(() => hub.close());

  it("an admin is held at setup until two-factor is on; a member is not", async () => {
    const held = await client.call(admin.token, "GET", "/v1/shares");
    assert.equal(held.json.code, "two_factor_setup_required");
    assert.equal((await client.call(member.token, "GET", "/v1/shares")).status, 200);
    await client.enableTotp(admin);
    assert.equal((await client.call(admin.token, "GET", "/v1/shares")).status, 200);
  });

  it("a new session must enter a code; wrong codes fail; a recovery code works once", async () => {
    const second = await client.signIn("owner@acme.test");
    const blocked = await client.call(second.token, "GET", `/v1/companies/${acme}`);
    assert.equal(blocked.json.code, "two_factor_required");
    assert.equal((await client.call(second.token, "POST", "/v1/auth/totp/verify", { code: "000000" })).status, 401);
    const used = await client.call(second.token, "POST", "/v1/auth/totp/verify", { recoveryCode: ownerRecovery[0]!.toLowerCase() });
    assert.equal(used.status, 200);
    assert.equal(used.json.recoveryCodesLeft, 9);
    assert.equal((await client.call(second.token, "GET", `/v1/companies/${acme}`)).status, 200);
    assert.match(client.lastMail("owner@acme.test")!.subject, /recovery code was used/);
    const third = await client.signIn("owner@acme.test");
    assert.equal((await client.call(third.token, "POST", "/v1/auth/totp/verify", { recoveryCode: ownerRecovery[0] })).status, 401);
    // A current TOTP code (a step not used before) works.
    const viaCode = await client.call(third.token, "POST", "/v1/auth/totp/verify", { code: client.totpCode(owner) });
    assert.equal(viaCode.status, 200);
  });

  it("the same TOTP code cannot be used twice", async () => {
    // (Each person gets about two codes per 30 s here, since used steps never come back.)
    const fourth = await client.signIn("admin@acme.test");
    const fifth = await client.signIn("admin@acme.test");
    const code = client.totpCode(admin);
    assert.equal((await client.call(fourth.token, "POST", "/v1/auth/totp/verify", { code })).status, 200);
    assert.equal((await client.call(fifth.token, "POST", "/v1/auth/totp/verify", { code })).status, 401);
  });

  it("guessing codes is rate limited per person", async () => {
    const guesser = await client.signIn("admin@acme.test");
    const statuses: Array<number> = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await client.call(guesser.token, "POST", "/v1/auth/totp/verify", { code: String(100000 + attempt) })).status);
    }
    assert.deepEqual(statuses.slice(-2), [429, 429]);
  });

  it("owners cannot switch two-factor off; members can, with a code", async () => {
    assert.equal((await client.call(owner.token, "POST", "/v1/auth/totp/disable", { code: "123456" })).status, 403);
    await client.enableTotp(member);
    assert.equal((await client.call(member.token, "POST", "/v1/auth/totp/disable", { code: "000000" })).status, 401);
    assert.equal((await client.call(member.token, "POST", "/v1/auth/totp/disable", { code: client.totpCode(member) })).status, 200);
    assert.equal((await client.call(member.token, "GET", "/v1/auth/totp")).json.enabled, false);
  });

  it("lists sessions and revokes one; its token and device key stop working, runners are told", async () => {
    const registered = await client.call(owner.token, "POST", "/v1/environments", { name: "Office server" });
    const runner = await connectRunner(hub, registered.json.credential);
    const laptop = await client.signIn("member@acme.test");
    const sessions = await client.call(member.token, "GET", "/v1/me/sessions");
    const target = sessions.json.sessions.find((item: any) => item.deviceKeyId === laptop.device.keyId);
    assert.ok(target);
    assert.equal(sessions.json.sessions.filter((item: any) => item.current).length, 1);
    assert.equal((await client.call(member.token, "DELETE", `/v1/me/sessions/${target.id}`)).status, 200);
    assert.equal((await client.call(laptop.token, "GET", "/v1/me")).status, 401);
    await tick();
    assert.deepEqual(runner.notices.at(-1), { t: "notice", kind: "device.revoked", userId: member.userId, keyIds: [laptop.device.keyId] });
    const devices = await client.call(member.token, "GET", "/v1/me/devices");
    assert.equal(devices.json.devices.find((item: any) => item.keyId === laptop.device.keyId).revoked, true);
    // Someone else's session id does nothing.
    const ownerSessions = await client.call(owner.token, "GET", "/v1/me/sessions");
    assert.equal((await client.call(member.token, "DELETE", `/v1/me/sessions/${ownerSessions.json.sessions[0].id}`)).status, 404);
    runner.close();
  });

  it("a second device is approved by a signature from the first; the hub refuses a bad one", async () => {
    const phone = await client.signIn("member@acme.test");
    assert.match(client.lastMail("member@acme.test")!.subject, /New device signed in/);
    const bad = await client.call(member.token, "POST", `/v1/me/devices/${phone.device.keyId}/certify`, { signature: "AAAA" });
    assert.equal(bad.status, 400);
    const signature = client.certify(member, phone);
    assert.equal((await client.call(member.token, "POST", `/v1/me/devices/${phone.device.keyId}/certify`, { signature })).status, 200);
    const devices = await client.call(member.token, "GET", "/v1/me/devices");
    assert.deepEqual(devices.json.devices.find((item: any) => item.keyId === phone.device.keyId).certifiedBy, [member.device.keyId]);
    // Another person's device cannot be approved.
    assert.equal((await client.call(member.token, "POST", `/v1/me/devices/${owner.device.keyId}/certify`, { signature })).status, 404);
  });

  it("after signing out, the same machine's old key vouches for its new one", async () => {
    const before = await client.signIn("member@acme.test");
    assert.equal((await client.call(before.token, "POST", "/v1/auth/logout")).status, 200);
    assert.equal((await client.call(before.token, "GET", "/v1/me")).status, 401);
    const after = await client.signIn("member@acme.test");
    const signature = client.certify(before, after);
    const certified = await client.call(after.token, "POST", `/v1/me/devices/${after.device.keyId}/certify`, { signature, signerKeyId: before.device.keyId });
    assert.equal(certified.status, 200);
    // A signed-out key is not revoked; a revoked one cannot vouch.
    const sessions = await client.call(member.token, "GET", "/v1/me/sessions");
    const target = sessions.json.sessions.find((item: any) => item.deviceKeyId === after.device.keyId);
    await client.call(member.token, "DELETE", `/v1/me/sessions/${target.id}`);
    const third = await client.signIn("member@acme.test");
    const refused = await client.call(third.token, "POST", `/v1/me/devices/${third.device.keyId}/certify`, { signature: client.certify(after, third), signerKeyId: after.device.keyId });
    assert.equal(refused.status, 400);
  });

  it("Enterprise grants: signed by an admin's device, visible to the person, refused for members", async () => {
    const ts = Date.now();
    const statement = { action: "grant", companyId: acme, packId: "meta-ads-report", kind: "use", userId: member.userId, userEmail: "member@acme.test", grantedBy: admin.userId, ts };
    const unsigned = await client.call(admin.token, "POST", `/v1/companies/${acme}/grants`, { packId: "meta-ads-report", kind: "use", userId: member.userId, ts, signature: "x" });
    assert.equal(unsigned.status, 400);
    const granted = await client.call(admin.token, "POST", `/v1/companies/${acme}/grants`, {
      packId: "meta-ads-report",
      kind: "use",
      userId: member.userId,
      ts,
      signature: client.signStatement(admin, statement),
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    // The owner and the person are told by e-mail.
    assert.match(client.lastMail("owner@acme.test")!.subject, /unlocked for the Enterprise pack meta-ads-report/);
    assert.match(client.lastMail("member@acme.test")!.subject, /unlocked for the Enterprise pack/);
    const asMember = await client.call(member.token, "GET", `/v1/companies/${acme}/grants`);
    assert.equal(asMember.json.grants.length, 1);
    assert.equal(asMember.json.grants[0].signerPublicKey, admin.device.signPublicKey);
    assert.equal(JSON.parse(asMember.json.grants[0].statement).userEmail, "member@acme.test");
    const memberTs = Date.now();
    const byMember = await client.call(member.token, "POST", `/v1/companies/${acme}/grants`, {
      packId: "meta-ads-report",
      kind: "install",
      ts: memberTs,
      signature: client.signStatement(member, { action: "grant", companyId: acme, packId: "meta-ads-report", kind: "install", userId: null, userEmail: null, grantedBy: member.userId, ts: memberTs }),
    });
    assert.equal(byMember.status, 403);
    const audit = await client.call(owner.token, "GET", `/v1/companies/${acme}/audit`);
    assert.ok(audit.json.entries.some((entry: any) => entry.action === "grant.use"));
    assert.equal((await client.call(member.token, "GET", `/v1/companies/${acme}/audit`)).status, 403);
    const revoke = await client.call(owner.token, "DELETE", `/v1/companies/${acme}/grants/${granted.json.id}`);
    assert.equal(revoke.status, 200);
    assert.equal((await client.call(member.token, "GET", `/v1/companies/${acme}/grants`)).json.grants.length, 0);
  });

  it("cross-company: another company's owner sees and changes nothing here", async () => {
    for (const path of ["", "/grants", "/settings", "/audit", "/academy/progress", "/academy/signals"]) {
      assert.equal((await client.call(outsider.token, "GET", `/v1/companies/${acme}${path}`)).status, 404, path);
    }
    const ts = Date.now();
    const statement = { action: "grant", companyId: acme, packId: "x", kind: "install", userId: null, userEmail: null, grantedBy: outsider.userId, ts };
    assert.equal(
      (await client.call(outsider.token, "POST", `/v1/companies/${acme}/grants`, { packId: "x", kind: "install", ts, signature: client.signStatement(outsider, statement) })).status,
      404,
    );
    assert.equal((await client.call(outsider.token, "PUT", `/v1/companies/${acme}/settings`, { memory: { url: "https://evil.test" } })).status, 404);
    assert.equal((await client.call(outsider.token, "PUT", `/v1/companies/${acme}/academy/progress`, { lessonId: "x", done: true })).status, 404);
    // And a grant for someone outside the company is refused.
    const grantOutsider = { action: "grant", companyId: acme, packId: "x", kind: "use", userId: outsider.userId, userEmail: "boss@other.test", grantedBy: owner.userId, ts };
    assert.equal(
      (await client.call(owner.token, "POST", `/v1/companies/${acme}/grants`, { packId: "x", kind: "use", userId: outsider.userId, ts, signature: client.signStatement(owner, grantOutsider) })).status,
      404,
    );
    assert.equal((await client.call(owner.token, "GET", `/v1/companies/${other}`)).status, 404);
  });

  it("company memory settings: admins set the address (never a key), members read it", async () => {
    assert.equal((await client.call(member.token, "PUT", `/v1/companies/${acme}/settings`, { memory: { url: "https://m.test" } })).status, 403);
    assert.equal((await client.call(admin.token, "PUT", `/v1/companies/${acme}/settings`, { memory: { url: "http://evil.test" } })).status, 400);
    assert.equal((await client.call(admin.token, "PUT", `/v1/companies/${acme}/settings`, { memory: { url: "https://m.test", apiKey: "zm_x" } })).status, 400);
    const saved = await client.call(admin.token, "PUT", `/v1/companies/${acme}/settings`, { memory: { url: "https://memory.acme.test/", saveConversations: true } });
    assert.deepEqual(saved.json.memory, { url: "https://memory.acme.test", saveConversations: true });
    const read = await client.call(member.token, "GET", `/v1/companies/${acme}/settings`);
    assert.deepEqual(read.json.memory, { url: "https://memory.acme.test", saveConversations: true });
  });

  it("edition and language follow the person", async () => {
    assert.deepEqual((await client.call(member.token, "GET", "/v1/me/preferences")).json, { edition: null, language: null, notifyEmail: true });
    const saved = await client.call(member.token, "PUT", "/v1/me/preferences", { edition: "office", language: "ro" });
    assert.deepEqual(saved.json, { edition: "office", language: "ro", notifyEmail: true });
    assert.equal((await client.call(member.token, "PUT", "/v1/me/preferences", { language: "de" })).status, 400);
    const laptop = await client.signIn("member@acme.test");
    assert.equal((await client.call(laptop.token, "GET", "/v1/me")).json.preferences.language, "ro");
  });

  it("Academy: each person reports lessons; admins see the team, members only themselves", async () => {
    await client.call(member.token, "PUT", `/v1/companies/${acme}/academy/progress`, { lessonId: "data-safety", done: true });
    await client.call(admin.token, "PUT", `/v1/companies/${acme}/academy/progress`, { lessonId: "first-steps", done: true });
    assert.equal((await client.call(member.token, "PUT", `/v1/companies/${acme}/academy/progress`, { lessonId: "../x", done: true })).status, 400);
    const mine = await client.call(member.token, "GET", `/v1/companies/${acme}/academy/progress`);
    assert.equal(mine.json.team, false);
    assert.deepEqual(mine.json.progress.map((row: any) => row.lessonId), ["data-safety"]);
    const all = await client.call(admin.token, "GET", `/v1/companies/${acme}/academy/progress`);
    assert.equal(all.json.progress.length, 2);
    await client.call(member.token, "PUT", `/v1/companies/${acme}/academy/signals`, { topics: { invoices: 3, "bad topic!": 2 }, searches: ["facturi"] });
    await client.call(admin.token, "PUT", `/v1/companies/${acme}/academy/signals`, { topics: { invoices: 2 }, searches: [] });
    const totals = await client.call(admin.token, "GET", `/v1/companies/${acme}/academy/signals`);
    assert.deepEqual(totals.json, { people: 2, topics: { invoices: 5 }, searches: { facturi: 1 } });
    assert.equal((await client.call(member.token, "GET", `/v1/companies/${acme}/academy/signals`)).status, 403);
  });

  it("a company runner declares its AI account as metadata; keys are refused", async () => {
    const registered = await client.call(owner.token, "POST", "/v1/environments", { name: "Runner" });
    const envId = registered.json.environmentId;
    const account = { provider: "claude", mode: "seat", label: "Claude Team seat (ops@acme.test)" };
    assert.equal((await client.call(owner.token, "PUT", `/v1/environments/${envId}/ai-account`, { account })).status, 403, "not a runner yet");
    await client.call(owner.token, "PUT", `/v1/environments/${envId}/runner`, { companyId: acme });
    const set = await client.call(owner.token, "PUT", `/v1/environments/${envId}/ai-account`, { account });
    assert.equal(set.status, 200);
    assert.equal((await client.call(owner.token, "PUT", `/v1/environments/${envId}/ai-account`, { account: { ...account, label: "sk-ant-api03-abcdefghijkl" } })).status, 400);
    assert.equal((await client.call(admin.token, "PUT", `/v1/environments/${envId}/ai-account`, { account })).status, 404, "not their machine");
    const company = await client.call(member.token, "GET", `/v1/companies/${acme}`);
    const runner = company.json.runners.find((item: any) => item.id === envId);
    assert.equal(runner.aiAccount.label, "Claude Team seat (ops@acme.test)");
    assert.equal(runner.aiAccount.mode, "seat");
    assert.match(client.lastMail("admin@acme.test")!.subject, /now uses Claude Team seat/);
  });

  it("role changes are e-mailed to the managers and the person", async () => {
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}/members/${member.userId}`, { role: "guest" })).status, 200);
    assert.match(client.lastMail("member@acme.test")!.subject, /is now guest \(was member\)/);
    assert.match(client.lastMail("admin@acme.test")!.subject, /is now guest/);
  });
});

describe("rate limits on mutating routes", () => {
  it("answers 429 with Retry-After once a person goes over the limit", async () => {
    const hub = await startHub({ config: { writeLimitPerMinute: 8 } });
    const client = makeClient(hub);
    const person = await client.signIn("busy@acme.test");
    const statuses: Array<number> = [];
    for (let index = 0; index < 10; index += 1) {
      statuses.push((await client.call(person.token, "PATCH", "/v1/me", { name: `Busy ${index}` })).status);
    }
    assert.ok(statuses.includes(429));
    const limited = await client.call(person.token, "PATCH", "/v1/me", { name: "x" });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    // Reads are not limited.
    assert.equal((await client.call(person.token, "GET", "/v1/me")).status, 200);
    await hub.close();
  });
});

describe("strict transport security", () => {
  it("is sent only when the public address is https", async () => {
    const secure = await startHub({ config: { publicUrl: "https://hub.test" } });
    assert.equal((await fetch(`${secure.base}/health`)).headers.get("strict-transport-security"), "max-age=31536000");
    await secure.close();
    const plain = await startHub();
    assert.equal((await fetch(`${plain.base}/health`)).headers.get("strict-transport-security"), null);
    await plain.close();
  });
});

describe("client address behind a proxy", () => {
  const start = (hub: Hub, ip: string | null) =>
    fetch(`${hub.base}/v1/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ip === null ? {} : { "cf-connecting-ip": ip }) },
      body: JSON.stringify({ email: `p${Math.random().toString(36).slice(2)}@acme.test` }),
    }).then((response) => response.status);

  it("counts sign-in limits per forwarded address when HUB_CLIENT_IP_HEADER is set", async () => {
    const hub = await startHub({ config: { loginLimitPer10Minutes: 2, clientIpHeader: "cf-connecting-ip" } });
    assert.deepEqual([await start(hub, "203.0.113.1"), await start(hub, "203.0.113.1"), await start(hub, "203.0.113.1")], [200, 200, 429]);
    // Another visitor behind the same proxy is not limited by the first one.
    assert.equal(await start(hub, "203.0.113.2"), 200);
    // A value that is not an address falls back to the TCP peer.
    assert.equal(await start(hub, "not-an-ip"), 200);
    await hub.close();
  });

  it("ignores the header when it is not configured", async () => {
    const hub = await startHub({ config: { loginLimitPer10Minutes: 2 } });
    assert.deepEqual([await start(hub, "203.0.113.1"), await start(hub, "203.0.113.2"), await start(hub, "203.0.113.3")], [200, 200, 429]);
    await hub.close();
  });
});

describe("sign in with Google / Microsoft", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let tokenServer: ReturnType<typeof createServer>;
  let claimsFor: (body: URLSearchParams) => Record<string, unknown> = () => ({});
  let provider: OauthProvider;

  const jwt = (claims: Record<string, unknown>) =>
    `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  before(async () => {
    tokenServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = new URLSearchParams(raw);
        if (body.get("code") !== "good-code" || body.get("client_secret") !== "secret") {
          res.writeHead(400).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: jwt(claimsFor(body)) }));
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const port = (tokenServer.address() as AddressInfo).port;
    provider = {
      id: "google",
      name: "Google",
      authorizeUrl: "https://accounts.example/auth",
      tokenUrl: `http://127.0.0.1:${port}/token`,
      clientId: "client-1",
      clientSecret: "secret",
      issuerOk: (issuer) => issuer === "https://accounts.example",
      emailFrom: (claims) =>
        typeof claims.email === "string" && claims.email_verified === true ? { email: claims.email } : { error: "not verified" },
    };
    hub = await startHub({ oauth: [provider] });
    client = makeClient(hub);
  });
  after(async () => {
    await hub.close();
    tokenServer.close();
  });

  const start = async () => {
    const started = await client.call(null, "POST", "/v1/auth/oauth/start", { provider: "google" });
    assert.equal(started.status, 200);
    const url = new URL(started.json.url);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://hub.test/v1/auth/oauth/callback");
    return { ...started.json, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
  };

  it("lists the configured providers", async () => {
    assert.deepEqual((await client.call(null, "GET", "/v1/auth/providers")).json, { providers: [{ id: "google", name: "Google" }], passkeys: true });
    assert.equal((await client.call(null, "POST", "/v1/auth/oauth/start", { provider: "microsoft" })).status, 404);
  });

  it("completes a sign-in: callback approves, the app collects the session by polling", async () => {
    const flow = await start();
    claimsFor = () => ({ iss: "https://accounts.example", aud: "client-1", exp: Date.now() / 1000 + 600, nonce: flow.nonce, email: "Ana@Acme.test", email_verified: true });
    assert.equal((await client.call(null, "POST", "/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);
    const page = await fetch(`${hub.base}/v1/auth/oauth/callback?code=good-code&state=${encodeURIComponent(flow.state)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in/);
    const polled = await client.call(null, "POST", "/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret });
    assert.equal(polled.json.pending, false);
    assert.equal(polled.json.user.email, "ana@acme.test");
    const sessions = await client.call(polled.json.token, "GET", "/v1/me/sessions");
    assert.equal(sessions.json.sessions[0].method, "google");
    // The state works once.
    assert.equal((await fetch(`${hub.base}/v1/auth/oauth/callback?code=good-code&state=${encodeURIComponent(flow.state)}`)).status, 400);
  });

  it("refuses a wrong nonce, an unverified e-mail and a bad code", async () => {
    const wrongNonce = await start();
    claimsFor = () => ({ iss: "https://accounts.example", aud: "client-1", exp: Date.now() / 1000 + 600, nonce: "other", email: "a@b.test", email_verified: true });
    assert.equal((await fetch(`${hub.base}/v1/auth/oauth/callback?code=good-code&state=${encodeURIComponent(wrongNonce.state)}`)).status, 400);
    const unverified = await start();
    claimsFor = () => ({ iss: "https://accounts.example", aud: "client-1", exp: Date.now() / 1000 + 600, nonce: unverified.nonce, email: "a@b.test", email_verified: false });
    assert.equal((await fetch(`${hub.base}/v1/auth/oauth/callback?code=good-code&state=${encodeURIComponent(unverified.state)}`)).status, 400);
    const badCode = await start();
    assert.equal((await fetch(`${hub.base}/v1/auth/oauth/callback?code=nope&state=${encodeURIComponent(badCode.state)}`)).status, 502);
    for (const flow of [wrongNonce, unverified, badCode]) {
      assert.equal((await client.call(null, "POST", "/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);
    }
  });

  it("checks issuer, audience and expiry", () => {
    const base = { iss: "https://accounts.example", aud: "client-1", exp: Date.now() / 1000 + 60, nonce: "n", email: "a@b.test", email_verified: true };
    assert.deepEqual(checkIdToken(provider, base, "n"), { email: "a@b.test" });
    assert.ok("error" in checkIdToken(provider, { ...base, iss: "https://evil" }, "n"));
    assert.ok("error" in checkIdToken(provider, { ...base, aud: "other" }, "n"));
    assert.ok("error" in checkIdToken(provider, { ...base, exp: Date.now() / 1000 - 3600 }, "n"));
  });
});
