// SQL for company-level objects (v6): AI staff profiles and company packs, with each machine's
// install status. The hub stores staff profiles only as ciphertext sealed to the company's
// runners, plus the version, the manager, who changed it and when.
import type { Db } from "./db.ts";

const nowIso = () => new Date().toISOString();

// ---- AI staff --------------------------------------------------------------------------------

export interface StaffRecord {
  readonly staffId: string;
  readonly version: number;
  readonly managerUserId: string | null;
  /** environmentId -> ciphertext sealed to that runner's box key. Empty when deleted. */
  readonly sealed: Record<string, string>;
  readonly statement: string;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly updatedBy: string;
  readonly updatedByName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /** v9: the project the agent works in (hub metadata, for roles scoped to a project or team). */
  readonly projectId: string | null;
}

interface StaffRow {
  staff_id: string;
  version: number;
  manager_user_id: string | null;
  sealed: string;
  statement: string;
  signer_key_id: string;
  signature: string;
  updated_by: string;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  project_id: string | null;
}

const toStaff = (row: StaffRow): StaffRecord => ({
  staffId: row.staff_id,
  version: row.version,
  managerUserId: row.manager_user_id,
  sealed: (() => {
    try {
      return JSON.parse(row.sealed) as Record<string, string>;
    } catch {
      return {};
    }
  })(),
  statement: row.statement,
  signerKeyId: row.signer_key_id,
  signature: row.signature,
  updatedBy: row.updated_by,
  updatedByName: row.updated_by_name ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  projectId: row.project_id ?? null,
});

const STAFF_SELECT =
  "SELECT s.*, u.name AS updated_by_name FROM company_staff s LEFT JOIN users u ON u.id = s.updated_by";

export function staffOf(db: Db, companyId: string): Array<StaffRecord> {
  return (db.prepare(`${STAFF_SELECT} WHERE s.company_id = ? ORDER BY s.created_at`).all(companyId) as unknown as StaffRow[]).map(toStaff);
}

export function getStaff(db: Db, companyId: string, staffId: string): StaffRecord | null {
  const row = db.prepare(`${STAFF_SELECT} WHERE s.company_id = ? AND s.staff_id = ?`).get(companyId, staffId) as StaffRow | undefined;
  return row === undefined ? null : toStaff(row);
}

export function putStaff(
  db: Db,
  input: {
    readonly companyId: string;
    readonly staffId: string;
    readonly version: number;
    readonly managerUserId: string | null;
    readonly sealed: Record<string, string>;
    readonly statement: string;
    readonly signerKeyId: string;
    readonly signature: string;
    readonly updatedBy: string;
    readonly deleted: boolean;
    readonly projectId?: string | null;
  },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO company_staff (company_id, staff_id, version, manager_user_id, sealed, statement, signer_key_id, signature, updated_by, created_at, updated_at, deleted_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, staff_id) DO UPDATE SET version = excluded.version, manager_user_id = excluded.manager_user_id,
       sealed = excluded.sealed, statement = excluded.statement, signer_key_id = excluded.signer_key_id,
       signature = excluded.signature, updated_by = excluded.updated_by, updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at, project_id = excluded.project_id`,
  ).run(
    input.companyId,
    input.staffId,
    input.version,
    input.managerUserId,
    JSON.stringify(input.sealed),
    input.statement,
    input.signerKeyId,
    input.signature,
    input.updatedBy,
    now,
    now,
    input.deleted ? now : null,
    input.projectId ?? null,
  );
}

// ---- Company packs ---------------------------------------------------------------------------

export interface CompanyPack {
  readonly packId: string;
  readonly version: string;
  readonly settings: Record<string, unknown>;
  readonly enterprise: boolean;
  readonly statement: string;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly updatedBy: string;
  readonly updatedByName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PackRow {
  pack_id: string;
  version: string;
  settings: string;
  enterprise: number;
  statement: string;
  signer_key_id: string;
  signature: string;
  updated_by: string;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const toPack = (row: PackRow): CompanyPack => ({
  packId: row.pack_id,
  version: row.version,
  settings: (() => {
    try {
      return JSON.parse(row.settings) as Record<string, unknown>;
    } catch {
      return {};
    }
  })(),
  enterprise: row.enterprise === 1,
  statement: row.statement,
  signerKeyId: row.signer_key_id,
  signature: row.signature,
  updatedBy: row.updated_by,
  updatedByName: row.updated_by_name ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function packsOf(db: Db, companyId: string): Array<CompanyPack> {
  return (
    db
      .prepare(
        "SELECT p.*, u.name AS updated_by_name FROM company_packs p LEFT JOIN users u ON u.id = p.updated_by WHERE p.company_id = ? AND p.removed_at IS NULL ORDER BY p.created_at",
      )
      .all(companyId) as unknown as PackRow[]
  ).map(toPack);
}

export function hasPack(db: Db, companyId: string, packId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM company_packs WHERE company_id = ? AND pack_id = ? AND removed_at IS NULL").get(companyId, packId) !==
    undefined
  );
}

export function putPack(
  db: Db,
  input: {
    readonly companyId: string;
    readonly packId: string;
    readonly version: string;
    readonly settings: Record<string, unknown>;
    readonly enterprise: boolean;
    readonly statement: string;
    readonly signerKeyId: string;
    readonly signature: string;
    readonly updatedBy: string;
  },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO company_packs (company_id, pack_id, version, settings, enterprise, statement, signer_key_id, signature, updated_by, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (company_id, pack_id) DO UPDATE SET version = excluded.version, settings = excluded.settings,
       enterprise = excluded.enterprise, statement = excluded.statement, signer_key_id = excluded.signer_key_id,
       signature = excluded.signature, updated_by = excluded.updated_by, updated_at = excluded.updated_at, removed_at = NULL`,
  ).run(
    input.companyId,
    input.packId,
    input.version,
    JSON.stringify(input.settings),
    input.enterprise ? 1 : 0,
    input.statement,
    input.signerKeyId,
    input.signature,
    input.updatedBy,
    now,
    now,
  );
}

