// Enterprise security (v9) over HTTP: custom roles enforced on every company route (a matrix),
// scoped roles, the permissions the runner receives with each request, one machine as the runner
// of several companies without anything crossing between them, the read-only follow op, the
// tamper-evident audit log (search, export, verify, tamper detection, the verify command) and the
// SIEM stream.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { anchorToday, AuditLog, openAuditDb, verifyChain } from "../src/auditChain.ts";
import { openDb } from "../src/db.ts";
import { companyScope, staffStatement } from "../src/routes/companyObjects.ts";
import { checkSiemUrl } from "../src/siem.ts";
import { connectRunner, type Hub, makeClient, newDevice, type Person, startHub } from "./harness.ts";

let hub: Hub;
let client: ReturnType<typeof makeClient>;
let siemServer: Server;
const siemHits: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
let siemUrl = "";

before(async () => {
  hub = await startHub({ config: { siemAllowPrivate: true } });
  client = makeClient(hub);
  siemServer = createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      siemHits.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => siemServer.listen(0, "127.0.0.1", resolve));
  siemUrl = `http://127.0.0.1:${(siemServer.address() as AddressInfo).port}/zen`;
});
after(async () => {
  runner?.close();
  await hub.close();
  await new Promise((resolve) => siemServer.close(resolve));
});

const call = (...args: Parameters<typeof client.call>) => client.call(...args);

let alex: Person; // owner of Bistro Ana and Agentia Nord, owns the srv-birou runner
let maria: Person; // member of Bistro Ana
let nora: Person; // member of Bistro Ana with the custom role "Contabilitate"
let gina: Person; // guest of Bistro Ana
let ion: Person; // member of Agentia Nord only
let olga: Person; // owner of another company
let horeca = "";
let zedzen = "";
let other = "";
let envId = "";
let runner: Awaited<ReturnType<typeof connectRunner>>;
let runnerCredential = "";
const runnerKeys = newDevice();

