// Custom roles, role assignments, teams and projects (v9). The rules live in rbac.ts; this module
// only reads and writes the tables and builds a person's `Access`.
import { newId } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Role } from "./policy.ts";
import * as rbac from "./rbac.ts";

const nowIso = () => new Date().toISOString();

interface RoleRow {
  id: string;
  company_id: string;
  builtin: "member" | "guest" | null;
  name: string;
  description: string;
  permissions: string;
  updated_at: string;
}

const toRole = (row: RoleRow): rbac.RoleDef & { readonly updatedAt: string } => ({
  id: row.builtin ?? row.id,
  name: row.name,
  description: row.description,
  permissions: rbac.cleanPermissions(JSON.parse(row.permissions)) ?? [],
  builtin: row.builtin,
  updatedAt: row.updated_at,
});

/** The built-in roles (with this company's Membru / Invitat changes) followed by its custom roles. */
export function rolesOf(db: Db, companyId: string): Array<rbac.RoleDef & { readonly custom: boolean; readonly memberCount: number }> {
  const rows = db.prepare("SELECT * FROM company_roles WHERE company_id = ? ORDER BY name").all(companyId) as unknown as Array<RoleRow>;
  const overrides: Partial<Record<"member" | "guest", ReadonlyArray<rbac.Permission>>> = {};
  for (const row of rows) if (row.builtin !== null) overrides[row.builtin] = toRole(row).permissions;
  const counts = new Map<string, number>();
  for (const row of db
    .prepare("SELECT COALESCE(custom_role_id, role) AS key, COUNT(*) AS n FROM memberships WHERE company_id = ? GROUP BY key")
    .all(companyId) as Array<{ key: string; n: number }>) {
    counts.set(row.key, row.n);
  }
  for (const row of db
    .prepare("SELECT role_id AS key, COUNT(DISTINCT user_id) AS n FROM member_scoped_roles WHERE company_id = ? GROUP BY role_id")
    .all(companyId) as Array<{ key: string; n: number }>) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + row.n);
  }
  return [
    ...rbac.builtinRoles(overrides).map((role) => ({ ...role, custom: false, memberCount: counts.get(role.id) ?? 0 })),
    ...rows.filter((row) => row.builtin === null).map((row) => ({ ...toRole(row), custom: true, memberCount: counts.get(row.id) ?? 0 })),
  ];
}

export function getCustomRole(db: Db, companyId: string, roleId: string) {
  const row = db.prepare("SELECT * FROM company_roles WHERE company_id = ? AND id = ? AND builtin IS NULL").get(companyId, roleId) as
    | RoleRow
    | undefined;
  return row === undefined ? null : toRole(row);
}

export function roleNameTaken(db: Db, companyId: string, name: string, exceptId: string | null): boolean {
  const row = db
    .prepare("SELECT id, builtin FROM company_roles WHERE company_id = ? AND lower(name) = lower(?)")
    .get(companyId, name) as { id: string; builtin: string | null } | undefined;
  const reserved = ["owner", "admin", "membru", "member", "invitat", "guest"].includes(name.toLowerCase());
  return reserved || (row !== undefined && row.builtin === null && row.id !== exceptId);
}

