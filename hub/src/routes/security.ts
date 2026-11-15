// Enterprise security (v9): custom roles and who holds them, teams and projects for scoped roles,
// the tamper-evident audit log (search, export, verify), the per-company SIEM stream, and the
// metadata runners report about their work (tasks started / finished, approvals decided).
import { randomBytes } from "node:crypto";

import type { Kit } from "../app.ts";
import { syncMemoryAccess } from "./memoryHosted.ts";
import { anchorsOf, toCsv, verifyChain, type AuditEvent } from "../auditChain.ts";
import { bad, clientIp, forbidden, HttpError, type Json, makeLimiter, notFound, optStr, str } from "../http.ts";
import * as rbac from "../rbac.ts";
import { checkSiemUrl, removeSiem, setSiem, siemOf } from "../siem.ts";
import * as store from "../store.ts";
import { isUserSuspended } from "../storeAdmin.ts";
import * as roles from "../storeRbac.ts";

const ROLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._&()+-]{0,47}$/u;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const META_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
const MAX_ROLES = 50;
const MAX_TEAMS = 100;
const MAX_PROJECTS = 500;
const MAX_SCOPED = 50;
/** What a runner may report (metadata only: never a prompt, a message or a file). */
const RUNNER_EVENTS = new Set(["runner.task.start", "runner.task.finish", "runner.chat.start", "approval.decided", "runner.follow"]);
const RUNNER_META = ["staffId", "runId", "threadId", "decision", "status", "kind", "permission", "trigger"] as const;

export const CATALOG = {
  resources: rbac.RESOURCES,
  actions: rbac.ACTIONS,
  extras: rbac.EXTRA_PERMISSIONS,
  defaults: rbac.DEFAULT_PERMISSIONS,
};

function dateParam(value: string | null, name: string): string | null {
  if (value === null || value === "") return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw bad(`${name} must be a date.`);
  return date.toISOString();
}