const join_ = async (owner: Person, companyId: string, person: Person, role: "member" | "guest" | "admin") => {
  const invite = await call(owner.token, "POST", `/v1/companies/${companyId}/invites`, { role });
  assert.equal(invite.status, 200, `${companyId} ${JSON.stringify(invite.json)}`);
  assert.equal((await call(person.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
};

const runnerCall = (person: Person, companyId: string, op: string, input: Record<string, unknown> = { sealed: "eA" }) =>
  call(person.token, "POST", `/v1/companies/${companyId}/runner`, { op, input, sig: client.signRequest(person, op, companyScope(companyId), input) });

describe("enterprise security", () => {
  it("sets up two companies of Alex served by one runner, plus an outside company", async () => {
    alex = await client.signIn("alex@zedzen.test");
    maria = await client.signIn("maria@horeca.test");
    nora = await client.signIn("nora@horeca.test");
    gina = await client.signIn("gina@outside.test");
    ion = await client.signIn("ion@zedzen.test");
    olga = await client.signIn("olga@other.test");
    horeca = (await call(alex.token, "POST", "/v1/companies", { name: "Bistro Ana" })).json.id;
    // Owners must use two-factor before anything else.
    await client.enableTotp(alex);
    zedzen = (await call(alex.token, "POST", "/v1/companies", { name: "Agentia Nord" })).json.id;
    other = (await call(olga.token, "POST", "/v1/companies", { name: "Other" })).json.id;
    await client.enableTotp(olga);
    await join_(alex, horeca, maria, "member");
    await join_(alex, horeca, nora, "member");
    await join_(alex, horeca, gina, "guest");
    await join_(alex, zedzen, ion, "member");
    const registered = await call(alex.token, "POST", "/v1/environments", { name: "srv-birou" });
    envId = registered.json.environmentId;
    runnerCredential = registered.json.credential;
    await call(alex.token, "PUT", `/v1/environments/${envId}/keys`, { signPublicKey: runnerKeys.signPublicKey, boxPublicKey: runnerKeys.boxPublicKey });
    const both = await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyIds: [horeca, zedzen] });
    assert.equal(both.status, 200, JSON.stringify(both.json));
    assert.deepEqual(new Set(both.json.runnerCompanyIds), new Set([horeca, zedzen]));
    runner = await connectRunner(hub, runnerCredential);
  });

  it("owners and admins define custom roles; members cannot; every change is audited with address, device and user agent", async () => {
    const accounting = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, {
      name: "Contabilitate",
      description: "Facturi și date de facturare",
      permissions: ["facturare:vede", "facturare:administreaza", "echipa:vede", "chats:vede"],
    });
    assert.equal(accounting.status, 200, JSON.stringify(accounting.json));
    assert.equal((await call(maria.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Mine", permissions: [] })).status, 403);
    assert.equal((await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Contabilitate", permissions: [] })).status, 400, "name taken");
    assert.equal((await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Admin", permissions: [] })).status, 400, "reserved");
    assert.equal((await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "X", permissions: ["root:all"] })).status, 400);
    const assigned = await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${nora.userId}/access`, { customRoleId: accounting.json.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
    assert.deepEqual(assigned.json.access.permissions, ["chats:vede", "facturare:vede", "facturare:administreaza", "echipa:vede"]);
    // Owners and admins already have every permission.
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${alex.userId}/access`, { customRoleId: accounting.json.id })).status, 400);
    const listed = await call(nora.token, "GET", `/v1/companies/${horeca}/roles`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.roles.map((role: any) => role.name), ["Owner", "Admin", "Membru", "Invitat", "Contabilitate"]);
    assert.equal(listed.json.canEdit, false);
    assert.equal(listed.json.roles.find((role: any) => role.name === "Contabilitate").memberCount, 1);
    const events = hub.auditLog.search({ companyId: horeca, action: "role" });
    const created = events.find((event) => event.action === "role.create")!;
    assert.equal(created.actorEmail, "alex@zedzen.test");
    assert.equal(created.ip, "127.0.0.1");
    assert.equal(created.deviceId, alex.device.keyId);
    assert.match(created.userAgent ?? "", /node|undici/i);
    assert.ok(hub.auditLog.search({ companyId: horeca, action: "member.permissions" }).length === 1);
    const company = await call(alex.token, "GET", `/v1/companies/${horeca}`);
    assert.equal(company.json.members.find((member: any) => member.userId === nora.userId).customRoleName, "Contabilitate");
  });

  it("enforces the role on every company route (permissions matrix)", async () => {
    // [who, method, path, body?, expected]: 403 = refused by the role; "ok" = anything but 403/404.
    type Row = [Person, string, string, unknown, 403 | 404 | "ok"];
    const c = `/v1/companies/${horeca}`;
    const matrix: Array<Row> = [
      [maria, "GET", `${c}/staff`, undefined, "ok"],
      [nora, "GET", `${c}/staff`, undefined, 403],
      [nora, "GET", `${c}/staff/summary`, undefined, 403],
      [maria, "GET", `${c}/packs`, undefined, "ok"],
      [nora, "GET", `${c}/packs`, undefined, 403],
      [maria, "GET", `${c}/grants`, undefined, "ok"],
      [nora, "GET", `${c}/grants`, undefined, 403],
      [maria, "GET", `${c}/settings`, undefined, "ok"],
      [nora, "GET", `${c}/settings`, undefined, 403],
      [nora, "GET", `${c}/roles`, undefined, "ok"],
      [gina, "GET", `${c}/roles`, undefined, 403],
      [maria, "GET", `${c}/security/log`, undefined, 403],
      [nora, "GET", `${c}/security/log`, undefined, 403],
      [alex, "GET", `${c}/security/log`, undefined, "ok"],
      [maria, "GET", `${c}/security/log/export?format=csv`, undefined, 403],
      [maria, "GET", `${c}/security/log/verify`, undefined, 403],
      [maria, "GET", `${c}/security/siem`, undefined, 403],
      [maria, "GET", `${c}/audit`, undefined, 403],
      [maria, "POST", `${c}/invites`, { role: "member" }, 403],
      [nora, "POST", `${c}/invites`, { role: "member" }, 403],
      [maria, "PUT", `${c}/members/${nora.userId}/access`, { customRoleId: null }, 403],
      [maria, "PATCH", `${c}/members/${nora.userId}`, { role: "guest" }, 403],
      [maria, "DELETE", `${c}/members/${nora.userId}`, undefined, 403],
      [nora, "PATCH", c, { details: { city: "Reghin" } }, "ok"],
      [maria, "PATCH", c, { details: { city: "Reghin" } }, 403],
      [nora, "PATCH", c, { name: "Nora's" }, 403],
      [maria, "PUT", `${c}/settings`, { memory: { url: null } }, 403],
      [maria, "PUT", `${c}/packs/website-health`, { version: "1.0.0" }, 403],
      [maria, "POST", `${c}/teams`, { name: "Vânzări" }, 403],
      [maria, "PUT", `${c}/projects/p-site`, { name: "Site" }, 403],
      [olga, "GET", `${c}/roles`, undefined, 404],
      [olga, "GET", `${c}/security/log`, undefined, 404],
    ];
    for (const [who, method, path, body, expected] of matrix) {
      const answer = await call(who.token, method, path, body);
      const label = `${who.email} ${method} ${path} -> ${answer.status} ${JSON.stringify(answer.json)}`;
      if (expected === "ok") assert.ok(answer.status !== 403 && answer.status !== 404, label);
      else assert.equal(answer.status, expected, label);
    }
    // Relay ops: the hub checks the op's permission before anything reaches the runner.
    const before = runner.asked.length;
    assert.equal((await runnerCall(nora, horeca, "staff.list")).status, 403);
    assert.equal((await runnerCall(nora, horeca, "staff.task")).status, 403);
    assert.equal((await runnerCall(gina, horeca, "staff.follow")).status, 403);
    assert.equal(runner.asked.length, before);
    assert.equal((await runnerCall(maria, horeca, "staff.list")).status, 200);
    // Without "echipa: vede" a person sees only themselves.
    const blind = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Doar chaturi", permissions: ["chats:vede"] });
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: blind.json.id });
    const seen = await call(maria.token, "GET", `/v1/companies/${horeca}`);
    assert.deepEqual(seen.json.members.map((member: any) => member.userId), [maria.userId]);
    assert.equal(seen.json.settings, null);
    const overview = await call(nora.token, "GET", `/v1/companies/${horeca}/overview`);
    assert.equal(overview.json.company.details.city, "Reghin", "billing sees the invoicing details");
    assert.equal(overview.json.staff.visible, false);
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: null });
  });

  it("a role scoped to a project counts only there", async () => {
    const team = await call(alex.token, "POST", `/v1/companies/${horeca}/teams`, { name: "Dezvoltare" });
    assert.equal(team.status, 200);
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${horeca}/projects/p-site`, { name: "Site", teamId: team.json.id })).status, 200);
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${horeca}/projects/p-pos`, { name: "POS" })).status, 200);
    const developer = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Developer", permissions: ["angajati:administreaza"] });
    const scoped = await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, {
      customRoleId: null,
      scoped: [{ roleId: developer.json.id, kind: "team", id: team.json.id }],
    });
    assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
    assert.equal((await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { scoped: [{ roleId: developer.json.id, kind: "project", id: "p-nope" }] })).status, 404);
    const put = (staffId: string, projectId: string | null, version = 1) => {
      const sealed = { [envId]: "c2VhbGVk" };
      const ts = Date.now();
      const statement = staffStatement({ companyId: horeca, staffId, version, managerUserId: maria.userId, deleted: false, sealed, by: maria.userId, ts });
      return call(maria.token, "PUT", `/v1/companies/${horeca}/staff/${staffId}`, {
        version,
        managerUserId: maria.userId,
        sealed,
        deleted: false,
        projectId,
        ts,
        signature: client.signStatement(maria, statement),
      });
    };
    assert.equal((await put("s-site-agent", "p-site")).status, 200, "inside the team's project");
    assert.equal((await put("s-pos-agent", "p-pos")).status, 403, "another project");
    assert.equal((await put("s-loose-agent", null)).status, 403, "company-wide");
    // Moving the agent out of her scope is refused too.
    assert.equal((await put("s-site-agent", "p-pos", 2)).status, 403);
    const summary = await call(alex.token, "GET", `/v1/companies/${horeca}/staff/summary`);
    assert.equal(summary.json.staff.find((item: any) => item.staffId === "s-site-agent").projectId, "p-site");
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: null, scoped: [] });
  });

  it("hands the runner the permissions of the person who gave the task, never more", async () => {
    const tasksOnly = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Doar sarcini", permissions: ["angajati:vede", "angajati:creeaza", "chats:urmareste"] });
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: tasksOnly.json.id });
    const task = await runnerCall(maria, horeca, "staff.task");
    assert.equal(task.status, 200, JSON.stringify(task.json));
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "staff.task");
    assert.equal(frame.companyId, horeca);
    assert.equal(frame.actor.userId, maria.userId);
    assert.equal(frame.actorAccess.role, "member");
    assert.ok(frame.actorAccess.permissions.includes("angajati:creeaza"));
    assert.equal(frame.actorAccess.permissions.includes("angajati:trimite"), false, "her agent may not send anything out");
    // The task is in the audit log, metadata only.
    const logged = hub.auditLog.search({ companyId: horeca, action: "runner.task.request" })[0]!;
    assert.equal(logged.actorUserId, maria.userId);
    assert.doesNotMatch(JSON.stringify(logged.detail), /eA/);
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: null });
  });

  it("members follow their task's runner thread read-only (staff.follow); a role without it cannot", async () => {
    const follow = await runnerCall(maria, horeca, "staff.follow", { sealed: "Zm9sbG93" });
    assert.equal(follow.status, 200, JSON.stringify(follow.json));
    const frame = runner.asked.at(-1);
    assert.equal(frame.op, "staff.follow");
    assert.equal(frame.shareId, companyScope(horeca));
    assert.ok(frame.actorAccess.permissions.includes("chats:urmareste"));
    assert.equal(frame.actorAccess.permissions.includes("chats:urmareste-toate"), false, "only her own tasks; the runner checks who started the run");
    const noFollow = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Fără urmărire", permissions: ["angajati:vede", "angajati:creeaza"] });
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: noFollow.json.id });
    assert.equal((await runnerCall(maria, horeca, "staff.follow")).status, 403);
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: null });
    // Members write nothing on the company server: a company chat stays read-only for them.
    const shared = await call(alex.token, "POST", "/v1/shares", { environmentId: envId, companyId: horeca, threadId: "t-runner", kind: "company", audienceUserId: null });
    assert.equal(shared.status, 200, JSON.stringify(shared.json));
    assert.equal(shared.json.permissions.prompt, true);
    const asMaria = (await call(maria.token, "GET", "/v1/shares")).json.shares.find((share: any) => share.id === shared.json.id);
    assert.deepEqual({ view: asMaria.permissions.view, prompt: asMaria.permissions.prompt }, { view: true, prompt: false });
    assert.equal((await client.relay(maria, `/v1/shares/${shared.json.id}/prompt`, "thread.prompt", shared.json.id, { text: "hi" })).status, 403);
  });

  it("a task names its AI employee: a role scoped to a project (or its team) gives tasks only there", async () => {
    // s-site-agent lives in p-site (team Dezvoltare); an agent with no project is the whole company's.
    const listed = await call(alex.token, "GET", `/v1/companies/${horeca}/roles`);
    const team = listed.json.teams.find((item: any) => item.name === "Dezvoltare");
    const sealed = { [envId]: "c2VhbGVk" };
    const ts = Date.now();
    const statement = staffStatement({ companyId: horeca, staffId: "s-company", version: 1, managerUserId: null, deleted: false, sealed, by: alex.userId, ts });
    const created = await call(alex.token, "PUT", `/v1/companies/${horeca}/staff/s-company`, {
      version: 1,
      managerUserId: null,
      sealed,
      deleted: false,
      projectId: null,
      ts,
      signature: client.signStatement(alex, statement),
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const seeOnly = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Doar vede AI", permissions: ["angajati:vede"] });
    const tasks = await call(alex.token, "POST", `/v1/companies/${horeca}/roles`, { name: "Sarcini Dezvoltare", permissions: ["angajati:creeaza", "angajati:trimite"] });
    const set = await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, {
      customRoleId: seeOnly.json.id,
      scoped: [{ roleId: tasks.json.id, kind: "team", id: team.id }],
    });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const task = (staffId?: string) =>
      call(maria.token, "POST", `/v1/companies/${horeca}/runner`, {
        op: "staff.task",
        input: { sealed: "eA" },
        sig: client.signRequest(maria, "staff.task", companyScope(horeca), { sealed: "eA" }),
        ...(staffId === undefined ? {} : { staffId }),
      });
    assert.equal((await task("s-site-agent")).status, 200, "an agent of her team's project");
    // The runner gets her team grant listed for the team's project (it checks the agent's project).
    const frame = runner.asked.at(-1);
    assert.ok(frame.actorAccess.scoped.some((grant: any) => grant.kind === "project" && grant.id === "p-site" && grant.permission === "angajati:creeaza"));
    assert.ok(frame.actorAccess.scoped.some((grant: any) => grant.kind === "team" && grant.id === team.id));
    const refused = await task("s-company");
    assert.equal(refused.status, 403, "the whole company's agent");
    assert.match(refused.json.error, /angajati: creeaza/);
    assert.equal((await task("s-nope")).status, 404);
    // An app that does not name the agent: the runner decides with the expanded access.
    assert.equal((await task()).status, 200);
    // Her own access and the members' list show the team grant per project too.
    const mine = await call(maria.token, "GET", `/v1/companies/${horeca}/access`);
    assert.ok(mine.json.access.scoped.some((grant: any) => grant.kind === "project" && grant.id === "p-site"));
    const company = await call(alex.token, "GET", `/v1/companies/${horeca}`);
    const asMember = company.json.members.find((member: any) => member.userId === maria.userId);
    assert.ok(asMember.access.scoped.some((grant: any) => grant.kind === "project" && grant.id === "p-site"));
    await call(alex.token, "PUT", `/v1/companies/${horeca}/members/${maria.userId}/access`, { customRoleId: null, scoped: [] });
  });
});

