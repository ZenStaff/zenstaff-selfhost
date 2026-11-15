// Company-level objects (v6): AI staff kept on the hub only as ciphertext sealed to the company
// runners and signed by an admin or the agent's manager (last writer wins by version, every change
// in the audit log), the company runner relay, and packs installed for the whole company with each
// machine's status.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MIGRATIONS } from "../src/db.ts";
import * as policy from "../src/policy.ts";
import { companyScope, packStatement, staffStatement } from "../src/routes/companyObjects.ts";
import { canonicalJson } from "../src/signing.ts";
import { connectRunner, type Hub, makeClient, newDevice, type Person, startHub } from "./harness.ts";

let hub: Hub;
let client: ReturnType<typeof makeClient>;

before(async () => {
  hub = await startHub();
  client = makeClient(hub);
});
after(() => hub.close());

describe("policy: company staff and packs", () => {
  const base = { actorUserId: "u-maria", managerUserId: "u-maria", deleted: false };
  it("owners and admins write any agent; managers only change the agents they manage", () => {
    assert.equal(policy.canEditStaff({ ...base, role: "admin", existing: null }), true);
    assert.equal(policy.canEditStaff({ ...base, role: "owner", existing: null, deleted: true }), true);
    assert.equal(policy.canEditStaff({ ...base, role: "member", existing: null }), false);
    const managed = { managerUserId: "u-maria", deleted: false };
    assert.equal(policy.canEditStaff({ ...base, role: "member", existing: managed }), true);
    assert.equal(policy.canEditStaff({ ...base, role: "member", existing: managed, managerUserId: "u-ion" }), false);
    assert.equal(policy.canEditStaff({ ...base, role: "member", existing: managed, deleted: true }), false);
    assert.equal(policy.canEditStaff({ ...base, role: "member", existing: { managerUserId: "u-ion", deleted: false } }), false);
    assert.equal(policy.canEditStaff({ ...base, role: "guest", existing: managed }), false);
  });
  it("guests do not use staff; only admins manage company packs", () => {
    assert.equal(policy.canUseStaff("guest"), false);
    assert.equal(policy.canUseStaff("member"), true);
    assert.equal(policy.canManageCompanyPacks("member"), false);
    assert.equal(policy.canManageCompanyPacks("admin"), true);
  });
  it("is migration v6", () => {
    assert.ok(MIGRATIONS.length >= 6);
    assert.match(MIGRATIONS[5]!, /CREATE TABLE company_staff/);
    assert.match(MIGRATIONS[5]!, /CREATE TABLE company_packs/);
    assert.match(MIGRATIONS[5]!, /CREATE TABLE company_pack_status/);
  });
});