export function createRole(db: Db, input: { companyId: string; name: string; description: string; permissions: ReadonlyArray<rbac.Permission>; by: string }) {
  const id = newId("role");
  const now = nowIso();
  db.prepare(
    "INSERT INTO company_roles (id, company_id, builtin, name, description, permissions, created_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.companyId, input.name, input.description, JSON.stringify(input.permissions), input.by, now, now);
  return id;
}

export function updateRole(db: Db, input: { companyId: string; roleId: string; name: string; description: string; permissions: ReadonlyArray<rbac.Permission> }) {
  db.prepare("UPDATE company_roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE company_id = ? AND id = ? AND builtin IS NULL").run(
    input.name,
    input.description,
    JSON.stringify(input.permissions),
    nowIso(),
    input.companyId,
    input.roleId,
  );
}

/** Changes the permissions of Membru or Invitat in this company; null goes back to the defaults. */
export function setBuiltinPermissions(db: Db, companyId: string, builtin: "member" | "guest", permissions: ReadonlyArray<rbac.Permission> | null, by: string) {
  if (permissions === null) {
    db.prepare("DELETE FROM company_roles WHERE company_id = ? AND builtin = ?").run(companyId, builtin);
    return;
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO company_roles (id, company_id, builtin, name, description, permissions, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
     ON CONFLICT (company_id, builtin) WHERE builtin IS NOT NULL DO UPDATE SET permissions = excluded.permissions, updated_at = excluded.updated_at`,
  ).run(newId("role"), companyId, builtin, `builtin:${builtin}`, JSON.stringify(permissions), by, now, now);
}

export function deleteRole(db: Db, companyId: string, roleId: string): boolean {
  return Number(db.prepare("DELETE FROM company_roles WHERE company_id = ? AND id = ? AND builtin IS NULL").run(companyId, roleId).changes) > 0;
}

// ---- Assignments ---------------------------------------------------------------------------------

export interface MemberAccessRow {
  readonly userId: string;
  readonly role: Role;
  readonly customRoleId: string | null;
  readonly scoped: ReadonlyArray<rbac.ScopedGrant>;
}

export function assignmentsOf(db: Db, companyId: string): Array<MemberAccessRow> {
  const scoped = db
    .prepare("SELECT user_id, role_id, scope_kind, scope_id FROM member_scoped_roles WHERE company_id = ? ORDER BY created_at")
    .all(companyId) as Array<{ user_id: string; role_id: string; scope_kind: rbac.ScopeKind; scope_id: string }>;
  return (db.prepare("SELECT user_id, role, custom_role_id FROM memberships WHERE company_id = ?").all(companyId) as Array<{
    user_id: string;
    role: Role;
    custom_role_id: string | null;
  }>).map((row) => ({
    userId: row.user_id,
    role: row.role,
    customRoleId: row.custom_role_id,
    scoped: scoped.filter((grant) => grant.user_id === row.user_id).map((grant) => ({ roleId: grant.role_id, kind: grant.scope_kind, id: grant.scope_id })),
  }));
}

export function setMemberAccess(db: Db, input: { companyId: string; userId: string; customRoleId: string | null; scoped: ReadonlyArray<rbac.ScopedGrant> }) {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE memberships SET custom_role_id = ? WHERE company_id = ? AND user_id = ?").run(input.customRoleId, input.companyId, input.userId);
    db.prepare("DELETE FROM member_scoped_roles WHERE company_id = ? AND user_id = ?").run(input.companyId, input.userId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO member_scoped_roles (company_id, user_id, role_id, scope_kind, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const grant of input.scoped) insert.run(input.companyId, input.userId, grant.roleId, grant.kind, grant.id, nowIso());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Owners and admins have every permission: a custom role on them would only mislead. */
export function clearAccessOf(db: Db, companyId: string, userId: string) {
  setMemberAccess(db, { companyId, userId, customRoleId: null, scoped: [] });
}

/** The effective access of one person in one company, or null when they are not a member. */
export function accessOf(db: Db, companyId: string, userId: string): rbac.Access | null {
  const membership = db.prepare("SELECT role, custom_role_id FROM memberships WHERE company_id = ? AND user_id = ?").get(companyId, userId) as
    | { role: Role; custom_role_id: string | null }
    | undefined;
  if (membership === undefined) return null;
  if (membership.role === "owner" || membership.role === "admin") {
    return rbac.resolveAccess({ role: membership.role, customRole: null, builtinOverride: null, scoped: [] });
  }
  const roleRows = db.prepare("SELECT * FROM company_roles WHERE company_id = ?").all(companyId) as unknown as Array<RoleRow>;
  const byId = new Map(roleRows.filter((row) => row.builtin === null).map((row) => [row.id, toRole(row)]));
  const override = roleRows.find((row) => row.builtin === membership.role);
  const scoped = (db
    .prepare("SELECT role_id, scope_kind, scope_id FROM member_scoped_roles WHERE company_id = ? AND user_id = ?")
    .all(companyId, userId) as Array<{ role_id: string; scope_kind: rbac.ScopeKind; scope_id: string }>)
    .map((row) => ({ role: byId.get(row.role_id), kind: row.scope_kind, id: row.scope_id }))
    .filter((row): row is { role: rbac.RoleDef & { updatedAt: string }; kind: rbac.ScopeKind; id: string } => row.role !== undefined);
  return rbac.resolveAccess({
    role: membership.role,
    customRole: membership.custom_role_id === null ? null : (byId.get(membership.custom_role_id) ?? null),
    builtinOverride: override === undefined ? null : toRole(override).permissions,
    scoped,
  });
}

/**
 * `accessOf` as the app and the company runner get it: team-scoped grants also listed for each
 * project of the team (they check an AI employee's project without knowing the teams).
 */
export function accessForClients(db: Db, companyId: string, userId: string): rbac.Access | null {
  const access = accessOf(db, companyId, userId);
  if (access === null || access.scoped.every((grant) => grant.kind !== "team")) return access;
  return rbac.withTeamProjects(access, projectsOf(db, companyId));
}

// ---- Teams and projects --------------------------------------------------------------------------

export function teamsOf(db: Db, companyId: string) {
  return db.prepare("SELECT id, name, created_at AS createdAt FROM company_teams WHERE company_id = ? ORDER BY name").all(companyId) as Array<{
    id: string;
    name: string;
    createdAt: string;
  }>;
}

export function createTeam(db: Db, companyId: string, name: string) {
  const id = newId("team");
  db.prepare("INSERT INTO company_teams (id, company_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, companyId, name, nowIso());
  return id;
}

export function teamExists(db: Db, companyId: string, teamId: string): boolean {
  return db.prepare("SELECT 1 FROM company_teams WHERE company_id = ? AND id = ?").get(companyId, teamId) !== undefined;
}

export function teamNameTaken(db: Db, companyId: string, name: string): boolean {
  return db.prepare("SELECT 1 FROM company_teams WHERE company_id = ? AND lower(name) = lower(?)").get(companyId, name) !== undefined;
}

export function deleteTeam(db: Db, companyId: string, teamId: string): boolean {
  db.prepare("DELETE FROM member_scoped_roles WHERE company_id = ? AND scope_kind = 'team' AND scope_id = ?").run(companyId, teamId);
  return Number(db.prepare("DELETE FROM company_teams WHERE company_id = ? AND id = ?").run(companyId, teamId).changes) > 0;
}

export function projectsOf(db: Db, companyId: string) {
  return db
    .prepare("SELECT project_id AS id, name, team_id AS teamId, created_at AS createdAt FROM company_projects WHERE company_id = ? ORDER BY name")
    .all(companyId) as Array<{ id: string; name: string; teamId: string | null; createdAt: string }>;
}

export function projectExists(db: Db, companyId: string, projectId: string): boolean {
  return db.prepare("SELECT 1 FROM company_projects WHERE company_id = ? AND project_id = ?").get(companyId, projectId) !== undefined;
}

export function putProject(db: Db, input: { companyId: string; projectId: string; name: string; teamId: string | null }) {
  db.prepare(
    `INSERT INTO company_projects (company_id, project_id, name, team_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id, project_id) DO UPDATE SET name = excluded.name, team_id = excluded.team_id`,
  ).run(input.companyId, input.projectId, input.name, input.teamId, nowIso());
}

export function deleteProject(db: Db, companyId: string, projectId: string): boolean {
  db.prepare("DELETE FROM member_scoped_roles WHERE company_id = ? AND scope_kind = 'project' AND scope_id = ?").run(companyId, projectId);
  return Number(db.prepare("DELETE FROM company_projects WHERE company_id = ? AND project_id = ?").run(companyId, projectId).changes) > 0;
}

/** Where a project lives: itself and its team, for scoped checks. */
export function scopeOfProject(db: Db, companyId: string, projectId: string | null): rbac.ScopeContext {
  if (projectId === null) return {};
  const row = db.prepare("SELECT team_id FROM company_projects WHERE company_id = ? AND project_id = ?").get(companyId, projectId) as
    | { team_id: string | null }
    | undefined;
  return { projectId, teamIds: row?.team_id ? [row.team_id] : [] };
}