describe("one runner for several companies: isolation", () => {
  it("each company sees the shared machine as its runner with its own AI account", async () => {
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/ai-account`, { account: { provider: "claude", mode: "seat", label: "Team seat" } })).status, 400, "which company?");
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/ai-account`, { companyId: horeca, account: { provider: "claude", mode: "seat", label: "Bistro Ana seat" } })).status, 200);
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/ai-account`, { companyId: zedzen, account: { provider: "claude", mode: "api-key", label: "Agentia Nord key" } })).status, 200);
    assert.equal((await call(alex.token, "PUT", `/v1/environments/${envId}/ai-account`, { companyId: other, account: { provider: "claude", mode: "seat", label: "x" } })).status, 403);
    const a = await call(maria.token, "GET", `/v1/companies/${horeca}`);
    const b = await call(ion.token, "GET", `/v1/companies/${zedzen}`);
    assert.equal(a.json.runners[0].aiAccount.label, "Bistro Ana seat");
    assert.equal(a.json.runners[0].companies, 2);
    assert.equal(b.json.runners[0].aiAccount.label, "Agentia Nord key");
    const me = await call(alex.token, "GET", "/v1/me");
    const machine = me.json.environments.find((environment: any) => environment.id === envId);
    assert.deepEqual(new Set(machine.runnerCompanyIds), new Set([horeca, zedzen]));
    assert.equal(machine.runners.length, 2);
  });

  it("nobody reaches another company through the shared runner", async () => {
    // Ion (Agentia Nord) cannot ask Bistro Ana; Maria cannot ask Agentia Nord.
    assert.equal((await runnerCall(ion, horeca, "staff.list")).status, 404);
    assert.equal((await runnerCall(maria, zedzen, "staff.list")).status, 404);
    // Alex is in both: a request signed for Bistro Ana does not work for Agentia Nord (scope in the signature).
    const input = { sealed: "eA" };
    const sigForHoreca = client.signRequest(alex, "staff.list", companyScope(horeca), input);
    const replay = await call(alex.token, "POST", `/v1/companies/${zedzen}/runner`, { op: "staff.list", input, sig: sigForHoreca });
    assert.equal(replay.status, 403);
    // Each request names its company: the runner opens it in that company's context only.
    assert.equal((await runnerCall(ion, zedzen, "staff.list")).status, 200);
    const frame = runner.asked.at(-1);
    assert.equal(frame.companyId, zedzen);
    assert.equal(frame.shareId, companyScope(zedzen));
    assert.equal(frame.actorAccess.role, "member");
    // Staff: Bistro Ana's agents are not listed in Agentia Nord, and roles are per company.
    const zedzenStaff = await call(ion.token, "GET", `/v1/companies/${zedzen}/staff`);
    assert.deepEqual(zedzenStaff.json.staff, []);
    assert.equal((await call(ion.token, "GET", `/v1/companies/${horeca}/roles`)).status, 404);
    const zedzenRoles = await call(alex.token, "GET", `/v1/companies/${zedzen}/roles`);
    assert.equal(zedzenRoles.json.roles.some((role: any) => role.name === "Contabilitate"), false);
    // Audit chains are per company.
    assert.equal(hub.auditLog.search({ companyId: zedzen }).some((event) => event.action === "role.create"), false);
  });

  it("runner reports and device alerts only for companies the runner serves", async () => {
    const report = (companyId: string, events: Array<object>) =>
      fetch(`${hub.base}/v1/runner/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Runner ${runnerCredential}` },
        body: JSON.stringify({ companyId, events }),
      });
    const ok = await report(horeca, [{ action: "runner.task.start", actorUserId: maria.userId, staffId: "s-site-agent", runId: "run-1", trigger: "hub" }, { action: "approval.decided", actorUserId: alex.userId, runId: "run-1", decision: "approved", kind: "email" }]);
    assert.equal(ok.status, 200);
    assert.equal((await report(other, [{ action: "runner.task.start" }])).status, 403);
    assert.equal((await report(horeca, [{ action: "runner.task.start", runId: "has spaces and text" }])).status, 400, "metadata ids only");
    assert.equal((await report(horeca, [{ action: "chat.message", text: "secret" }])).status, 400);
    const started = hub.auditLog.search({ companyId: horeca, action: "runner.task.start" })[0]!;
    assert.equal(started.actorUserId, maria.userId);
    assert.equal(started.deviceId, `env:${envId}`);
    assert.equal(started.detail.runId, "run-1");
    const decided = hub.auditLog.search({ companyId: horeca, action: "approval.decided" })[0]!;
    assert.equal(decided.detail.decision, "approved");
    const alert = await fetch(`${hub.base}/v1/runner/pending-device`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Runner ${runnerCredential}` },
      body: JSON.stringify({ userId: olga.userId, keyId: olga.device.keyId, companyId: other }),
    });
    assert.equal(alert.status, 400);
  });

  it("only each company's own owner/admin who owns the machine adds it; removing one company keeps the other", async () => {
    // Olga owns "Other" but not the machine.
    assert.equal((await call(olga.token, "POST", `/v1/environments/${envId}/runner/companies/${other}`)).status, 404);
    // Alex owns the machine but is not in "Other".
    assert.equal((await call(alex.token, "POST", `/v1/environments/${envId}/runner/companies/${other}`)).status, 404);
    const zedzenShare = await call(alex.token, "POST", "/v1/shares", { environmentId: envId, companyId: zedzen, threadId: "t-z", kind: "company", audienceUserId: null });
    assert.equal(zedzenShare.status, 200);
    const removed = await call(alex.token, "DELETE", `/v1/environments/${envId}/runner/companies/${zedzen}`);
    assert.deepEqual(removed.json.runnerCompanyIds, [horeca]);
    assert.equal((await call(ion.token, "GET", `/v1/shares/${zedzenShare.json.id}`)).status, 404, "Agentia Nord's company chats stop");
    assert.equal((await runnerCall(maria, horeca, "staff.list")).status, 200, "Bistro Ana keeps its runner");
    assert.equal((await runnerCall(ion, zedzen, "staff.list")).status, 503);
    // An older app's single-company call keeps its meaning: serve only this one.
    const legacy = await call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyId: zedzen });
    assert.deepEqual(legacy.json.runnerCompanyIds, [zedzen]);
    assert.equal(legacy.json.runnerCompanyId, zedzen);
    const restored = await call(alex.token, "POST", `/v1/environments/${envId}/runner/companies/${horeca}`);
    assert.deepEqual(new Set(restored.json.runnerCompanyIds), new Set([horeca, zedzen]));
  });
});

