// Passkeys end to end over HTTP, with a software authenticator (test/authenticator.ts): real
// registration and authentication ceremonies, replays, wrong origin / RP ID, counter regression,
// removed passkeys, the sign-in poll and the two-factor rule.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { BROWSER_LIB_INTEGRITY, BROWSER_LIB_PATH, BROWSER_LIB_VERSION, PAGE_SCRIPT_PATH, webauthnConfig } from "../src/webauthn.ts";
import { createCredential, getAssertion, type SoftPasskey } from "./authenticator.ts";
import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

const ORIGIN = "http://hub.test";

describe("passkeys", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let member: Person;
  let owner: Person;
  let memberKey: SoftPasskey;
  let acme = "";

  const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;
  const post = (path: string, body: unknown) => client.call(null, "POST", path, body);

  /** Asks the hub for a registration link and its options. */
  const registration = async (person: Person, label = "Laptop") => {
    const started = await client.call(person.token, "POST", "/v1/me/passkeys/register", { label, lang: "en" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const t = tokenOf(started.json.url);
    const options = await post("/v1/passkeys/register/options", { t });
    assert.equal(options.status, 200, JSON.stringify(options.json));
    return { t, options: options.json.options };
  };

  const addPasskey = async (person: Person, label = "Laptop") => {
    const { t, options } = await registration(person, label);
    const { passkey, response } = createCredential(options, { origin: ORIGIN });
    const finished = await post("/v1/passkeys/register/finish", { t, response });
    assert.equal(finished.status, 200, JSON.stringify(finished.json));
    return passkey;
  };

  const login = async () => {
    const started = await post("/v1/auth/passkey/start", { lang: "ro" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const t = tokenOf(started.json.url);
    const options = await post("/v1/passkeys/login/options", { t });
    assert.equal(options.status, 200, JSON.stringify(options.json));
    return { ...started.json, t, options: options.json.options };
  };

  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
    member = await client.signIn("ana@acme.test");
    owner = await client.signIn("boss@acme.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Acme" })).json.id;
    await client.enableTotp(owner);
  });
  after(() => hub.close());

  it("serves the vendored browser library with its pinned version and integrity", async () => {
    const vendored = readFileSync(new URL(`../src/assets/simplewebauthn-browser-${BROWSER_LIB_VERSION}.umd.min.js`, import.meta.url));
    const packaged = readFileSync(new URL("../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", import.meta.url));
    assert.ok(vendored.equals(packaged), "src/assets copy must equal the pinned npm package");
    assert.match(vendored.toString("utf8", 0, 60), new RegExp(`@simplewebauthn/browser@${BROWSER_LIB_VERSION.replaceAll(".", "\\.")}`));
    const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).devDependencies["@simplewebauthn/browser"];
    assert.equal(pinned, BROWSER_LIB_VERSION);
    const served = Buffer.from(await (await fetch(`${hub.base}${BROWSER_LIB_PATH}`)).arrayBuffer());
    assert.equal(`sha384-${createHash("sha384").update(served).digest("base64")}`, BROWSER_LIB_INTEGRITY);
    const page = await fetch(`${hub.base}${PAGE_SCRIPT_PATH}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /javascript/);
  });

  it("derives the relying party from the public address, with overrides", () => {
    assert.deepEqual(webauthnConfig({}, "https://hub.zenstaff.ai"), { rpId: "hub.zenstaff.ai", rpName: "Zen Staff", origin: "https://hub.zenstaff.ai" });
    assert.deepEqual(
      webauthnConfig({ HUB_WEBAUTHN_RP_ID: "zenstaff.ai", HUB_WEBAUTHN_RP_NAME: "Acme Staff", HUB_WEBAUTHN_ORIGIN: "https://login.zenstaff.ai/" }, "https://hub.zenstaff.ai"),
      { rpId: "zenstaff.ai", rpName: "Acme Staff", origin: "https://login.zenstaff.ai" },
    );
  });

  it("adds a passkey from a signed-in session; the link works once and the person is told", async () => {
    const started = await client.call(member.token, "POST", "/v1/me/passkeys/register", { label: "Laptop", lang: "ro" });
    assert.equal(started.status, 200);
    assert.ok(started.json.url.startsWith(`${ORIGIN}/v1/passkeys/register?t=`));
    const t = tokenOf(started.json.url);
    const page = await fetch(`${hub.base}/v1/passkeys/register?t=${encodeURIComponent(t)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Adaugă o cheie de acces/);
    assert.match(html, /ana@acme\.test/);
    assert.ok(html.includes(`integrity="${BROWSER_LIB_INTEGRITY}"`));
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);

    const options = (await post("/v1/passkeys/register/options", { t })).json.options;
    assert.equal(options.rp.id, "hub.test");
    assert.equal(options.rp.name, "Zen Staff");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    assert.equal(options.authenticatorSelection.residentKey, "required");
    const { passkey, response } = createCredential(options, { origin: ORIGIN });
    const finished = await post("/v1/passkeys/register/finish", { t, response });
    assert.equal(finished.status, 200, JSON.stringify(finished.json));
    memberKey = passkey;
    assert.match(client.lastMail("ana@acme.test")!.subject, /passkey was added/);

    // Replaying the same response, or opening the page again, is refused.
    const replay = await post("/v1/passkeys/register/finish", { t, response });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.code, "passkey_expired");
    assert.equal((await fetch(`${hub.base}/v1/passkeys/register?t=${encodeURIComponent(t)}`)).status, 400);

    const listed = await client.call(member.token, "GET", "/v1/me/passkeys");
    assert.equal(listed.json.passkeys.length, 1);
    assert.equal(listed.json.passkeys[0].label, "Laptop");
    assert.deepEqual(listed.json.passkeys[0].transports, ["internal", "hybrid"]);
    assert.equal(listed.json.passkeys[0].lastUsedAt, null);
    // The next registration excludes it, so the same authenticator is not added twice.
    const next = await registration(member);
    assert.deepEqual(next.options.excludeCredentials.map((item: { id: string }) => item.id), [response.id]);
  });

  it("refuses a wrong origin, a wrong RP ID, no user verification and an old challenge", async () => {
    const cases: Array<Parameters<typeof createCredential>[1]> = [
      { origin: "http://evil.test" },
      { origin: ORIGIN, rpId: "evil.test" },
      { origin: ORIGIN, userVerified: false },
    ];
    for (const input of cases) {
      const { t, options } = await registration(member);
      const { response } = createCredential(options, input);
      const refused = await post("/v1/passkeys/register/finish", { t, response });
      assert.equal(refused.status, 400, JSON.stringify(input));
      assert.equal(refused.json.code, "passkey_refused");
    }
    // A response made for an earlier challenge (options asked again) does not finish the link.
    const { t, options } = await registration(member);
    assert.equal((await post("/v1/passkeys/register/options", { t })).status, 200);
    const stale = await post("/v1/passkeys/register/finish", { t, response: createCredential(options, { origin: ORIGIN }).response });
    assert.equal(stale.json.code, "passkey_refused");
    assert.equal((await client.call(member.token, "GET", "/v1/me/passkeys")).json.passkeys.length, 1);
  });

  it("a registration link dies with its session, and five failures use a link up", async () => {
    const other = await client.signIn("ana@acme.test");
    const { t, options } = await registration(other);
    assert.equal((await client.call(other.token, "POST", "/v1/auth/logout")).status, 200);
    assert.equal((await fetch(`${hub.base}/v1/passkeys/register?t=${encodeURIComponent(t)}`)).status, 400);
    const late = await post("/v1/passkeys/register/finish", { t, response: createCredential(options, { origin: ORIGIN }).response });
    assert.equal(late.json.code, "passkey_expired");

    const guessed = await registration(member);
    const statuses: Array<number> = [];
    for (let i = 0; i < 7; i += 1) {
      const { response } = createCredential(guessed.options, { origin: "http://evil.test" });
      statuses.push((await post("/v1/passkeys/register/finish", { t: guessed.t, response })).status);
    }
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429, 429]);
  });

  it("adding a passkey needs a two-factor session", async () => {
    const fresh = await client.signIn("boss@acme.test");
    const held = await client.call(fresh.token, "POST", "/v1/me/passkeys/register", {});
    assert.equal(held.status, 403);
    assert.equal(held.json.code, "two_factor_required");
  });

  it("signs in with a passkey: the page approves, the poll returns a two-factor session", async () => {
    const flow = await login();
    assert.equal(flow.options.rpId, "hub.test");
    assert.equal(flow.options.userVerification, "required");
    assert.deepEqual(flow.options.allowCredentials ?? [], []);
    const page = await fetch(`${hub.base}/v1/passkeys/login?t=${encodeURIComponent(flow.t)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Autentificare cu cheie de acces/);
    assert.equal((await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);

    const response = getAssertion(memberKey, flow.options, { origin: ORIGIN });
    const finished = await post("/v1/passkeys/login/finish", { t: flow.t, response });
    assert.equal(finished.status, 200, JSON.stringify(finished.json));
    assert.equal((await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: "mp_wrong" })).json.pending, true);
    const polled = await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret });
    assert.equal(polled.json.pending, false);
    assert.equal(polled.json.user.email, "ana@acme.test");
    assert.equal(polled.json.twoFactor, "ok");
    const sessions = await client.call(polled.json.token, "GET", "/v1/me/sessions");
    const current = sessions.json.sessions.find((session: { current: boolean }) => session.current);
    assert.equal(current.method, "passkey");
    assert.equal(current.twoFactor, true);
    // Collected once; the same assertion cannot be replayed on this or another sign-in.
    assert.equal((await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);
    assert.equal((await post("/v1/passkeys/login/finish", { t: flow.t, response })).json.code, "passkey_expired");
    const second = await login();
    assert.equal((await post("/v1/passkeys/login/finish", { t: second.t, response })).json.code, "passkey_refused");
    const listed = await client.call(member.token, "GET", "/v1/me/passkeys");
    assert.notEqual(listed.json.passkeys[0].lastUsedAt, null);
  });

  it("refuses a wrong origin, a wrong RP ID, no user verification, a foreign user handle and a counter going back", async () => {
    const cases: Array<Parameters<typeof getAssertion>[2]> = [
      { origin: "http://evil.test" },
      { origin: ORIGIN, rpId: "evil.test" },
      { origin: ORIGIN, userVerified: false },
      { origin: ORIGIN, userHandle: Buffer.alloc(32, 7).toString("base64url") },
    ];
    for (const input of cases) {
      const flow = await login();
      const refused = await post("/v1/passkeys/login/finish", { t: flow.t, response: getAssertion(memberKey, flow.options, input) });
      assert.equal(refused.json.code, "passkey_refused", JSON.stringify(input));
      assert.equal((await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);
    }
    const ahead = await login();
    assert.equal((await post("/v1/passkeys/login/finish", { t: ahead.t, response: getAssertion(memberKey, ahead.options, { origin: ORIGIN, counter: 50 }) })).status, 200);
    // A clone still at an older counter is refused.
    const clone = await login();
    const cloned = await post("/v1/passkeys/login/finish", { t: clone.t, response: getAssertion(memberKey, clone.options, { origin: ORIGIN, counter: 20 }) });
    assert.equal(cloned.json.code, "passkey_refused");
    assert.equal((await post("/v1/auth/poll", { requestId: clone.requestId, pollSecret: clone.pollSecret })).json.pending, true);
    // Usernameless works without a user handle too (the credential id finds the person).
    const bare = await login();
    assert.equal((await post("/v1/passkeys/login/finish", { t: bare.t, response: getAssertion(memberKey, bare.options, { origin: ORIGIN, counter: 51, userHandle: null }) })).status, 200);
  });

  it("an owner with TOTP skips the code after a passkey sign-in", async () => {
    const verified = await client.signIn("boss@acme.test");
    assert.equal((await client.call(verified.token, "POST", "/v1/auth/totp/verify", { code: client.totpCode(owner) })).status, 200);
    const ownerKey = await addPasskey(verified, "Phone");
    const flow = await login();
    assert.equal((await post("/v1/passkeys/login/finish", { t: flow.t, response: getAssertion(ownerKey, flow.options, { origin: ORIGIN }) })).status, 200);
    const polled = await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret });
    assert.equal(polled.json.twoFactor, "ok");
    assert.equal((await client.call(polled.json.token, "GET", `/v1/companies/${acme}`)).status, 200);
  });

  it("a removed passkey cannot sign in; only its owner can remove it", async () => {
    const listed = await client.call(member.token, "GET", "/v1/me/passkeys");
    const id = listed.json.passkeys[0].id;
    assert.equal((await client.call(owner.token, "DELETE", `/v1/me/passkeys/${id}`)).status, 404);
    assert.equal((await client.call(member.token, "DELETE", `/v1/me/passkeys/${id}`)).status, 200);
    assert.match(client.lastMail("ana@acme.test")!.subject, /passkey was removed/);
    assert.equal((await client.call(member.token, "GET", "/v1/me/passkeys")).json.passkeys.length, 0);
    const flow = await login();
    const refused = await post("/v1/passkeys/login/finish", { t: flow.t, response: getAssertion(memberKey, flow.options, { origin: ORIGIN }) });
    assert.equal(refused.json.code, "passkey_refused");
    assert.equal((await post("/v1/auth/poll", { requestId: flow.requestId, pollSecret: flow.pollSecret })).json.pending, true);
  });

  it("unknown links get the expired page and code", async () => {
    const page = await fetch(`${hub.base}/v1/passkeys/login?t=pkl_nope&lang=ro`);
    assert.equal(page.status, 400);
    assert.match(await page.text(), /Linkul a expirat/);
    assert.equal((await post("/v1/passkeys/login/options", { t: "pkl_nope" })).json.code, "passkey_expired");
    assert.equal((await client.call(null, "GET", "/v1/auth/providers")).json.passkeys, true);
  });
});