export function removePack(db: Db, companyId: string, packId: string): boolean {
  const now = nowIso();
  const result = db
    .prepare("UPDATE company_packs SET removed_at = ?, updated_at = ? WHERE company_id = ? AND pack_id = ? AND removed_at IS NULL")
    .run(now, now, companyId, packId);
  db.prepare("DELETE FROM company_pack_status WHERE company_id = ? AND pack_id = ?").run(companyId, packId);
  return Number(result.changes) > 0;
}

export type PackState = "installing" | "installed" | "failed" | "runner-only";
export const PACK_STATES: ReadonlyArray<PackState> = ["installing", "installed", "failed", "runner-only"];

export interface PackStatus {
  readonly packId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly userId: string;
  readonly userName: string;
  readonly state: PackState;
  readonly version: string | null;
  readonly error: string | null;
  readonly hidden: boolean;
  readonly runner: boolean;
  readonly updatedAt: string;
}

export function setPackStatus(
  db: Db,
  input: {
    readonly companyId: string;
    readonly packId: string;
    readonly environmentId: string;
    readonly userId: string;
    readonly state: PackState;
    readonly version: string | null;
    readonly error: string | null;
    readonly hidden: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO company_pack_status (company_id, pack_id, environment_id, user_id, state, version, error, hidden, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, pack_id, environment_id) DO UPDATE SET user_id = excluded.user_id, state = excluded.state,
       version = excluded.version, error = excluded.error, hidden = excluded.hidden, updated_at = excluded.updated_at`,
  ).run(
    input.companyId,
    input.packId,
    input.environmentId,
    input.userId,
    input.state,
    input.version,
    input.error,
    input.hidden ? 1 : 0,
    nowIso(),
  );
}

export function packStatusOf(db: Db, companyId: string, onlyUserId: string | null): Array<PackStatus> {
  const rows = db
    .prepare(
      `SELECT s.pack_id, s.environment_id, e.name AS environment_name, (SELECT r.company_id FROM environment_runners r WHERE r.environment_id = s.environment_id AND r.company_id = s.company_id) AS runner_company_id, s.user_id, u.name AS user_name,
              s.state, s.version, s.error, s.hidden, s.updated_at
       FROM company_pack_status s JOIN environments e ON e.id = s.environment_id JOIN users u ON u.id = s.user_id
       JOIN company_packs p ON p.company_id = s.company_id AND p.pack_id = s.pack_id AND p.removed_at IS NULL
       WHERE s.company_id = ? ${onlyUserId === null ? "" : "AND s.user_id = ?"} ORDER BY s.pack_id, u.name, e.name`,
    )
    .all(...(onlyUserId === null ? [companyId] : [companyId, onlyUserId])) as Array<{
    pack_id: string;
    environment_id: string;
    environment_name: string;
    runner_company_id: string | null;
    user_id: string;
    user_name: string;
    state: PackState;
    version: string | null;
    error: string | null;
    hidden: number;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    packId: row.pack_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    userId: row.user_id,
    userName: row.user_name,
    state: row.state,
    version: row.version,
    error: row.error,
    hidden: row.hidden === 1,
    runner: row.runner_company_id === companyId,
    updatedAt: row.updated_at,
  }));
}