describe("tamper-evident audit log", () => {
  it("records sign-ins with address and user agent in each company's chain", async () => {
    // Before joining a company a sign-in goes to the hub's own chain.
    assert.ok(hub.auditLog.search({ companyId: "hub", action: "auth.signin" }).some((event) => event.actorUserId === maria.userId));
    await client.signIn("maria@horeca.test");
    const signIn = hub.auditLog.search({ companyId: horeca, action: "auth.signin" }).find((event) => event.actorUserId === maria.userId)!;
    assert.equal(signIn.ip, "127.0.0.1");
    assert.match(signIn.userAgent ?? "", /node|undici/i);
    assert.match(signIn.deviceId ?? "", /^session:[0-9a-f]{16}$/);
    assert.equal(signIn.detail.method, "email");
    assert.equal(hub.auditLog.search({ companyId: zedzen, action: "auth.signin" }).some((event) => event.actorUserId === maria.userId), false);
  });

  it("searches by person, action and date, exports CSV and JSON with the hashes, verifies the chain", async () => {
    const c = `/v1/companies/${horeca}/security/log`;
    const byAlex = await call(alex.token, "GET", `${c}?actor=alex@zedzen&action=role&limit=500`);
    assert.equal(byAlex.status, 200);
    assert.ok(byAlex.json.events.length >= 3);
    assert.ok(byAlex.json.events.every((event: any) => event.actorEmail === "alex@zedzen.test" && event.action.startsWith("role.")));
    assert.ok(byAlex.json.actions.includes("member.permissions"));
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    assert.equal((await call(alex.token, "GET", `${c}?from=${tomorrow}`)).json.events.length, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await call(alex.token, "GET", `${c}?from=${today}&to=${today}`)).json.events.length > 0);
    assert.equal((await call(alex.token, "GET", `${c}?from=yesterday`)).status, 400);
    const csv = await call(alex.token, "GET", `${c}/export?format=csv&action=role`);
    assert.equal(csv.status, 200);
    assert.match(csv.json.filename, /\.csv$/);
    const lines = csv.json.body.trim().split("\r\n");
    assert.equal(lines[0], "seq,chainSeq,ts,action,actorUserId,actorEmail,actorName,target,detail,ip,deviceId,userAgent,prevHash,hash,id");
    assert.ok(lines.length >= 4);
    assert.match(lines[1], /[0-9a-f]{64},[0-9a-f]{64},ev_/);
    const json = JSON.parse((await call(alex.token, "GET", `${c}/export?format=json`)).json.body);
    assert.equal(json.algorithm, "sha256(prev_hash + canonical_json(row))");
    // Exporting is itself an audited event.
    assert.ok(hub.auditLog.search({ companyId: horeca, action: "audit.export" }).length >= 2);
    const verified = await call(alex.token, "GET", `${c}/verify`);
    assert.equal(verified.json.ok, true, JSON.stringify(verified.json));
    assert.ok(verified.json.checked > 10);
  });

  it("refuses UPDATE and DELETE; finds a changed or removed row; finds a consistent rewrite through the anchors", () => {
    const log = new AuditLog(openAuditDb(":memory:"));
    const hubDb = openDb(":memory:");
    for (let index = 0; index < 5; index += 1) log.append({ companyId: "c1", actorUserId: "u1", action: "test.event", detail: { index } });
    assert.throws(() => log.db.exec("UPDATE audit_events SET action = 'x' WHERE chain_seq = 2"), /append-only/);
    assert.throws(() => log.db.exec("DELETE FROM audit_events WHERE chain_seq = 2"), /append-only/);
    assert.deepEqual({ ok: verifyChain(log.db, "c1").ok, checked: verifyChain(log.db, "c1").checked }, { ok: true, checked: 5 });
    anchorToday(log, hubDb);
    // Someone with the file drops the triggers and edits a row.
    log.db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete;");
    log.db.exec(`UPDATE audit_events SET detail = '{"index":99}' WHERE chain_seq = 3`);
    const changed = verifyChain(log.db, "c1");
    assert.equal(changed.ok, false);
    assert.equal(changed.brokenAt, 3);
    assert.equal(changed.reason, "the row was changed");
    // ...or removes one.
    log.db.exec(`UPDATE audit_events SET detail = '{"index":2}' WHERE chain_seq = 3`);
    assert.equal(verifyChain(log.db, "c1").ok, true);
    log.db.exec("DELETE FROM audit_events WHERE chain_seq = 4");
    assert.deepEqual({ ...verifyChain(log.db, "c1") }.brokenAt, 4);
    // A full, consistent rewrite of the chain verifies on its own, but not against the anchor.
    const rewritten = new AuditLog(openAuditDb(":memory:"));
    for (let index = 0; index < 5; index += 1) rewritten.append({ companyId: "c1", actorUserId: "u1", action: "test.event", detail: { index: index * 10 } });
    assert.equal(verifyChain(rewritten.db, "c1").ok, true);
    const againstAnchor = verifyChain(rewritten.db, "c1", [...hubDb.prepare("SELECT chain, day, head_seq AS headSeq, head_hash AS headHash, created_at AS createdAt FROM audit_anchors").all()] as any);
    assert.equal(againstAnchor.ok, false);
    assert.match(againstAnchor.reason ?? "", /anchor/);
    // Anchors are append-only too.
    assert.throws(() => hubDb.exec("DELETE FROM audit_anchors"), /append-only/);
    // Only one anchor per chain and day.
    assert.equal(anchorToday(log, hubDb).length, 0);
  });

  it("the verify command passes on an intact log and fails on a tampered one", () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-audit-"));
    try {
      const hubPath = join(dir, "hub.sqlite");
      const auditPath = join(dir, "audit.sqlite");
      const hubDb = openDb(hubPath);
      const auditDb = openAuditDb(auditPath);
      const log = new AuditLog(auditDb);
      for (let index = 0; index < 3; index += 1) log.append({ companyId: "c1", actorUserId: null, action: "test.event", detail: { index } });
      log.append({ companyId: null, actorUserId: null, action: "auth.signin", detail: {} });
      anchorToday(log, hubDb);
      const run = () => spawnSync(process.execPath, ["src/auditVerify.ts", "--db", hubPath, "--audit", auditPath], { encoding: "utf8" });
      const intact = run();
      assert.equal(intact.status, 0, intact.stdout + intact.stderr);
      assert.match(intact.stdout, /audit log intact \(2 chains, 2 anchors\)/);
      auditDb.exec("DROP TRIGGER audit_events_no_update;");
      auditDb.exec("UPDATE audit_events SET actor_user_id = 'u-evil' WHERE chain = 'c1' AND chain_seq = 2");
      const broken = run();
      assert.equal(broken.status, 1);
      assert.match(broken.stdout, /BROKEN {2}c1: at event 2 \(the row was changed\)/);
      auditDb.close();
      hubDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SIEM stream", () => {
  it("refuses private and plain-http addresses unless the hub allows them", async () => {
    assert.equal(await checkSiemUrl("http://siem.example.com/x", false), "The address must start with https://.");
    assert.equal(await checkSiemUrl("https://127.0.0.1/x", false), "The address must be public.");
    assert.equal(await checkSiemUrl("https://10.1.2.3/x", false), "The address must be public.");
    assert.equal(await checkSiemUrl("https://[::1]/x", false), "The address must be public.");
    assert.equal(await checkSiemUrl("https://user:pw@siem.example.com/x", false), "Put the credentials in the secret, not in the address.");
    assert.equal(await checkSiemUrl("http://127.0.0.1/x", true), null);
  });

  it("streams each company event, signed with HMAC-SHA256, only for the company that set it", async () => {
    assert.equal((await call(maria.token, "PUT", `/v1/companies/${horeca}/security/siem`, { url: siemUrl })).status, 403);
    const set = await call(alex.token, "PUT", `/v1/companies/${horeca}/security/siem`, { url: siemUrl });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const secret: string = set.json.secret;
    assert.ok(secret.length >= 24, "shown once");
    assert.equal((await call(alex.token, "GET", `/v1/companies/${horeca}/security/siem`)).json.secret, undefined);
    await hub.siemIdle();
    siemHits.length = 0;
    const tested = await call(alex.token, "POST", `/v1/companies/${horeca}/security/siem/test`);
    assert.equal(tested.json.lastStatus, "204");
    // Something in Agentia Nord is not streamed to Bistro Ana's SIEM.
    await call(alex.token, "POST", `/v1/companies/${zedzen}/roles`, { name: "Vânzări", permissions: ["chats:vede"] });
    await hub.siemIdle();
    assert.ok(siemHits.length >= 1);
    for (const hit of siemHits) {
      const timestamp = String(hit.headers["x-zen-timestamp"]);
      const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${hit.body}`).digest("hex")}`;
      assert.equal(hit.headers["x-zen-signature"], expected);
      const payload = JSON.parse(hit.body);
      assert.equal(payload.type, "zen.audit");
      assert.equal(payload.event.companyId, horeca);
      assert.match(payload.event.hash, /^[0-9a-f]{64}$/);
    }
    assert.ok(siemHits.some((hit) => JSON.parse(hit.body).event.action === "siem.test"));
    assert.equal((await call(alex.token, "DELETE", `/v1/companies/${horeca}/security/siem`)).status, 200);
  });
});