describe("company AI staff and packs over HTTP", () => {
  let alex: Person;
  let maria: Person;
  let gina: Person;
  let companyId = "";
  let envId = "";
  let mariaEnv = "";
  let runner: Awaited<ReturnType<typeof connectRunner>>;
  const call = (...args: Parameters<typeof client.call>) => client.call(...args);
  const runnerKeys = newDevice();

  const staffBody = (person: Person, input: { staffId: string; version: number; managerUserId: string | null; sealed: Record<string, string>; deleted?: boolean; ts?: number }) => {
    const ts = input.ts ?? Date.now();
    const statement = staffStatement({
      companyId,
      staffId: input.staffId,
      version: input.version,
      managerUserId: input.managerUserId,
      deleted: input.deleted ?? false,
      sealed: input.sealed,
      by: person.userId,
      ts,
    });
    return {
      version: input.version,
      managerUserId: input.managerUserId,
      sealed: input.sealed,
      deleted: input.deleted ?? false,
      ts,
      signature: client.signStatement(person, statement),
    };
  };

  it("sets up a company with an owner, a member, a guest and a runner with keys", async () => {
    alex = await client.signIn("alex@bistro.test");
    maria = await client.signIn("maria@bistro.test");
    gina = await client.signIn("gina@bistro.test");
    companyId = (await call(alex.token, "POST", "/v1/companies", { name: "Bistro" })).json.id;
    await client.enableTotp(alex);
    const invite = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { role: "member" });
    await call(maria.token, "POST", "/v1/invites/accept", { token: invite.json.link });
    const guest = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { role: "guest" });
    await call(gina.token, "POST", "/v1/invites/accept", { token: guest.json.link });
    const registered = await call(alex.token, "POST", "/v1/environments", { name: "Bistro server" });
    envId = registered.json.environmentId;
    await call(alex.token, "PUT", `/v1/environments/${envId}/keys`, { signPublicKey: runnerKeys.signPublicKey, boxPublicKey: runnerKeys.boxPublicKey });
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyId })).status, 200);
    runner = await connectRunner(hub, registered.json.credential);
    mariaEnv = (await call(maria.token, "POST", "/v1/environments", { name: "Maria laptop" })).json.environmentId;
  });

  it("an admin publishes a profile sealed to the runner; the hub keeps ciphertext and the version", async () => {
    const sealed = { [envId]: "c2VhbGVkLXByb2ZpbGUtb2YtbWFyaWEtYWdlbnQ" };
    const put = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 1, managerUserId: maria.userId, sealed }));
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const listed = await call(maria.token, "GET", `/v1/companies/${companyId}/staff`);
    assert.equal(listed.status, 200);
    const record = listed.json.staff[0];
    assert.equal(record.version, 1);
    assert.equal(record.managerUserId, maria.userId);
    assert.deepEqual(record.sealed, sealed);
    assert.equal(record.signerPublicKey, alex.device.signPublicKey);
    assert.equal(JSON.parse(record.statement).sealedSha256.length > 20, true);
    assert.equal(listed.json.runners[0].keys.boxPublicKey, runnerKeys.boxPublicKey);
    // Creating one is e-mailed to admins and kept in the audit log.
    assert.match(client.lastMail("alex@bistro.test")!.subject, /A new AI employee was added/);
  });

  it("guests see nothing; members cannot create; the signature, runners and version are checked", async () => {
    assert.equal((await call(gina.token, "GET", `/v1/companies/${companyId}/staff`)).status, 403);
    const sealed = { [envId]: "eA" };
    const memberCreate = await call(maria.token, "PUT", `/v1/companies/${companyId}/staff/s-new001`, staffBody(maria, { staffId: "s-new001", version: 1, managerUserId: maria.userId, sealed }));
    assert.equal(memberCreate.status, 403);
    const forged = { ...staffBody(alex, { staffId: "s-abc123", version: 2, managerUserId: maria.userId, sealed }), managerUserId: alex.userId };
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, forged)).status, 400);
    const notRunner = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 2, managerUserId: maria.userId, sealed: { [mariaEnv]: "eA" } }));
    assert.equal(notRunner.status, 400);
    const stale = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 1, managerUserId: maria.userId, sealed }));
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /newer version \(1\)/);
    const old = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 2, managerUserId: maria.userId, sealed, ts: Date.now() - 10 * 60_000 }));
    assert.equal(old.status, 400);
  });

  it("the manager changes their agent (last writer wins by version), but cannot hand it over or delete it", async () => {
    const sealed = { [envId]: "dmVyc2lvbi0y" };
    const ok = await call(maria.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(maria, { staffId: "s-abc123", version: 2, managerUserId: maria.userId, sealed }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const handOver = await call(maria.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(maria, { staffId: "s-abc123", version: 3, managerUserId: alex.userId, sealed }));
    assert.equal(handOver.status, 403);
    const del = await call(maria.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(maria, { staffId: "s-abc123", version: 3, managerUserId: maria.userId, sealed: {}, deleted: true }));
    assert.equal(del.status, 403);
    // An admin writing after a skipped version still wins (any higher version).
    const jump = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 5, managerUserId: maria.userId, sealed }));
    assert.equal(jump.status, 200);
    const audit = await call(alex.token, "GET", `/v1/companies/${companyId}/audit`);
    const actions = audit.json.entries.map((entry: { action: string }) => entry.action);
    assert.ok(actions.includes("staff.create"));
    assert.equal(actions.filter((action: string) => action === "staff.update").length, 2);
  });

  it("a deleted agent keeps no ciphertext", async () => {
    const deleted = await call(alex.token, "PUT", `/v1/companies/${companyId}/staff/s-abc123`, staffBody(alex, { staffId: "s-abc123", version: 6, managerUserId: maria.userId, sealed: {}, deleted: true }));
    assert.equal(deleted.status, 200);
    const row = hub.db.prepare("SELECT sealed, deleted_at FROM company_staff WHERE staff_id = 's-abc123'").get() as { sealed: string; deleted_at: string | null };
    assert.equal(row.sealed, "{}");
    assert.notEqual(row.deleted_at, null);
  });

  it("the company runner relay forwards signed requests to the runner, never for guests", async () => {
    const input = { sealed: "c2VhbGVkLXRhc2s" };
    const sig = client.signRequest(maria, "staff.task", companyScope(companyId), input);
    const asked = await call(maria.token, "POST", `/v1/companies/${companyId}/runner`, { op: "staff.task", input, sig });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(asked.json.environmentId, envId);
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "staff.task");
    assert.equal(frame.shareId, companyScope(companyId));
    assert.equal(frame.actor.email, "maria@bistro.test");
    assert.equal(frame.device.keyId, maria.device.keyId);
    // The status of a task (an @mention reply follows it) goes through the same relay.
    const runInput = { sealed: "c2VhbGVkLXJ1bg" };
    const runSig = client.signRequest(maria, "staff.run", companyScope(companyId), runInput);
    const status = await call(maria.token, "POST", `/v1/companies/${companyId}/runner`, { op: "staff.run", input: runInput, sig: runSig });
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(runner.asked.at(-1).op, "staff.run");
    // Replays, other ops and guests are refused.
    assert.equal((await call(maria.token, "POST", `/v1/companies/${companyId}/runner`, { op: "staff.task", input, sig })).status, 403);
    const other = { op: "thread.prompt", input, sig: client.signRequest(maria, "thread.prompt", companyScope(companyId), input) };
    assert.equal((await call(maria.token, "POST", `/v1/companies/${companyId}/runner`, other)).status, 400);
    const guest = { op: "staff.list", input: {}, sig: client.signRequest(gina, "staff.list", companyScope(companyId), {}) };
    assert.equal((await call(gina.token, "POST", `/v1/companies/${companyId}/runner`, guest)).status, 403);
  });

  it("answers 503 when the company runner is offline", async () => {
    runner.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sig = client.signRequest(maria, "staff.list", companyScope(companyId), {});
    const offline = await call(maria.token, "POST", `/v1/companies/${companyId}/runner`, { op: "staff.list", input: {}, sig });
    assert.equal(offline.status, 503);
  });

  const packBody = (person: Person, input: { packId: string; version: string; settings?: Record<string, unknown>; enterprise?: boolean }) => {
    const ts = Date.now();
    const settings = input.settings ?? {};
    const statement = packStatement({ companyId, packId: input.packId, version: input.version, settings, enterprise: input.enterprise ?? false, by: person.userId, ts });
    return { version: input.version, settings, enterprise: input.enterprise ?? false, ts, signature: client.signStatement(person, statement) };
  };

  it("an admin installs a pack for the company; members cannot; settings never carry keys", async () => {
    assert.equal((await call(maria.token, "PUT", `/v1/companies/${companyId}/packs/website-health`, packBody(maria, { packId: "website-health", version: "1.1.0" }))).status, 403);
    const leaky = packBody(alex, { packId: "website-health", version: "1.1.0", settings: { token: "sk-ant-abcdefghijklmnop" } });
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${companyId}/packs/website-health`, leaky)).status, 400);
    const ok = await call(alex.token, "PUT", `/v1/companies/${companyId}/packs/website-health`, packBody(alex, { packId: "website-health", version: "1.1.0", settings: { language: "ro" } }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.match(client.lastMail("alex@bistro.test")!.subject, /website-health 1\.1\.0 was installed for the whole company/);
    const ent = await call(alex.token, "PUT", `/v1/companies/${companyId}/packs/meta-ads`, packBody(alex, { packId: "meta-ads", version: "0.3.0", enterprise: true }));
    assert.equal(ent.status, 200);
    const listed = await call(maria.token, "GET", `/v1/companies/${companyId}/packs`);
    assert.deepEqual(listed.json.packs.map((pack: { packId: string }) => pack.packId), ["website-health", "meta-ads"]);
    const health = listed.json.packs[0];
    assert.deepEqual(health.settings, { language: "ro" });
    assert.equal(health.statement, canonicalJson(JSON.parse(health.statement)));
    assert.equal(health.signerPublicKey, alex.device.signPublicKey);
    assert.equal(listed.json.packs[1].enterprise, true);
  });

  it("each machine reports its status; admins see everyone, members only themselves", async () => {
    const report = (person: Person, packId: string, body: Record<string, unknown>) =>
      call(person.token, "POST", `/v1/companies/${companyId}/packs/${packId}/status`, body);
    assert.equal((await report(maria, "website-health", { environmentId: mariaEnv, state: "installing", version: null })).status, 200);
    assert.equal((await report(maria, "website-health", { environmentId: mariaEnv, state: "failed", version: null, error: "No space left" })).status, 200);
    assert.equal((await report(maria, "meta-ads", { environmentId: mariaEnv, state: "runner-only", version: null, hidden: true })).status, 200);
    assert.equal((await report(alex, "website-health", { environmentId: envId, state: "installed", version: "1.1.0" })).status, 200);
    // Someone else's machine, an unknown state, a pack not installed for the company.
    assert.equal((await report(maria, "website-health", { environmentId: envId, state: "installed" })).status, 404);
    assert.equal((await report(maria, "website-health", { environmentId: mariaEnv, state: "done" })).status, 400);
    assert.equal((await report(maria, "review-replies", { environmentId: mariaEnv, state: "installed" })).status, 404);
    const admin = await call(alex.token, "GET", `/v1/companies/${companyId}/packs`);
    assert.equal(admin.json.status.length, 3);
    const failed = admin.json.status.find((row: { environmentId: string; packId: string }) => row.environmentId === mariaEnv && row.packId === "website-health");
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "No space left");
    assert.equal(failed.userName, "maria");
    const onRunner = admin.json.status.find((row: { environmentId: string }) => row.environmentId === envId);
    assert.equal(onRunner.runner, true);
    const member = await call(maria.token, "GET", `/v1/companies/${companyId}/packs`);
    assert.equal(member.json.status.length, 2);
    assert.equal(member.json.status.find((row: { packId: string }) => row.packId === "meta-ads").hidden, true);
  });

  it("removing a company pack clears its status and is an admin action", async () => {
    assert.equal((await call(maria.token, "DELETE", `/v1/companies/${companyId}/packs/website-health`)).status, 403);
    assert.equal((await call(alex.token, "DELETE", `/v1/companies/${companyId}/packs/website-health`)).status, 200);
    const listed = await call(alex.token, "GET", `/v1/companies/${companyId}/packs`);
    assert.deepEqual(listed.json.packs.map((pack: { packId: string }) => pack.packId), ["meta-ads"]);
    assert.equal(listed.json.status.some((row: { packId: string }) => row.packId === "website-health"), false);
    // Installing it again brings it back.
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${companyId}/packs/website-health`, packBody(alex, { packId: "website-health", version: "1.2.0" }))).status, 200);
  });
});
