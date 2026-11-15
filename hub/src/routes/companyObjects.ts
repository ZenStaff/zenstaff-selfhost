// Company-level objects (v6): AI staff synced through the hub, packs installed for the whole
// company, and the company runner relay that lets any full member reach the company's agents.
//
// AI staff: the profile (name, role, job description, rules, workflows, connectors, memory scope,
// duties) is sealed by the editor's app to every company runner's box key and the write is signed
// by the editor's device. The hub keeps ciphertext, the version, the manager, who and when; it
// checks the signature and the role, and runners check both again against keys they pinned before
// applying anything. Last writer wins: every write must carry a higher version than the stored one.
//
// Company packs: an admin's signed statement (pack id, version, settings, Enterprise flag). Each
// member's app and the runner install or update the pack on their next sync and report their
// status here, so admins see progress and errors per machine.
import type { Kit } from "../app.ts";
import { bad, forbidden, HttpError, type Json, notFound, obj, str } from "../http.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import type { RelayRequest } from "../relay.ts";
import { makeSignedDevice } from "../relaySign.ts";
import { canonicalJson, sha256b64, statementMessage, verifyEd25519 } from "../signing.ts";
import * as store from "../store.ts";
import * as roles from "../storeRbac.ts";
import * as companyStore from "../storeCompany.ts";
import * as dashboard from "../storeDashboard.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";

const STAFF_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
/** One sealed profile: job description, rules and duties fit easily (the app caps them). */
const SEALED_STAFF_MAX = 256_000;
const MAX_STAFF_PER_COMPANY = 500;
const SETTINGS_MAX = 8_000;
const STATEMENT_MAX_AGE_MS = 5 * 60_000;
const RUNNER_TIMEOUT_MS = 60_000;
/** Something that looks like a credential must never be sent as pack settings. */
const SECRET_LIKE = /(sk-[A-Za-z0-9_-]{8,}|sk-ant-|AKIA[0-9A-Z]{12}|ghp_[A-Za-z0-9]{20}|xox[abp]-|[A-Za-z0-9_-]{40,})/;
/**
 * What a member may ask the company runner through the hub, and the permission each op needs on
 * the hub. The runner checks again with the project of the agent (the hub cannot see it inside
 * the sealed input): `staff.task` needs "angajați AI: creează" there; `staff.follow` (v9) reads a
 * runner thread one's own task started (or any, with "urmărește toate"), read-only.
 */
const RUNNER_OPS: ReadonlyMap<string, ReadonlyArray<rbac.Permission>> = new Map([
  ["staff.list", ["angajati:vede"]],
  ["staff.task", ["angajati:creeaza"]],
  ["staff.run", ["angajati:vede"]],
  ["staff.follow", [rbac.FOLLOW_OWN, rbac.FOLLOW_ALL]],
]);
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The scope a company relay request is signed for (the share relay uses the share id). */
export const companyScope = (companyId: string) => `company:${companyId}`;

/** What an editor's device signs for one staff write (same bytes as the app's hub/companySync.ts). */
export function staffStatement(input: {
  readonly companyId: string;
  readonly staffId: string;
  readonly version: number;
  readonly managerUserId: string | null;
  readonly deleted: boolean;
  readonly sealed: Record<string, string>;
  readonly by: string;
  readonly ts: number;
}) {
  return {
    action: "staff.put",
    companyId: input.companyId,
    staffId: input.staffId,
    version: input.version,
    managerUserId: input.managerUserId,
    deleted: input.deleted,
    sealedSha256: sha256b64(canonicalJson(input.sealed)),
    by: input.by,
    ts: input.ts,
  };
}

/** What an admin's device signs to install a pack for the company. */
export function packStatement(input: {
  readonly companyId: string;
  readonly packId: string;
  readonly version: string;
  readonly settings: Record<string, unknown>;
  readonly enterprise: boolean;
  readonly by: string;
  readonly ts: number;
}) {
  return {
    action: "company-pack",
    companyId: input.companyId,
    packId: input.packId,
    version: input.version,
    settings: input.settings,
    enterprise: input.enterprise,
    by: input.by,
    ts: input.ts,
  };
}

