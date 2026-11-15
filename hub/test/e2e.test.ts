// v4: end-to-end comments and titles (the hub keeps ciphertext and routing only), first-device
// approval alerts asked for by runners, and the attachment relay for "Continue on my side".
import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

import { fingerprintOf } from "../src/signing.ts";
import { type Hub, makeClient, newDevice, type Person, startHub, tick } from "./harness.ts";

// The app's sealing (hubCrypto.ts): X25519 with an ephemeral key, HKDF-SHA256, AES-256-GCM.
const E2E_INFO = "zen-hub-e2e-v1";
const context = (op: string, shareId: string, nonce: string) => `${E2E_INFO}|request|${op}|${shareId}|${nonce}`;
const x25519 = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
function sealTo(recipient: string, plaintext: string, aad: string): string {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519(recipient) });
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.concat([ephemeralPublic, Buffer.from(recipient, "base64url")]), E2E_INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([ephemeralPublic, iv, cipher.getAuthTag(), body]).toString("base64url");
}
function openWith(privateKey: KeyObject, publicKey: string, sealed: string, aad: string): string {
  const raw = Buffer.from(sealed, "base64url");
  const ephemeralPublic = raw.subarray(0, 32);
  const secret = diffieHellman({ privateKey, publicKey: x25519(ephemeralPublic.toString("base64url")) });
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.concat([ephemeralPublic, Buffer.from(publicKey, "base64url")]), E2E_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(32, 44));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(44, 60));
  return Buffer.concat([decipher.update(raw.subarray(60)), decipher.final()]).toString("utf8");
}

/** Every text value in every table of the hub's database. */
function everyStoredText(hub: Hub): string {
  const tables = hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables
    .flatMap(({ name }) => hub.db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>)
    .flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string"))
    .join("\n");
}

/** A runner that answers `thread.meta` by opening the sealed comments with its own key. */
async function connectOpeningRunner(hub: Hub, credential: string, box: { privateKey: KeyObject; publicKey: string }) {
  const asked: Array<any> = [];
  const socket = new WebSocket(`${hub.base.replace("http", "ws")}/v1/runner`);
  await new Promise((resolve) => socket.on("open", resolve));
  socket.send(JSON.stringify({ t: "hello", credential }));
  await new Promise((resolve) => socket.once("message", resolve));
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.t !== "req") return;
    asked.push(frame);
    const result =
      frame.op === "thread.meta"
        ? {
            comments: (frame.comments as Array<any>).map((comment) =>
              comment.legacy !== undefined
                ? { id: comment.id, body: comment.legacy.body, legacy: true }
                : {
                    id: comment.id,
                    body: JSON.parse(openWith(box.privateKey, box.publicKey, comment.sealed, context("comment", frame.shareId, comment.sig.nonce))).body,
                    signedBy: comment.device?.keyId ?? null,
                  },
            ),
          }
        : { op: frame.op };
    socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, result }));
  });
  return { asked, close: () => socket.close() };
}

