// End to end through HTTP and the runner WebSocket, with a fake runner in the test.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

import { connectRunner, type Hub, makeClient, type Person, startHub, tick } from "./harness.ts";

let hub: Hub;
let client: ReturnType<typeof makeClient>;

before(async () => {
  hub = await startHub();
  client = makeClient(hub);
});
after(() => hub.close());

describe("hub API", () => {
  let alex: Person;
  let maria: Person;
  let olga: Person;
  let gina: Person;
  let companyId = "";
  let envId = "";
  let runner: Awaited<ReturnType<typeof connectRunner>>;
  const call = (...args: Parameters<typeof client.call>) => client.call(...args);

  it("signs in with an e-mailed code; a wrong code fails", async () => {
    alex = await client.signIn("alex@acme.test");
    maria = await client.signIn("maria@acme.test");
    olga = await client.signIn("olga@other.test");
    gina = await client.signIn("gina@outside.test");
    await call(null, "POST", "/v1/auth/start", { email: "x@acme.test" });
    const wrong = await call(null, "POST", "/v1/auth/verify", { email: "x@acme.test", code: "000000" });
    assert.equal(wrong.status, 401);
    assert.equal((await call(null, "GET", "/v1/me")).status, 401);
  });

  it("creates a company; its owner must set up two-factor before anything else", async () => {
    const created = await call(alex.token, "POST", "/v1/companies", { name: "Acme" });
    companyId = created.json.id;
    const blocked = await call(alex.token, "GET", `/v1/companies/${companyId}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "two_factor_setup_required");
    // The sign-in routes still work, so the app can show the setup.
    assert.equal((await call(alex.token, "GET", "/v1/me")).json.twoFactor.gate, "enroll");
    await client.enableTotp(alex);
    assert.equal((await call(alex.token, "GET", `/v1/companies/${companyId}`)).status, 200);
  });

  it("invites by e-mail and by link", async () => {
    const byEmail = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { email: "maria@acme.test", role: "member" });
    assert.equal(byEmail.status, 200);
    const me = await call(maria.token, "GET", "/v1/me");
    assert.equal(me.json.invites.length, 1);
    const stolen = await call(olga.token, "POST", "/v1/invites/accept", { token: byEmail.json.link });
    assert.equal(stolen.status, 403);
    const accepted = await call(maria.token, "POST", "/v1/invites/accept", { inviteId: me.json.invites[0].id });
    assert.equal(accepted.json.role, "member");
    const byLink = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { role: "guest" });
    assert.equal((await call(gina.token, "POST", "/v1/invites/accept", { token: byLink.json.link })).json.role, "guest");
    assert.equal((await call(maria.token, "POST", `/v1/companies/${companyId}/invites`, { role: "member" })).status, 403);
    // Admin actions are e-mailed to the owners and admins.
    assert.match(client.lastMail("alex@acme.test")!.subject, /\[Acme\] gina@outside\.test joined as guest/);
  });

  it("hides other companies entirely", async () => {
    assert.equal((await call(olga.token, "GET", `/v1/companies/${companyId}`)).status, 404);
    const members = await call(maria.token, "GET", `/v1/companies/${companyId}`);
    assert.deepEqual(members.json.members.map((member: any) => member.role), ["owner", "member", "guest"]);
    assert.equal(members.json.members[0].twoFactor, true);
  });

  it("registers Alex's machine and makes it the company runner (alerting the admins)", async () => {
    const registered = await call(alex.token, "POST", "/v1/environments", { name: "Alex laptop" });
    envId = registered.json.environmentId;
    runner = await connectRunner(hub, registered.json.credential);
    assert.equal((await call(maria.token, "PUT", `/v1/environments/${envId}/runner`, { companyId })).status, 404);
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyId })).status, 200);
    assert.match(client.lastMail("alex@acme.test")!.subject, /New company runner: "Alex laptop"/);
    const company = await call(maria.token, "GET", `/v1/companies/${companyId}`);
    assert.equal(company.json.runners[0].online, true);
  });

  it("a runner with a wrong credential is refused", async () => {
    const socket = new WebSocket(`${hub.base.replace("http", "ws")}/v1/runner`);
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ t: "hello", credential: "zrc_nope" }));
    const code = await new Promise((resolve) => socket.on("close", (closeCode) => resolve(closeCode)));
    assert.equal(code, 4004);
  });

  let personal = "";
  let company = "";

  it("personal share: Maria views and comments, cannot prompt, can copy; outsiders get nothing", async () => {
    const shared = await call(alex.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-personal",
      kind: "personal",
      audienceUserId: null,
      title: "Pricing ideas",
    });
    personal = shared.json.id;
    // Maria is told about it, in the app and by e-mail; the guest is not.
    const notes = await call(maria.token, "GET", "/v1/notifications");
    assert.equal(notes.json.unread, 1);
    // Routing only: who shared, never the chat's title.
    assert.match(client.lastMail("maria@acme.test")!.subject, /alex shared a chat$/);
    assert.doesNotMatch(client.lastMail("maria@acme.test")!.text, /Pricing ideas/);
    assert.equal((await call(gina.token, "GET", "/v1/notifications")).json.unread, 0);

    const view = await client.relay(maria, `/v1/shares/${personal}/view`, "thread.view", personal);
    assert.deepEqual(view.json, { op: "thread.view", threadId: "thread-personal" });
    // Plaintext comments are refused; a sealed one, signed by Maria's device, is kept.
    const plain = await call(maria.token, "POST", `/v1/shares/${personal}/comments`, { body: "Nice" });
    assert.equal(plain.status, 400);
    assert.match(plain.json.error, /end-to-end/);
    const sealedInput = { sealed: "c2VhbGVkLWNvbW1lbnQ" };
    const commented = await call(maria.token, "POST", `/v1/shares/${personal}/comments`, {
      input: sealedInput,
      sig: client.signRequest(maria, "comment.add", personal, sealedInput),
    });
    assert.equal(commented.status, 200, JSON.stringify(commented.json));
    assert.match(client.lastMail("alex@acme.test")!.subject, /commented on a shared chat$/);
    const prompt = await client.relay(maria, `/v1/shares/${personal}/prompt`, "thread.prompt", personal, { text: "hi" });
    assert.equal(prompt.status, 403);
    assert.match(prompt.json.error, /Continue on my side/);
    assert.equal((await client.relay(maria, `/v1/shares/${personal}/export`, "thread.export", personal)).status, 200);
    assert.equal((await client.relay(gina, `/v1/shares/${personal}/view`, "thread.view", personal)).status, 404);
    assert.equal((await client.relay(olga, `/v1/shares/${personal}/view`, "thread.view", personal)).status, 404);
    assert.equal((await call(olga.token, "POST", `/v1/shares/${personal}/comments`, { input: { sealed: "x" } })).status, 404);
    const listed = await call(maria.token, "GET", "/v1/shares");
    assert.equal(listed.json.shares[0].threadId, null);
    assert.equal(listed.json.shares[0].permissions.prompt, false);
    assert.equal(runner.asked.filter((frame) => frame.op === "thread.prompt").length, 0);
  });

  it("company share: the owner writes with a signed request; Maria (a member) follows it but cannot write", async () => {
    const shared = await call(alex.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-company",
      kind: "company",
      audienceUserId: null,
      title: "Launch plan",
    });
    company = shared.json.id;
    // Decision 08.11.2026: members do not write free chats on the company server.
    const refused = await client.relay(maria, `/v1/shares/${company}/prompt`, "thread.prompt", company, { text: "Add a timeline" });
    assert.equal(refused.status, 403);
    assert.equal((await client.relay(maria, `/v1/shares/${company}/view`, "thread.view", company)).status, 200);
    const prompt = await client.relay(alex, `/v1/shares/${company}/prompt`, "thread.prompt", company, { text: "Add a timeline" });
    assert.equal(prompt.status, 200);
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "thread.prompt");
    assert.equal(frame.threadId, "thread-company");
    assert.equal(frame.actor.email, "alex@acme.test");
    assert.equal(frame.device.keyId, alex.device.keyId);
    assert.equal(frame.device.signPublicKey, alex.device.signPublicKey);
    assert.equal(frame.actorAccess.role, "owner");
    assert.deepEqual(frame.input, { text: "Add a timeline" });
    assert.equal(typeof frame.sig.signature, "string");
    assert.equal((await client.relay(gina, `/v1/shares/${company}/prompt`, "thread.prompt", company, { text: "x" })).status, 404);
  });

  it("refuses unsigned, tampered, replayed, stale and foreign-key requests", async () => {
    const path = `/v1/shares/${company}/prompt`;
    const before = runner.asked.length;
    const unsigned = await call(alex.token, "POST", path, { input: { text: "x" } });
    assert.equal(unsigned.status, 400);
    const sig = client.signRequest(alex, "thread.prompt", company, { text: "Pay 10 lei" });
    const tampered = await call(alex.token, "POST", path, { input: { text: "Pay 10000 lei" }, sig });
    assert.equal(tampered.status, 403);
    const good = await call(alex.token, "POST", path, { input: { text: "Pay 10 lei" }, sig });
    assert.equal(good.status, 200);
    const replay = await call(alex.token, "POST", path, { input: { text: "Pay 10 lei" }, sig });
    assert.equal(replay.status, 403);
    const stale = client.signRequest(alex, "thread.prompt", company, { text: "x" }, { ts: Date.now() - 10 * 60_000 });
    assert.equal((await call(alex.token, "POST", path, { input: { text: "x" }, sig: stale })).status, 403);
    // Maria's key, used from Alex's session.
    const foreign = client.signRequest(maria, "thread.prompt", company, { text: "x" });
    assert.equal((await call(alex.token, "POST", path, { input: { text: "x" }, sig: foreign })).status, 403);
    // A signature for another op does not work here.
    const otherOp = client.signRequest(alex, "thread.view", company, { text: "x" });
    assert.equal((await call(alex.token, "POST", path, { input: { text: "x" }, sig: otherOp })).status, 403);
    assert.equal(runner.asked.length, before + 1);
  });

  it("Maria cannot share Alex's machine or hand out his thread ids", async () => {
    const attempt = await call(maria.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-secret",
      kind: "personal",
      audienceUserId: null,
    });
    assert.equal(attempt.status, 403);
  });

  it("unregistering the runner revokes company chats", async () => {
    await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyId: null });
    assert.equal((await client.relay(maria, `/v1/shares/${company}/prompt`, "thread.prompt", company, { text: "x" })).status, 404);
    await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyId });
  });

  it("hand over: only the named colleague accepts; completing ends all shares of that chat", async () => {
    const handover = await call(alex.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-personal",
      kind: "handover",
      audienceUserId: maria.userId,
      title: "Pricing ideas",
    });
    const id = handover.json.id;
    assert.match(client.lastMail("maria@acme.test")!.subject, /hand over a chat to you/);
    assert.equal((await client.relay(gina, `/v1/shares/${id}/handover/accept`, "thread.export", id)).status, 403);
    assert.equal((await client.relay(maria, `/v1/shares/${id}/handover/accept`, "thread.export", id)).status, 200);
    // Completing needs Maria's signature on the hand-over itself.
    assert.equal((await call(maria.token, "POST", `/v1/shares/${id}/handover/complete`, { input: {} })).status, 400);
    assert.equal((await client.relay(maria, `/v1/shares/${id}/handover/complete`, "thread.handedOver", id)).status, 200);
    await tick();
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "thread.handedOver");
    assert.equal(frame.device.keyId, maria.device.keyId);
    assert.equal((await client.relay(maria, `/v1/shares/${personal}/view`, "thread.view", personal)).status, 404);
    assert.equal((await client.relay(maria, `/v1/shares/${id}/handover/complete`, "thread.handedOver", id)).status, 403);
  });

  it("removing a member ends their access", async () => {
    const shared = await call(alex.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-3",
      kind: "personal",
      audienceUserId: null,
    });
    assert.equal((await call(alex.token, "DELETE", `/v1/companies/${companyId}/members/${maria.userId}`)).status, 200);
    assert.equal((await client.relay(maria, `/v1/shares/${shared.json.id}/view`, "thread.view", shared.json.id)).status, 404);
    assert.equal((await call(maria.token, "GET", `/v1/companies/${companyId}`)).status, 404);
  });

  it("an offline runner gives a clear 503", async () => {
    runner.close();
    await tick();
    const shared = await call(alex.token, "POST", "/v1/shares", {
      environmentId: envId,
      companyId,
      threadId: "thread-4",
      kind: "personal",
      audienceUserId: null,
    });
    const view = await client.relay(alex, `/v1/shares/${shared.json.id}/view`, "thread.view", shared.json.id);
    assert.equal(view.status, 503);
  });
});