export function registerCompanyObjectRoutes(kit: Kit) {
  const { db, route, relay, notifier, requireRole, requirePermission } = kit;
  const signedDevice = makeSignedDevice(db);

  const signerOf = (session: security.SessionInfo) => {
    const signer = security.deviceKeyOfSession(db, session.hash);
    if (signer === null) throw bad("This session has no device key; sign in again from Zen Staff.");
    return signer;
  };
  const freshTs = (body: Json) => {
    const ts = body.ts;
    if (typeof ts !== "number" || Math.abs(Date.now() - ts) > STATEMENT_MAX_AGE_MS) throw bad("The change is too old; try again.");
    return ts;
  };
  const withSigner = <T extends { signerKeyId: string }>(item: T) => {
    const key = security.getDeviceKey(db, item.signerKeyId);
    return {
      ...item,
      signerPublicKey: key?.signPublicKey ?? null,
      // The box key too, so a machine that pins the signer on first use pins the whole device.
      signerBoxPublicKey: key?.boxPublicKey ?? null,
      signerCerts: security.certsOf(db, item.signerKeyId),
    };
  };
  const runnersWithKeys = (companyId: string) =>
    store.runnersOf(db, companyId).map((runner) => ({
      environmentId: runner.id,
      name: runner.name,
      online: relay.isOnline(runner.id),
      keys: team.environmentKeys(db, runner.id),
    }));

  // ---- AI staff --------------------------------------------------------------------------------

  /** Sealed profiles with their signed statements, and the runners to seal new versions to. */
  route("GET", "/v1/companies/:id/staff", ({ session, params }) => {
    const companyId = params.id!;
    if (!policy.canUseStaff(requireRole(companyId, session.user.id))) throw forbidden("Guests do not see the company's AI staff.");
    requirePermission(companyId, session.user.id, "angajati:vede");
    return {
      staff: companyStore.staffOf(db, companyId).map(withSigner),
      runners: runnersWithKeys(companyId),
    };
  });

  route("PUT", "/v1/companies/:id/staff/:staffId", ({ session, params, body }) => {
    const companyId = params.id!;
    const staffId = params.staffId!;
    const user = session.user;
    const myRole = requireRole(companyId, user.id);
    if (!STAFF_ID.test(staffId)) throw bad("Unknown AI employee.");
    const version = body.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1_000_000_000) {
      throw bad("version must be a whole number.");
    }
    const deleted = body.deleted === true;
    const managerUserId = body.managerUserId === null || body.managerUserId === undefined ? null : str(body, "managerUserId", 80);
    if (managerUserId !== null && store.roleOf(db, companyId, managerUserId) === null) throw notFound("The manager is not a member of this company.");
    const sealedRaw = obj(body, "sealed");
    const runnerIds = new Set(store.runnersOf(db, companyId).map((runner) => runner.id));
    const sealed: Record<string, string> = {};
    for (const [environmentId, value] of Object.entries(sealedRaw)) {
      if (!runnerIds.has(environmentId)) throw bad("A profile can only be sealed to this company's runners.");
      if (typeof value !== "string" || value.length === 0 || value.length > SEALED_STAFF_MAX) throw bad("The sealed profile is not valid.");
      sealed[environmentId] = value;
    }
    if (deleted && Object.keys(sealed).length > 0) throw bad("A deleted AI employee keeps no profile.");
    if (!deleted && Object.keys(sealed).length === 0) {
      throw bad("The company has no runner to keep this AI employee. Make a machine the company runner first.");
    }
    const existing = companyStore.getStaff(db, companyId, staffId);
    const projectId =
      body.projectId === undefined ? (existing?.projectId ?? null) : body.projectId === null ? null : str(body, "projectId", 100);
    if (projectId !== null && !SCOPE_ID.test(projectId)) throw bad("Unknown project.");
    if (existing === null && companyStore.staffOf(db, companyId).length >= MAX_STAFF_PER_COMPANY) {
      throw bad("This company has too many AI employees.");
    }
    // v9: besides owners, admins and the agent's manager, a role with "angajați AI: administrează"
    // (for the company, or for the agent's project / team before and after the change).
    const access = roles.accessOf(db, companyId, user.id);
    const administers = (project: string | null) => rbac.can(access, "angajati:administreaza", roles.scopeOfProject(db, companyId, project));
    const allowed =
      (policy.canEditStaff({
        role: myRole,
        actorUserId: user.id,
        existing: existing === null ? null : { managerUserId: existing.managerUserId, deleted: existing.deletedAt !== null },
        managerUserId,
        deleted,
      }) &&
        (policy.canManageCompany(myRole) || existing?.projectId === projectId)) ||
      (policy.isFullMember(myRole) && administers(projectId) && (existing === null || administers(existing.projectId)));
    if (!allowed) throw forbidden("Only owners, admins and the agent's manager can change an AI employee.");
    if (existing !== null && version <= existing.version) {
      throw new HttpError(409, `Someone saved a newer version (${existing.version}). Load it and save again.`);
    }
    const signer = signerOf(session);
    const ts = freshTs(body);
    const statement = staffStatement({ companyId, staffId, version, managerUserId, deleted, sealed, by: user.id, ts });
    const signature = str(body, "signature", 200);
    if (!verifyEd25519(signer.signPublicKey, statementMessage(statement), signature)) throw bad("The change is not signed by this device.");
    companyStore.putStaff(db, {
      companyId,
      staffId,
      version,
      managerUserId,
      sealed,
      statement: canonicalJson(statement),
      signerKeyId: signer.keyId,
      signature,
      updatedBy: user.id,
      deleted,
      projectId,
    });
    const action = deleted ? "staff.delete" : existing === null || existing.deletedAt !== null ? "staff.create" : "staff.update";
    const summary =
      action === "staff.delete"
        ? `An AI employee was removed (${staffId})`
        : action === "staff.create"
          ? `A new AI employee was added for the whole company (${staffId})`
          : `An AI employee's profile changed (${staffId}, version ${version})`;
    // Every change is in the audit log; creating and removing one are also e-mailed to admins.
    if (action === "staff.update") team.audit(db, { companyId, actorUserId: user.id, action, detail: summary, target: `staff:${staffId}`, meta: { version } });
    else notifier.adminAction({ companyId, actorUserId: user.id, action, summary });
    return { staffId, version };
  });

  // ---- Company runner relay -------------------------------------------------------------------

  /**
   * A member asks the company runner (the list of AI staff, or a task for one of them). Signed by
   * the member's device and sealed to the runner like the share relay; the hub only routes.
   */
  route("POST", "/v1/companies/:id/runner", async ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canUseStaff(requireRole(companyId, session.user.id))) throw forbidden("Guests cannot use the company's AI staff.");
    const op = str(body, "op", 40);
    const needs = RUNNER_OPS.get(op);
    if (needs === undefined) throw bad("Unknown request.");
    const actorAccess = roles.accessOf(db, companyId, session.user.id);
    // Somewhere in the company (scoped roles count): the runner checks the agent's own project.
    if (!needs.some((permission) => rbac.canSomewhere(actorAccess, permission))) {
      throw new HttpError(403, `Your role does not allow this (${rbac.describePermission(needs[0]!)}).`, "permission_denied");
    }
    // perms-fine: a task names its AI employee in clear (the text stays sealed), so a role scoped
    // to a project is refused here for another project's agent; the runner checks it again
    // against the agent's signed profile.
    if (op === "staff.task" && body.staffId !== undefined && body.staffId !== null) {
      const staffId = str(body, "staffId", 80);
      if (!STAFF_ID.test(staffId)) throw bad("Unknown AI employee.");
      const staff = companyStore.getStaff(db, companyId, staffId);
      if (staff === null || staff.deletedAt !== null) throw notFound("No such AI employee.");
      if (!needs.some((permission) => rbac.can(actorAccess, permission, roles.scopeOfProject(db, companyId, staff.projectId)))) {
        throw new HttpError(403, `Your role does not allow tasks for this AI employee (${rbac.describePermission(needs[0]!)}).`, "permission_denied");
      }
    }
    const input = obj(body, "input");
    const { sig, device } = signedDevice(session, op, companyScope(companyId), input, body.sig);
    // The app seals to one runner's key, so it names that runner; otherwise the first one online.
    const wanted = body.environmentId === undefined || body.environmentId === null ? null : str(body, "environmentId", 80);
    const runner = store
      .runnersOf(db, companyId)
      .find((candidate) => (wanted === null || candidate.id === wanted) && relay.isOnline(candidate.id));
    if (runner === undefined) throw new HttpError(503, "The company runner is offline right now. Its owner should open Zen Staff on it.");
    // Counted per day and op for the dashboard's weekly activity (the hub routes it anyway).
    dashboard.countRunnerCall(db, companyId, op);
    const request: RelayRequest = {
      op,
      shareId: companyScope(companyId),
      threadId: "",
      shareKind: "company",
      companyId,
      actor: { userId: session.user.id, email: session.user.email, name: session.user.name },
      // Team scopes listed per project: the runner checks the agent's project only.
      actorAccess: roles.accessForClients(db, companyId, session.user.id),
      input,
      sig,
      device,
    };
    // A task given through the hub is in the audit log (metadata only: op and runner, never the text).
    if (op === "staff.task") team.audit(db, { companyId, actorUserId: session.user.id, action: "runner.task.request", detail: "A task was sent to the company's AI staff", target: `env:${runner.id}` });
    const result = await relay.call(runner.id, request, RUNNER_TIMEOUT_MS);
    return { environmentId: runner.id, result };
  });

  // ---- Company packs --------------------------------------------------------------------------

  route("GET", "/v1/companies/:id/packs", ({ session, params }) => {
    const companyId = params.id!;
    const { role: myRole } = requirePermission(companyId, session.user.id, "pachete:vede");
    return {
      packs: companyStore.packsOf(db, companyId).map(withSigner),
      status: companyStore.packStatusOf(db, companyId, policy.canSeeAllPackStatus(myRole) ? null : session.user.id),
    };
  });

  route("PUT", "/v1/companies/:id/packs/:packId", ({ session, params, body }) => {
    const companyId = params.id!;
    const packId = params.packId!;
    const user = session.user;
    if (!policy.canManageCompanyPacks(requirePermission(companyId, user.id, "pachete:administreaza").role)) throw forbidden("Only owners and admins install packs for the whole company.");
    if (!PACK_ID.test(packId)) throw bad("Unknown pack.");
    const version = str(body, "version", 40);
    if (!VERSION.test(version)) throw bad("Unknown pack version.");
    const settings = body.settings === undefined ? {} : obj(body, "settings");
    const settingsText = canonicalJson(settings);
    if (settingsText.length > SETTINGS_MAX) throw bad("The pack settings are too long.");
    if (SECRET_LIKE.test(settingsText)) throw bad("Do not send keys to the hub. Secrets stay on the company runner.");
    const enterprise = body.enterprise === true;
    const signer = signerOf(session);
    const ts = freshTs(body);
    const statement = packStatement({ companyId, packId, version, settings, enterprise, by: user.id, ts });
    const signature = str(body, "signature", 200);
    if (!verifyEd25519(signer.signPublicKey, statementMessage(statement), signature)) throw bad("The change is not signed by this device.");
    const updating = companyStore.hasPack(db, companyId, packId);
    companyStore.putPack(db, {
      companyId,
      packId,
      version,
      settings,
      enterprise,
      statement: canonicalJson(statement),
      signerKeyId: signer.keyId,
      signature,
      updatedBy: user.id,
    });
    notifier.adminAction({
      companyId,
      actorUserId: user.id,
      action: updating ? "pack.update" : "pack.install",
      summary: updating
        ? `The company pack ${packId} now uses version ${version}`
        : `The pack ${packId} ${version} was installed for the whole company${enterprise ? " (Enterprise: on the company runner only)" : ""}`,
    });
    return { packId, version };
  });

  /** Stops installing the pack for everyone; copies already installed stay and become removable. */
  route("DELETE", "/v1/companies/:id/packs/:packId", ({ session, params }) => {
    const companyId = params.id!;
    if (!policy.canManageCompanyPacks(requirePermission(companyId, session.user.id, "pachete:administreaza").role)) throw forbidden();
    if (!companyStore.removePack(db, companyId, params.packId!)) throw notFound("This pack is not installed for the company.");
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "pack.remove",
      summary: `The pack ${params.packId!} is no longer installed for the whole company`,
    });
    return { ok: true };
  });

  /** One machine's install status for one company pack (its own machines only). */
  route("POST", "/v1/companies/:id/packs/:packId/status", ({ session, params, body }) => {
    const companyId = params.id!;
    const packId = params.packId!;
    requireRole(companyId, session.user.id);
    if (!companyStore.hasPack(db, companyId, packId)) throw notFound("This pack is not installed for the company.");
    const environmentId = str(body, "environmentId", 80);
    const environment = store.getEnvironment(db, environmentId);
    if (environment === null || environment.ownerUserId !== session.user.id) throw notFound("No such machine.");
    const state = body.state as companyStore.PackState;
    if (!companyStore.PACK_STATES.includes(state)) throw bad("Unknown state.");
    const version = body.version === null || body.version === undefined ? null : str(body, "version", 40);
    const error = body.error === null || body.error === undefined ? null : str(body, "error", 500);
    companyStore.setPackStatus(db, {
      companyId,
      packId,
      environmentId,
      userId: session.user.id,
      state,
      version,
      error,
      hidden: body.hidden === true,
    });
    return { ok: true };
  });
}