describe("v4: end-to-end comments and titles, routing-only notifications", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let outsider: Person;
  let acme = "";
  let envId = "";
  let credential = "";
  let shareId = "";
  const runnerBox = generateKeyPairSync("x25519");
  const runnerBoxPublic = runnerBox.publicKey.export({ format: "jwk" }).x!;
  let runner: Awaited<ReturnType<typeof connectOpeningRunner>>;
  const TITLE = "Secret pricing plan for Q3";
  const COMMENT = "Top secret comment: raise prices by 40%";

  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
    owner = await client.signIn("owner@acme.test");
    admin = await client.signIn("admin@acme.test");
    member = await client.signIn("member@acme.test");
    outsider = await client.signIn("boss@other.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Acme" })).json.id;
    await client.enableTotp(owner);
    for (const [person, role] of [
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role });
      assert.equal((await client.call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    }
    await client.enableTotp(admin);
    const registered = await client.call(owner.token, "POST", "/v1/environments", { name: "Office server" });
    envId = registered.json.environmentId;
    credential = registered.json.credential;
    const runnerSign = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    assert.equal((await client.call(owner.token, "PUT", `/v1/environments/${envId}/keys`, { signPublicKey: runnerSign, boxPublicKey: runnerBoxPublic })).status, 200);
    runner = await connectOpeningRunner(hub, credential, { privateKey: runnerBox.privateKey, publicKey: runnerBoxPublic });
  });
  after(async () => {
    runner.close();
    await hub.close();
  });

  it("keeps no plaintext title: an old app's title is dropped, the sealed one is stored", async () => {
    const shared = await client.call(owner.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId: acme,
      threadId: "thread-secret",
      kind: "personal",
      audienceUserId: null,
      title: TITLE,
      titleSealed: sealTo(runnerBoxPublic, TITLE, `${E2E_INFO}|request|share.title|${envId}|thread-secret`),
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.json));
    shareId = shared.json.id;
    assert.equal(shared.json.title, "");
    assert.equal(shared.json.titleSealed, true);
    const listed = await client.call(member.token, "GET", "/v1/shares");
    assert.equal(listed.json.shares[0].title, "");
  });

  it("stores a sealed, signed comment; the runner opens it, the hub cannot", async () => {
    const nonce = randomBytes(16).toString("base64url");
    const input = { sealed: sealTo(runnerBoxPublic, JSON.stringify({ body: COMMENT, messageId: "m1" }), context("comment", shareId, nonce)) };
    const sig = client.signRequest(member, "comment.add", shareId, input, { nonce });
    const posted = await client.call(member.token, "POST", `/v1/shares/${shareId}/comments`, { input, sig });
    assert.equal(posted.status, 200, JSON.stringify(posted.json));
    // A forged signature (another device's key) is refused.
    const forged = { ...client.signRequest(member, "comment.add", shareId, input), keyId: newDevice().keyId };
    assert.equal((await client.call(member.token, "POST", `/v1/shares/${shareId}/comments`, { input, sig: forged })).status, 403);
    // Extra plaintext fields next to the ciphertext are refused too.
    const leaky = { ...input, body: COMMENT };
    assert.equal(
      (await client.call(member.token, "POST", `/v1/shares/${shareId}/comments`, { input: leaky, sig: client.signRequest(member, "comment.add", shareId, leaky) })).status,
      400,
    );

    // The share detail only announces it; reading goes through the runner.
    const detail = await client.call(owner.token, "GET", `/v1/shares/${shareId}`);
    assert.equal(detail.json.comments.length, 1);
    assert.equal(detail.json.comments[0].body, null);
    assert.equal(detail.json.comments[0].sealed, true);

    const meta = await client.relay(owner, `/v1/shares/${shareId}/meta`, "thread.meta", shareId);
    assert.equal(meta.status, 200, JSON.stringify(meta.json));
    assert.deepEqual(meta.json.comments, [{ id: posted.json.id, body: COMMENT, signedBy: member.device.keyId }]);
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "thread.meta");
    assert.equal(frame.comments[0].device.signPublicKey, member.device.signPublicKey);
    assert.equal(typeof frame.titleSealed, "string");
    // Someone who cannot see the chat cannot read its comments either.
    assert.equal((await client.relay(outsider, `/v1/shares/${shareId}/meta`, "thread.meta", shareId)).status, 404);
  });

  it("keeps old plaintext comments readable, marked legacy", async () => {
    hub.db
      .prepare("INSERT INTO comments (id, share_id, author_user_id, message_id, body, created_at) VALUES ('cm_old', ?, ?, NULL, 'Written before v4', ?)")
      .run(shareId, member.userId, new Date().toISOString());
    const detail = await client.call(owner.token, "GET", `/v1/shares/${shareId}`);
    const legacy = detail.json.comments.find((comment: any) => comment.id === "cm_old");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.body, "Written before v4");
    const meta = await client.relay(owner, `/v1/shares/${shareId}/meta`, "thread.meta", shareId);
    assert.deepEqual(meta.json.comments.at(-1), { id: "cm_old", body: "Written before v4", legacy: true });
    hub.db.prepare("DELETE FROM comments WHERE id = 'cm_old'").run();
  });

  it("notifications and e-mails carry who, which share and which kind, never a title or a comment", async () => {
    const notes = await client.call(owner.token, "GET", "/v1/notifications");
    const comment = notes.json.notifications.find((item: any) => item.kind === "comment");
    assert.equal(comment.shareId, shareId);
    assert.equal(comment.actorName, "member");
    const shared = (await client.call(member.token, "GET", "/v1/notifications")).json.notifications.find((item: any) => item.kind === "share");
    assert.equal(shared.actorName, "owner");
    for (const email of ["owner@acme.test", "member@acme.test", "admin@acme.test"]) {
      for (const mail of hub.mailer.outbox!.get(email) ?? []) {
        assert.doesNotMatch(`${mail.subject}\n${mail.text}`, /Secret pricing|Top secret|40%/);
      }
    }
  });

  it("the hub database never contains the plaintext title or comment", () => {
    const stored = everyStoredText(hub);
    assert.equal(stored.includes(TITLE), false);
    assert.equal(stored.includes(COMMENT), false);
    assert.equal(stored.includes("raise prices"), false);
  });

  it("relays one attachment for a copy, only to people who may copy", async () => {
    const asked = await client.relay(member, `/v1/shares/${shareId}/attachment`, "thread.attachment", shareId, { sealed: "x" });
    assert.equal(asked.status, 200);
    assert.equal(runner.asked.at(-1).op, "thread.attachment");
    // The owner does not copy their own chat; an outsider sees nothing.
    assert.equal((await client.relay(owner, `/v1/shares/${shareId}/attachment`, "thread.attachment", shareId)).status, 403);
    assert.equal((await client.relay(outsider, `/v1/shares/${shareId}/attachment`, "thread.attachment", shareId)).status, 403);
  });
});

