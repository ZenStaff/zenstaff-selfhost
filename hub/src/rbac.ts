// Roles and permissions (v9), as pure functions over plain records. The hub, the runner and the
// app evaluate the same rules: a permission is "<resource>:<action>", granted for the whole company
// or for one project / team. test/rbac.test.ts pins them.
//
// - Built-in roles: Owner and Admin can do everything (their hierarchy rules stay in policy.ts);
//   Membru and Invitat have default permission sets that a company may change.
// - Custom roles ("Contabilitate", "Vânzări", "Developer"): owners and admins create them. A person
//   with base role member or guest gets one company-wide custom role (it replaces the built-in set)
//   and any number of scoped roles (role X on project P or team T), which only add.
// - AI staff act with the permissions of the person who started them, never more (`agentCan`).
import type { Role } from "./policy.ts";

export const RESOURCES = ["chats", "memorie", "pachete", "angajati", "facturare", "echipa", "dispozitive"] as const;
export const ACTIONS = ["vede", "creeaza", "aproba", "trimite", "administreaza"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];

/**
 * Follow the company runner's threads, read-only: `chats:urmareste` for the threads one's own tasks
 * started, `chats:urmareste-toate` for every runner thread.
 */
export const FOLLOW_OWN = "chats:urmareste";
export const FOLLOW_ALL = "chats:urmareste-toate";
export const EXTRA_PERMISSIONS = [FOLLOW_OWN, FOLLOW_ALL] as const;

export type Permission = `${Resource}:${Action}` | (typeof EXTRA_PERMISSIONS)[number];

export const ALL_PERMISSIONS: ReadonlyArray<Permission> = [
  ...RESOURCES.flatMap((resource) => ACTIONS.map((action) => `${resource}:${action}` as Permission)),
  ...EXTRA_PERMISSIONS,
];
const KNOWN = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && KNOWN.has(value);
}

/** Defaults for the built-in roles a company may change (owner and admin are fixed: everything). */
export const DEFAULT_PERMISSIONS: Record<"member" | "guest", ReadonlyArray<Permission>> = {
  member: [
    "chats:vede",
    "chats:creeaza",
    "chats:trimite",
    FOLLOW_OWN,
    "memorie:vede",
    "memorie:creeaza",
    "pachete:vede",
    "angajati:vede",
    "angajati:creeaza",
    "angajati:trimite",
    "facturare:vede",
    "echipa:vede",
    "dispozitive:vede",
  ],
  guest: ["chats:vede"],
};

export type ScopeKind = "team" | "project";

export interface RoleDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: ReadonlyArray<Permission>;
  /** Set on the built-in roles (and on a company's override of Membru / Invitat). */
  readonly builtin: Role | null;
}

export interface ScopedGrant {
  readonly roleId: string;
  readonly kind: ScopeKind;
  readonly id: string;
}

/** What one person may do in one company. */
export interface Access {
  readonly role: Role;
  /** The custom role that replaces the built-in set (members and guests only). */
  readonly customRoleId: string | null;
  /** Company-wide permissions. Owners and admins: every permission. */
  readonly permissions: ReadonlyArray<Permission>;
  /** Permissions that hold only inside a project or a team. */
  readonly scoped: ReadonlyArray<{ readonly permission: Permission; readonly kind: ScopeKind; readonly id: string }>;
}

/** Where the checked resource lives: its project and the teams that project belongs to. */
export interface ScopeContext {
  readonly projectId?: string | null;
  readonly teamIds?: ReadonlyArray<string>;
}

export function builtinRoles(overrides: Partial<Record<"member" | "guest", ReadonlyArray<Permission>>> = {}): Array<RoleDef> {
  return [
    { id: "owner", name: "Owner", description: "", permissions: ALL_PERMISSIONS, builtin: "owner" },
    { id: "admin", name: "Admin", description: "", permissions: ALL_PERMISSIONS, builtin: "admin" },
    { id: "member", name: "Membru", description: "", permissions: overrides.member ?? DEFAULT_PERMISSIONS.member, builtin: "member" },
    { id: "guest", name: "Invitat", description: "", permissions: overrides.guest ?? DEFAULT_PERMISSIONS.guest, builtin: "guest" },
  ];
}

