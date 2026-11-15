// Hosted company memory (zen-memory, hub v13). Our hosted hub provisions one memory company per hub
// company and hands each member machine its own memory API key, so the app connects without anyone
// copying addresses or keys. The hub talks to zen-memory's admin API on the internal network
// (HUB_MEMORY_ADMIN_URL + HUB_MEMORY_ADMIN_TOKEN); the apps get the public address
// (HUB_MEMORY_URL). The hub keeps the memory company id and the key ids only: a key is shown once,
// to the machine that asked, and revoked by id when that machine asks again, when the person
// removes it, or when the person leaves the company. Self-hosted hubs leave the variables unset and
// keep "your own memory server" (address on the hub, key per machine).
import type { Db } from "./db.ts";
import * as rbac from "./rbac.ts";
import * as rolesStore from "./storeRbac.ts";

const nowIso = () => new Date().toISOString();

export interface MemoryHostedConfig {
  /** Public address the apps use (e.g. https://memory.example.com). */
  readonly publicUrl: string;
  /** Internal admin address of zen-memory (e.g. http://zen-memory-api:8000). */
  readonly adminUrl: string;
  readonly adminToken: string;
  readonly fetchImpl?: typeof fetch;
}

export function memoryHostedConfig(env: Record<string, string | undefined>): MemoryHostedConfig | null {
  const publicUrl = (env.HUB_MEMORY_URL ?? "").trim().replace(/\/+$/, "");
  const adminUrl = (env.HUB_MEMORY_ADMIN_URL ?? "").trim().replace(/\/+$/, "");
  const adminToken = (env.HUB_MEMORY_ADMIN_TOKEN ?? "").trim();
  if (publicUrl === "" || adminUrl === "" || adminToken === "") return null;
  return { publicUrl, adminUrl, adminToken };
}

/** Keys one person may hold per company at a time (one per machine; old ones are revoked first). */
export const MAX_ACTIVE_KEYS_PER_MEMBER = 10;

export class MemoryAdminError extends Error {}

/** zen-memory's admin API (README "Other endpoints" / hosted release). */
export function memoryAdmin(config: MemoryHostedConfig) {
  const doFetch = config.fetchImpl ?? fetch;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${config.adminUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new MemoryAdminError(`The memory service is not reachable (${error instanceof Error ? error.name : "error"}).`);
    }
    if (!res.ok) throw new MemoryAdminError(`The memory service answered ${res.status}.`);
    return (await res.json()) as T;
  };
  return {
    listCompanies: () => call<{ companies: Array<{ company_id: string; name: string }> }>("GET", "/admin/companies"),
    createCompany: (name: string) => call<{ company_id: string; api_key: string }>("POST", "/admin/companies", { name }),
    listKeys: (companyId: string) =>
      call<{ keys: Array<{ key_id: string; revoked_at: string | null }> }>("GET", `/admin/companies/${encodeURIComponent(companyId)}/keys`),
    /** A machine key bound to the hub user (zen-memory v4 reads that user's zones by it). */
    issueKey: (companyId: string, userRef?: string) =>
      call<{ key_id: string; api_key: string }>(
        "POST",
        `/admin/companies/${encodeURIComponent(companyId)}/keys${userRef === undefined ? "" : `?user_ref=${encodeURIComponent(userRef)}`}`,
      ),
    syncAccess: (companyId: string, body: AccessSync) => call<{ zones_created: number; members: number }>("PUT", `/admin/companies/${encodeURIComponent(companyId)}/access`, body),
    createPerson: (userRef: string) => call<{ person_id: string; created: boolean }>("POST", "/admin/persons", { user_ref: userRef }),
    deletePerson: (personId: string) => call<{ status: string; data_keys_destroyed: number }>("DELETE", `/admin/persons/${encodeURIComponent(personId)}`),
    issuePersonKey: (personId: string) => call<{ key_id: string; api_key: string }>("POST", `/admin/persons/${encodeURIComponent(personId)}/keys`),
    revokePersonKey: (personId: string, keyId: string) =>
      call<{ revoked: number }>("DELETE", `/admin/persons/${encodeURIComponent(personId)}/keys/${encodeURIComponent(keyId)}`),
    linkPerson: (personId: string, companyId: string) =>
      call<unknown>("PUT", `/admin/persons/${encodeURIComponent(personId)}/companies/${encodeURIComponent(companyId)}`),
    unlinkPerson: (personId: string, companyId: string, forget: boolean) =>
      call<{ detached: boolean; forgotten?: { facts_deleted: number } }>(
        "DELETE",
        `/admin/persons/${encodeURIComponent(personId)}/companies/${encodeURIComponent(companyId)}?forget=${forget ? "true" : "false"}`,
      ),
    revokeKey: (companyId: string, keyId: string) =>
      call<{ revoked: number }>("DELETE", `/admin/companies/${encodeURIComponent(companyId)}/keys/${encodeURIComponent(keyId)}`),
  };
}