export function registerSecurityRoutes(kit: Kit) {
  const { db, route, notifier, requireRole, requirePermission, auditLog, siem, box, config } = kit;
  const perRunner = makeLimiter(600, 60 * 60_000, "Too many reports from this runner.");

  const requireRoleEditor = (companyId: string, userId: string) => {
    const role = requireRole(companyId, userId);
    if (!rbac.canEditRoles(role)) throw forbidden("Only owners and admins define roles.");
    return role;
  };

  const permissionsOf = (body: Json) => {
    const permissions = rbac.cleanPermissions(body.permissions);
    if (permissions === null) throw bad("permissions must be a list of known permissions.");
    return permissions;
  };

  const roleName = (body: Json, companyId: string, exceptId: string | null) => {
    const name = str(body, "name", 48);
    if (!ROLE_NAME.test(name) || name.toLowerCase().startsWith("builtin")) throw bad("Give the role a short name (letters, digits, spaces).");
    if (roles.roleNameTaken(db, companyId, name, exceptId)) throw bad("A role with this name already exists.");
    return name;
  };

  const describeMembers = (companyId: string) => {
    const assignments = new Map(roles.assignmentsOf(db, companyId).map((row) => [row.userId, row]));
    return store.membersOf(db, companyId).map((member) => {
      const row = assignments.get(member.userId);
      return {
        userId: member.userId,
        name: member.name,
        email: member.email,
        role: member.role,
        customRoleId: row?.customRoleId ?? null,
        scoped: row?.scoped ?? [],
        access: roles.accessOf(db, companyId, member.userId),
      };
    });
  };

  // ---- My access ------------------------------------------------------------------------------

  /** What I may do here: the app and the dashboard hide or disable the rest. */
  route("GET", "/v1/companies/:id/access", ({ session, params }) => {
    const role = requireRole(params.id!, session.user.id);
    return { role, access: roles.accessForClients(db, params.id!, session.user.id), catalog: CATALOG };
  });

  // ---- Roles ----------------------------------------------------------------------------------

  route("GET", "/v1/companies/:id/roles", ({ session, params }) => {
    const companyId = params.id!;
    const { role } = requirePermission(companyId, session.user.id, "echipa:vede");
    return {
      catalog: CATALOG,
      roles: roles.rolesOf(db, companyId),
      members: describeMembers(companyId),
      teams: roles.teamsOf(db, companyId),
      projects: roles.projectsOf(db, companyId),
      canEdit: rbac.canEditRoles(role),
    };
  });

  route("POST", "/v1/companies/:id/roles", ({ session, params, body }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    if (roles.rolesOf(db, companyId).filter((role) => role.custom).length >= MAX_ROLES) throw bad("This company has too many roles.");
    const name = roleName(body, companyId, null);
    const description = optStr(body, "description", 200) ?? "";
    const permissions = permissionsOf(body);
    const id = roles.createRole(db, { companyId, name, description, permissions, by: session.user.id });
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "role.create",
      summary: `New role "${name}" (${permissions.length} permissions)`,
    });
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "role.permissions", target: `role:${id}`, detail: { name, permissions } });
    void syncMemoryAccess(kit, companyId);
    return { id };
  });

  route("PUT", "/v1/companies/:id/roles/:roleId", ({ session, params, body }) => {
    const companyId = params.id!;
    const roleId = params.roleId!;
    requireRoleEditor(companyId, session.user.id);
    const permissions = permissionsOf(body);
    if (roleId === "owner" || roleId === "admin") throw bad("Owner and Admin always have every permission.");
    if (roleId === "member" || roleId === "guest") {
      const before = roles.rolesOf(db, companyId).find((role) => role.id === roleId)!.permissions;
      roles.setBuiltinPermissions(db, companyId, roleId, permissions, session.user.id);
      notifier.adminAction({
        companyId,
        actorUserId: session.user.id,
        action: "role.update",
        summary: `The built-in role ${roleId === "member" ? "Membru" : "Invitat"} changed`,
      });
      kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "role.permissions", target: `role:${roleId}`, detail: { before, after: permissions } });
      void syncMemoryAccess(kit, companyId);
      return { ok: true };
    }
    const existing = roles.getCustomRole(db, companyId, roleId);
    if (existing === null) throw notFound("No such role.");
    const name = body.name === undefined ? existing.name : roleName(body, companyId, roleId);
    const description = body.description === undefined ? existing.description : (optStr(body, "description", 200) ?? "");
    roles.updateRole(db, { companyId, roleId, name, description, permissions });
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "role.update", summary: `The role "${name}" changed` });
    kit.auditLog.append({
      companyId,
      actorUserId: session.user.id,
      action: "role.permissions",
      target: `role:${roleId}`,
      detail: { name, before: existing.permissions, after: permissions },
    });
    void syncMemoryAccess(kit, companyId);
    return { ok: true };
  });

  route("DELETE", "/v1/companies/:id/roles/:roleId", ({ session, params }) => {
    const companyId = params.id!;
    const roleId = params.roleId!;
    requireRoleEditor(companyId, session.user.id);
    if (roleId === "member" || roleId === "guest") {
      roles.setBuiltinPermissions(db, companyId, roleId, null, session.user.id);
      notifier.adminAction({ companyId, actorUserId: session.user.id, action: "role.reset", summary: `The built-in role ${roleId === "member" ? "Membru" : "Invitat"} is back to its defaults` });
      void syncMemoryAccess(kit, companyId);
      return { ok: true };
    }
    const existing = roles.getCustomRole(db, companyId, roleId);
    if (existing === null || !roles.deleteRole(db, companyId, roleId)) throw notFound("No such role.");
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "role.delete", summary: `The role "${existing.name}" was deleted; its people are back on their built-in role` });
    void syncMemoryAccess(kit, companyId);
    return { ok: true };
  });

  /** Who holds which role: one company-wide custom role and any scoped roles (members and guests). */
  route("PUT", "/v1/companies/:id/members/:userId/access", ({ session, params, body }) => {
    const companyId = params.id!;
    const userId = params.userId!;
    requireRoleEditor(companyId, session.user.id);
    const targetRole = store.roleOf(db, companyId, userId);
    if (targetRole === null) throw notFound("No such member.");
    if (targetRole === "owner" || targetRole === "admin") throw bad("Owners and admins already have every permission.");
    const customRoleId = body.customRoleId === null || body.customRoleId === undefined ? null : str(body, "customRoleId", 80);
    if (customRoleId !== null && roles.getCustomRole(db, companyId, customRoleId) === null) throw notFound("No such role.");
    const rawScoped = body.scoped ?? [];
    if (!Array.isArray(rawScoped) || rawScoped.length > MAX_SCOPED) throw bad("scoped must be a short list.");
    const scoped = rawScoped.map((item: unknown) => {
      const entry = (item ?? {}) as Json;
      const roleId = str(entry, "roleId", 80);
      const kind = entry.kind === "team" || entry.kind === "project" ? entry.kind : null;
      const id = str(entry, "id", 100);
      if (kind === null || !SCOPE_ID.test(id)) throw bad("Each scoped role needs a project or a team.");
      if (roles.getCustomRole(db, companyId, roleId) === null) throw notFound("No such role.");
      if (kind === "team" && !roles.teamExists(db, companyId, id)) throw notFound("No such team.");
      if (kind === "project" && !roles.projectExists(db, companyId, id)) throw notFound("No such project.");
      return { roleId, kind, id } satisfies rbac.ScopedGrant;
    });
    const before = roles.accessOf(db, companyId, userId);
    roles.setMemberAccess(db, { companyId, userId, customRoleId, scoped });
    const after = roles.accessOf(db, companyId, userId);
    const name = store.getUser(db, userId)?.name ?? "someone";
    const roleLabel = customRoleId === null ? (targetRole === "member" ? "Membru" : "Invitat") : roles.getCustomRole(db, companyId, customRoleId)!.name;
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "member.access",
      summary: `${name} now has the role ${roleLabel}${scoped.length > 0 ? ` and ${scoped.length} scoped role(s)` : ""}`,
      alsoUserIds: [userId],
    });
    kit.auditLog.append({
      companyId,
      actorUserId: session.user.id,
      action: "member.permissions",
      target: `user:${userId}`,
      detail: { customRoleId, scoped, before: before?.permissions ?? [], after: after?.permissions ?? [] },
    });
    void syncMemoryAccess(kit, companyId);
    return { ok: true, access: after };
  });

  // ---- Teams and projects (scopes) ------------------------------------------------------------

  route("POST", "/v1/companies/:id/teams", ({ session, params, body }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    const name = str(body, "name", 60);
    if (roles.teamsOf(db, companyId).length >= MAX_TEAMS) throw bad("This company has too many teams.");
    if (roles.teamNameTaken(db, companyId, name)) throw bad("A team with this name already exists.");
    const id = roles.createTeam(db, companyId, name);
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "team.create", target: `team:${id}`, detail: { name } });
    void syncMemoryAccess(kit, companyId);
    return { id };
  });

  route("DELETE", "/v1/companies/:id/teams/:teamId", ({ session, params }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    if (!roles.deleteTeam(db, companyId, params.teamId!)) throw notFound("No such team.");
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "team.delete", target: `team:${params.teamId!}`, detail: {} });
    void syncMemoryAccess(kit, companyId);
    return { ok: true };
  });

  /** A project the company's roles can be scoped to (its id is the app's project id). */
  route("PUT", "/v1/companies/:id/projects/:projectId", ({ session, params, body }) => {
    const companyId = params.id!;
    const projectId = params.projectId!;
    requireRoleEditor(companyId, session.user.id);
    if (!SCOPE_ID.test(projectId)) throw bad("Unknown project.");
    if (!roles.projectExists(db, companyId, projectId) && roles.projectsOf(db, companyId).length >= MAX_PROJECTS) throw bad("This company has too many projects.");
    const teamId = optStr(body, "teamId", 80);
    if (teamId !== null && !roles.teamExists(db, companyId, teamId)) throw notFound("No such team.");
    const name = str(body, "name", 80);
    roles.putProject(db, { companyId, projectId, name, teamId });
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "project.put", target: `project:${projectId}`, detail: { name, teamId } });
    void syncMemoryAccess(kit, companyId);
    return { ok: true };
  });

  route("DELETE", "/v1/companies/:id/projects/:projectId", ({ session, params }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    if (!roles.deleteProject(db, companyId, params.projectId!)) throw notFound("No such project.");
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "project.delete", target: `project:${params.projectId!}`, detail: {} });
    void syncMemoryAccess(kit, companyId);
    return { ok: true };
  });

  // ---- The audit log ----------------------------------------------------------------------------

  const searchInput = (companyId: string, query: URLSearchParams, limit: number) => ({
    companyId,
    actor: query.get("actor")?.trim().slice(0, 120) || null,
    action: query.get("action")?.trim().slice(0, 80) || null,
    from: dateParam(query.get("from"), "from"),
    // "to" as a day includes that whole day.
    to: (() => {
      const raw = query.get("to");
      const iso = dateParam(raw, "to");
      return iso !== null && raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(Date.parse(iso) + 86_400_000).toISOString() : iso;
    })(),
    before: query.get("before") === null ? null : Number(query.get("before")) || null,
    limit,
  });

  const present = (event: AuditEvent) => ({
    seq: event.seq,
    chainSeq: event.chainSeq,
    id: event.id,
    ts: event.ts,
    action: event.action,
    actorUserId: event.actorUserId,
    actorEmail: event.actorEmail,
    actorName: event.actorName,
    target: event.target,
    detail: event.detail,
    ip: event.ip,
    deviceId: event.deviceId,
    userAgent: event.userAgent,
    prevHash: event.prevHash,
    hash: event.hash,
  });

  route("GET", "/v1/companies/:id/security/log", ({ session, params, query }) => {
    const companyId = params.id!;
    requirePermission(companyId, session.user.id, "echipa:administreaza");
    const limit = Math.max(1, Math.min(Number(query.get("limit") ?? 100) || 100, 500));
    const events = auditLog.search(searchInput(companyId, query, limit));
    return {
      events: events.map(present),
      next: events.length === limit ? (events.at(-1)?.seq ?? null) : null,
      actions: auditLog.actions(companyId),
      people: store.membersOf(db, companyId).map((member) => ({ userId: member.userId, name: member.name, email: member.email })),
    };
  });

  route("GET", "/v1/companies/:id/security/log/export", ({ session, params, query }) => {
    const companyId = params.id!;
    requirePermission(companyId, session.user.id, "echipa:administreaza");
    const format = query.get("format") === "csv" ? "csv" : "json";
    const events = auditLog.search(searchInput(companyId, query, 10_000)).toReversed();
    kit.auditLog.append({
      companyId,
      actorUserId: session.user.id,
      action: "audit.export",
      detail: { format, rows: events.length, filters: { actor: query.get("actor"), action: query.get("action"), from: query.get("from"), to: query.get("to") } },
    });
    const day = new Date().toISOString().slice(0, 10);
    const filename = `jurnal-${companyId}-${day}.${format}`;
    if (format === "csv") return { filename, contentType: "text/csv; charset=utf-8", body: toCsv(events) };
    return {
      filename,
      contentType: "application/json",
      body: JSON.stringify({ companyId, exportedAt: new Date().toISOString(), algorithm: "sha256(prev_hash + canonical_json(row))", events: events.map(present) }, null, 2),
    };
  });

  route("GET", "/v1/companies/:id/security/log/verify", ({ session, params }) => {
    const companyId = params.id!;
    requirePermission(companyId, session.user.id, "echipa:administreaza");
    const anchors = anchorsOf(db, companyId);
    return { ...verifyChain(auditLog.db, companyId, anchors), anchors: anchors.slice(-30) };
  });

  // ---- SIEM stream --------------------------------------------------------------------------------

  const presentSiem = (companyId: string) => {
    const config = siemOf(db, companyId);
    if (config === null) return { configured: false };
    const { secret: _secret, ...rest } = config;
    return { configured: true, ...rest };
  };

  route("GET", "/v1/companies/:id/security/siem", ({ session, params }) => {
    requirePermission(params.id!, session.user.id, "echipa:administreaza");
    return presentSiem(params.id!);
  });

  route("PUT", "/v1/companies/:id/security/siem", async ({ session, params, body }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    const url = str(body, "url", 500);
    const problem = await checkSiemUrl(url, config.siemAllowPrivate === true);
    if (problem !== null) throw bad(problem);
    const given = optStr(body, "secret", 200);
    if (given !== null && given.length < 16) throw bad("The secret must have at least 16 characters.");
    const existing = siemOf(db, companyId);
    // A new secret is shown once; an existing one is kept unless a new one is given.
    const secret = given ?? (existing === null ? randomBytes(24).toString("base64url") : null);
    setSiem(db, {
      companyId,
      url,
      secretSealed: secret === null ? existing!.secret : box.seal(secret),
      enabled: body.enabled !== false,
      by: session.user.id,
    });
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "siem.set", summary: `The audit log is now streamed to ${new URL(url).host}` });
    return { ...presentSiem(companyId), ...(secret !== null && given === null ? { secret } : {}) };
  });

  route("DELETE", "/v1/companies/:id/security/siem", ({ session, params }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    if (!removeSiem(db, companyId)) throw notFound("No SIEM is configured.");
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "siem.remove", summary: "The audit log is no longer streamed to a SIEM" });
    return { ok: true };
  });

  route("POST", "/v1/companies/:id/security/siem/test", async ({ session, params }) => {
    const companyId = params.id!;
    requireRoleEditor(companyId, session.user.id);
    if (siemOf(db, companyId) === null) throw notFound("No SIEM is configured.");
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "siem.test", detail: { summary: "Test event" } });
    await Promise.race([siem.idle(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
    return presentSiem(companyId);
  });

  // ---- Runner reports (metadata only) ---------------------------------------------------------------

  /**
   * A company runner reports what happened on it: a task started or finished, an approval decided,
   * a member following a thread. Only for companies it serves; only ids and short states.
   */
  route(
    "POST",
    "/v1/runner/audit",
    ({ req, body }) => {
      const header = req.headers.authorization ?? "";
      const credential = header.startsWith("Runner ") ? header.slice(7).trim() : "";
      const environment = credential === "" ? null : store.environmentForCredential(db, credential);
      // A machine of a suspended account (platform admin) is refused like an unknown one.
      if (environment === null || isUserSuspended(db, environment.ownerUserId)) throw new HttpError(401, "Unknown runner credential.", "runner_signed_out");
      const companyId = str(body, "companyId", 80);
      if (!environment.runnerCompanyIds.includes(companyId)) throw forbidden("This runner does not serve that company.");
      const events = body.events;
      if (!Array.isArray(events) || events.length === 0 || events.length > 50) throw bad("Send 1 to 50 events.");
      perRunner(`env:${environment.id}`);
      let written = 0;
      for (const raw of events) {
        const entry = (raw ?? {}) as Json;
        const action = typeof entry.action === "string" ? entry.action : "";
        if (!RUNNER_EVENTS.has(action)) throw bad("Unknown runner event.");
        const actorUserId = entry.actorUserId === undefined || entry.actorUserId === null ? null : str(entry, "actorUserId", 80);
        // The person must belong to the company; otherwise the event is the runner's own.
        const actor = actorUserId !== null && store.roleOf(db, companyId, actorUserId) !== null ? store.getUser(db, actorUserId) : null;
        const detail: Record<string, string> = {};
        for (const key of RUNNER_META) {
          const value = entry[key];
          if (value === undefined || value === null) continue;
          if (typeof value !== "string" || !META_ID.test(value)) throw bad(`${key} must be a short id.`);
          detail[key] = value;
        }
        auditLog.append({
          companyId,
          actorUserId: actor?.id ?? null,
          actorEmail: actor?.email ?? null,
          actorName: actor?.name ?? null,
          action,
          target: detail.runId === undefined ? null : `run:${detail.runId}`,
          detail: { ...detail, runner: environment.id, runnerName: environment.name },
          ip: clientIp(req),
          deviceId: `env:${environment.id}`,
        });
        written += 1;
      }
      return { ok: true, written };
    },
    "public",
  );
}