describe("v4: first-device approval alerts (asked for by the runner)", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let outsider: Person;
  let acme = "";
  let other = "";
  let credential = "";
  const alert = (body: unknown, auth: string | null = `Runner ${credential}`) =>
    fetch(`${hub.base}/v1/runner/pending-device`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth === null ? {} : { authorization: auth }) },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, json: (await response.json()) as any }));

  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
    owner = await client.signIn("owner@acme.test");
    admin = await client.signIn("admin@acme.test");
    member = await client.signIn("member@acme.test");
    outsider = await client.signIn("boss@other.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Acme" })).json.id;
    await client.enableTotp(owner);
    other = (await client.call(outsider.token, "POST", "/v1/companies", { name: "Other" })).json.id;
    for (const [person, role] of [
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role });
      assert.equal((await client.call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    }
    await client.enableTotp(admin);
    const registered = await client.call(owner.token, "POST", "/v1/environments", { name: "Office server" });
    credential = registered.json.credential;
    assert.equal((await client.call(owner.token, "PUT", `/v1/environments/${registered.json.environmentId}/runner`, { companyId: acme })).status, 200);
  });
  after(() => hub.close());

  it("is authenticated as the runner: no credential or a wrong one is refused", async () => {
    const body = { userId: member.userId, keyId: member.device.keyId, companyId: acme };
    assert.equal((await alert(body, null)).status, 401);
    assert.equal((await alert(body, "Runner zrc_wrong")).status, 401);
    assert.equal((await alert(body, `Bearer ${owner.token}`)).status, 401);
  });

  it("only for a real device of that person, and a company this runner serves", async () => {
    assert.equal((await alert({ userId: member.userId, keyId: "nope", companyId: acme })).status, 404);
    assert.equal((await alert({ userId: admin.userId, keyId: member.device.keyId, companyId: acme })).status, 404);
    assert.equal((await alert({ userId: member.userId, keyId: member.device.keyId, companyId: other })).status, 400);
  });

  it("tells the runner's owner and the company's owners and admins, with the key fingerprint", async () => {
    const sent = await alert({ userId: member.userId, keyId: member.device.keyId, companyId: acme });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.notified, 2);
    const fingerprint = fingerprintOf(member.device.signPublicKey);
    for (const person of [owner, admin]) {
      const note = (await client.call(person.token, "GET", "/v1/notifications")).json.notifications.find((item: any) => item.kind === "device");
      assert.ok(note, `${person.email} was told`);
      assert.equal(note.actorName, "member");
      assert.match(note.body, new RegExp(fingerprint));
      assert.match(client.lastMail(person.email)!.subject, /New device of member waiting for approval/);
    }
    assert.equal((await client.call(member.token, "GET", "/v1/notifications")).json.notifications.length, 0);
    // Once per runner and key: a restart does not alert again.
    assert.equal((await alert({ userId: member.userId, keyId: member.device.keyId, companyId: acme })).json.notified, 0);
  });

  it("is rate limited per runner", async () => {
    let status = 200;
    for (let index = 0; index < 25 && status !== 429; index += 1) {
      status = (await alert({ userId: member.userId, keyId: member.device.keyId, companyId: acme })).status;
    }
    assert.equal(status, 429);
    await tick();
  });
});