/** Turns a stored role list into the effective access of one person. */
export function resolveAccess(input: {
  readonly role: Role;
  readonly customRole: RoleDef | null;
  readonly builtinOverride: ReadonlyArray<Permission> | null;
  readonly scoped: ReadonlyArray<{ readonly role: RoleDef; readonly kind: ScopeKind; readonly id: string }>;
}): Access {
  if (input.role === "owner" || input.role === "admin") {
    return { role: input.role, customRoleId: null, permissions: ALL_PERMISSIONS, scoped: [] };
  }
  const base = input.customRole?.permissions ?? input.builtinOverride ?? DEFAULT_PERMISSIONS[input.role];
  return {
    role: input.role,
    customRoleId: input.customRole?.id ?? null,
    permissions: [...new Set(base)],
    scoped: input.scoped.flatMap(({ role, kind, id }) => role.permissions.map((permission) => ({ permission, kind, id }))),
  };
}

/** The one check. Without a scope context only company-wide permissions count. */
export function can(access: Access | null, permission: Permission, scope: ScopeContext = {}): boolean {
  if (access === null) return false;
  if (access.role === "owner" || access.role === "admin") return true;
  if (access.permissions.includes(permission)) return true;
  return access.scoped.some(
    (grant) =>
      grant.permission === permission &&
      ((grant.kind === "project" && scope.projectId !== undefined && scope.projectId !== null && grant.id === scope.projectId) ||
        (grant.kind === "team" && (scope.teamIds ?? []).includes(grant.id))),
  );
}

/** Any grant at all of this permission (company-wide or in some project/team): for showing a page. */
export function canSomewhere(access: Access | null, permission: Permission): boolean {
  return can(access, permission) || (access?.scoped.some((grant) => grant.permission === permission) ?? false);
}

/**
 * What an AI employee may do on a run: the person (or role) who started it, never more. A run
 * started by a duty (no person) uses the agent's manager; a run with nobody behind it may only read.
 * The agent's own profile limits (approvals, "ce nu are voie") apply on top of this, on the runner.
 */
export function agentCan(starter: Access | null, permission: Permission, scope: ScopeContext = {}): boolean {
  return can(starter, permission, scope);
}

/**
 * The access a runner or an app checks without knowing the company's teams: every team-scoped
 * grant is also given for each project of that team (the project list is the hub's). The runner
 * checks an AI employee's project only, so a role on team T works there for T's projects.
 */
export function withTeamProjects(
  access: Access | null,
  projects: ReadonlyArray<{ readonly id: string; readonly teamId: string | null }>,
): Access | null {
  if (access === null || access.scoped.length === 0) return access;
  const expanded = access.scoped.flatMap((grant) =>
    grant.kind === "team"
      ? projects.filter((project) => project.teamId === grant.id).map((project) => ({ permission: grant.permission, kind: "project" as const, id: project.id }))
      : [],
  );
  const seen = new Set(access.scoped.map((grant) => `${grant.permission}|${grant.kind}|${grant.id}`));
  const added = expanded.filter((grant) => {
    const key = `${grant.permission}|${grant.kind}|${grant.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length === 0 ? access : { ...access, scoped: [...access.scoped, ...added] };
}

/** Only owners and admins edit roles and give them (a custom role can never edit roles). */
export function canEditRoles(role: Role | null): boolean {
  return role === "owner" || role === "admin";
}

/** Normalizes a permission list from a request: known permissions only, no duplicates, sorted. */
export function cleanPermissions(value: unknown): Array<Permission> | null {
  if (!Array.isArray(value) || value.length > ALL_PERMISSIONS.length * 2) return null;
  if (!value.every(isPermission)) return null;
  const set = new Set(value as Array<Permission>);
  return ALL_PERMISSIONS.filter((permission) => set.has(permission));
}

/** "chats:trimite" -> what the app and the dashboard show in an error. */
export function describePermission(permission: Permission): string {
  return permission.replace(":", ": ");
}