/** What the hub sends zen-memory about one company (README "Personal memory and zones"). */
export interface AccessSync {
  readonly zones: ReadonlyArray<{ ref: string; kind: "team" | "project"; name: string; parent_ref?: string | null }>;
  readonly members: ReadonlyArray<{ user_ref: string; admin: boolean; company: boolean; zones: ReadonlyArray<string> }>;
  readonly auto_promote_decisions?: boolean;
  readonly sensitive_policy?: "personal" | "drop";
  readonly rule_set_by?: string | null;
}

/**
 * Departments (the v9 teams), projects and who may read each zone, from the hub roles:
 * `memorie:vede` for the whole company, for a team, or for a project (a project's team counts).
 * Owners and admins read everything.
 */
export function restrictedZones(db: Db, companyId: string): Set<string> {
  return new Set(
    (db.prepare("SELECT zone_ref FROM memory_zone_settings WHERE company_id = ? AND restricted = 1").all(companyId) as Array<{ zone_ref: string }>).map(
      (row) => row.zone_ref,
    ),
  );
}

export function setZoneRestricted(db: Db, companyId: string, ref: string, restricted: boolean, userId: string): void {
  db.prepare(
    `INSERT INTO memory_zone_settings (company_id, zone_ref, restricted, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id, zone_ref) DO UPDATE SET restricted = excluded.restricted, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(companyId, ref, restricted ? 1 : 0, userId, nowIso());
}

/** A grant of the permission scoped to this team or project (or the project's team), not company-wide. */
function scopedGrant(access: rbac.Access | null, scope: rbac.ScopeContext): boolean {
  if (access === null) return false;
  return access.scoped.some(
    (grant) =>
      grant.permission === "memorie:vede" &&
      ((grant.kind === "project" && scope.projectId != null && grant.id === scope.projectId) || (grant.kind === "team" && (scope.teamIds ?? []).includes(grant.id))),
  );
}

export function buildAccess(db: Db, companyId: string): AccessSync {
  const restricted = restrictedZones(db, companyId);
  const reads = (access: rbac.Access | null, ref: string, scope: rbac.ScopeContext) =>
    restricted.has(ref) ? scopedGrant(access, scope) : rbac.can(access, "memorie:vede", scope);
  const teams = rolesStore.teamsOf(db, companyId);
  const projects = rolesStore.projectsOf(db, companyId);
  const members = db.prepare("SELECT user_id, role FROM memberships WHERE company_id = ?").all(companyId) as Array<{ user_id: string; role: string }>;
  const rules = companyMemory(db, companyId);
  return {
    zones: [
      ...teams.map((team) => ({ ref: `team:${team.id}`, kind: "team" as const, name: team.name })),
      ...projects.map((project) => ({ ref: `project:${project.id}`, kind: "project" as const, name: project.name, parent_ref: project.teamId === null ? null : `team:${project.teamId}` })),
    ],
    members: members.map((member) => {
      const access = rolesStore.accessOf(db, companyId, member.user_id);
      const admin = member.role === "owner" || member.role === "admin";
      return {
        user_ref: member.user_id,
        admin,
        company: rbac.can(access, "memorie:vede"),
        zones: [
          ...teams.filter((team) => reads(access, `team:${team.id}`, { teamIds: [team.id] })).map((team) => `team:${team.id}`),
          ...projects
            .filter((project) => reads(access, `project:${project.id}`, rolesStore.scopeOfProject(db, companyId, project.id)))
            .map((project) => `project:${project.id}`),
        ],
      };
    }),
    ...(rules === null ? {} : { auto_promote_decisions: rules.autoPromoteDecisions, sensitive_policy: rules.sensitivePolicy, rule_set_by: rules.rulesUpdatedBy }),
  };
}

// ---- store ---------------------------------------------------------------------------------

export interface CompanyMemoryRow {
  readonly companyId: string;
  readonly memoryCompanyId: string;
  readonly url: string;
  readonly activatedBy: string | null;
  readonly activatedAt: string;
  readonly autoPromoteDecisions: boolean;
  readonly sensitivePolicy: "personal" | "drop";
  readonly rulesUpdatedBy: string | null;
  readonly accessSyncedAt: string | null;
}

export function companyMemory(db: Db, companyId: string): CompanyMemoryRow | null {
  const row = db
    .prepare(
      "SELECT company_id, memory_company_id, url, activated_by, activated_at, auto_promote_decisions, sensitive_policy, rules_updated_by, access_synced_at FROM company_memory WHERE company_id = ?",
    )
    .get(companyId) as
    | {
        company_id: string;
        memory_company_id: string;
        url: string;
        activated_by: string | null;
        activated_at: string;
        auto_promote_decisions: number;
        sensitive_policy: string;
        rules_updated_by: string | null;
        access_synced_at: string | null;
      }
    | undefined;
  return row === undefined
    ? null
    : {
        companyId: row.company_id,
        memoryCompanyId: row.memory_company_id,
        url: row.url,
        activatedBy: row.activated_by,
        activatedAt: row.activated_at,
        autoPromoteDecisions: row.auto_promote_decisions === 1,
        sensitivePolicy: row.sensitive_policy === "drop" ? "drop" : "personal",
        rulesUpdatedBy: row.rules_updated_by,
        accessSyncedAt: row.access_synced_at,
      };
}

export function setMemoryRules(db: Db, companyId: string, rules: { autoPromoteDecisions: boolean; sensitivePolicy: "personal" | "drop" }, userId: string): void {
  db.prepare("UPDATE company_memory SET auto_promote_decisions = ?, sensitive_policy = ?, rules_updated_by = ? WHERE company_id = ?").run(
    rules.autoPromoteDecisions ? 1 : 0,
    rules.sensitivePolicy,
    userId,
    companyId,
  );
}

export function markAccessSynced(db: Db, companyId: string): void {
  db.prepare("UPDATE company_memory SET access_synced_at = ? WHERE company_id = ?").run(nowIso(), companyId);
}

// ---- personal memory (v17) -------------------------------------------------------------------

export function userMemory(db: Db, userId: string): { personId: string; createdAt: string } | null {
  const row = db.prepare("SELECT memory_person_id, created_at FROM user_memory WHERE user_id = ?").get(userId) as
    | { memory_person_id: string; created_at: string }
    | undefined;
  return row === undefined ? null : { personId: row.memory_person_id, createdAt: row.created_at };
}

export function saveUserMemory(db: Db, userId: string, personId: string): void {
  db.prepare("INSERT OR IGNORE INTO user_memory (user_id, memory_person_id, created_at) VALUES (?, ?, ?)").run(userId, personId, nowIso());
}

export function deleteUserMemory(db: Db, userId: string): void {
  db.prepare("DELETE FROM user_memory WHERE user_id = ?").run(userId);
  db.prepare("UPDATE user_memory_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(nowIso(), userId);
}

export function activePersonalKeys(db: Db, userId: string): Array<{ keyId: string; machine: string; issuedAt: string }> {
  return (
    db.prepare("SELECT key_id, machine, issued_at FROM user_memory_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY issued_at").all(userId) as Array<{
      key_id: string;
      machine: string;
      issued_at: string;
    }>
  ).map((row) => ({ keyId: row.key_id, machine: row.machine, issuedAt: row.issued_at }));
}

export function recordPersonalKey(db: Db, userId: string, machine: string, keyId: string): void {
  db.prepare("INSERT INTO user_memory_keys (key_id, user_id, machine, issued_at) VALUES (?, ?, ?, ?)").run(keyId, userId, machine, nowIso());
}

export function markPersonalRevoked(db: Db, keyId: string): void {
  db.prepare("UPDATE user_memory_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL").run(nowIso(), keyId);
}

export function saveCompanyMemory(db: Db, companyId: string, memoryCompanyId: string, url: string, userId: string): void {
  db.prepare("INSERT INTO company_memory (company_id, memory_company_id, url, activated_by, activated_at) VALUES (?, ?, ?, ?, ?)").run(
    companyId,
    memoryCompanyId,
    url,
    userId,
    nowIso(),
  );
}

export interface MemoryKeyRow {
  readonly keyId: string;
  readonly userId: string;
  readonly machine: string;
  readonly issuedAt: string;
}

export function activeKeys(db: Db, companyId: string, userId?: string): MemoryKeyRow[] {
  const rows = (
    userId === undefined
      ? db.prepare("SELECT key_id, user_id, machine, issued_at FROM company_memory_keys WHERE company_id = ? AND revoked_at IS NULL ORDER BY issued_at").all(companyId)
      : db
          .prepare("SELECT key_id, user_id, machine, issued_at FROM company_memory_keys WHERE company_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY issued_at")
          .all(companyId, userId)
  ) as Array<{ key_id: string; user_id: string; machine: string; issued_at: string }>;
  return rows.map((row) => ({ keyId: row.key_id, userId: row.user_id, machine: row.machine, issuedAt: row.issued_at }));
}

export function recordKey(db: Db, companyId: string, userId: string, machine: string, keyId: string): void {
  db.prepare("INSERT INTO company_memory_keys (key_id, company_id, user_id, machine, issued_at) VALUES (?, ?, ?, ?, ?)").run(
    keyId,
    companyId,
    userId,
    machine,
    nowIso(),
  );
}

export function markRevoked(db: Db, keyId: string): void {
  db.prepare("UPDATE company_memory_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL").run(nowIso(), keyId);
}
