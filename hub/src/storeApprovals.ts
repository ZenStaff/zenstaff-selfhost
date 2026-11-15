// SQL for client approval links (migration v14). The link token is never stored, only its SHA-256;
// the files' bytes are on disk (approvalFiles.ts), their names, types and sizes here.
import { randomBytes } from "node:crypto";

import type { ApprovalFileKind } from "./approvalFiles.ts";
import { newId, sha256 } from "./crypto.ts";
import type { Db } from "./db.ts";
import { recordEvent } from "./growth.ts";

export type ApprovalStatus = "sent" | "viewed" | "approved" | "changes";
export type ApprovalLanguage = "ro" | "en";

export interface ApprovalFileRow {
  readonly index: number;
  readonly role: "file" | "logo";
  readonly kind: ApprovalFileKind;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface Approval {
  readonly id: string;
  readonly companyId: string;
  readonly createdBy: string | null;
  readonly title: string;
  readonly note: string;
  readonly clientName: string;
  readonly clientColor: string | null;
  readonly language: ApprovalLanguage;
  readonly status: ApprovalStatus;
  readonly comment: string | null;
  readonly decidedByName: string | null;
  readonly viewCount: number;
  readonly firstViewedAt: string | null;
  readonly lastViewedAt: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly filesDeletedAt: string | null;
  readonly totalBytes: number;
}

interface Row {
  id: string;
  company_id: string;
  created_by: string | null;
  title: string;
  note: string;
  client_name: string;
  client_color: string | null;
  language: ApprovalLanguage;
  status: ApprovalStatus;
  comment: string | null;
  decided_by_name: string | null;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  files_deleted_at: string | null;
  total_bytes: number;
}

const toApproval = (row: Row): Approval => ({
  id: row.id,
  companyId: row.company_id,
  createdBy: row.created_by,
  title: row.title,
  note: row.note,
  clientName: row.client_name,
  clientColor: row.client_color,
  language: row.language,
  status: row.status,
  comment: row.comment,
  decidedByName: row.decided_by_name,
  viewCount: row.view_count,
  firstViewedAt: row.first_viewed_at,
  lastViewedAt: row.last_viewed_at,
  decidedAt: row.decided_at,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  filesDeletedAt: row.files_deleted_at,
  totalBytes: row.total_bytes,
});

/** 256 random bits, base64url (43 characters): the only thing a client needs to open the link. */
export const newApprovalToken = () => randomBytes(32).toString("base64url");
export const isTokenShape = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

export function createApproval(
  db: Db,
  input: {
    readonly companyId: string;
    readonly createdBy: string;
    readonly title: string;
    readonly note: string;
    readonly clientName: string;
    readonly clientColor: string | null;
    readonly language: ApprovalLanguage;
    readonly expiresAt: string;
    readonly files: ReadonlyArray<Omit<ApprovalFileRow, "index">>;
  },
): { approval: Approval; token: string } {
  const id = newId("apr");
  const token = newApprovalToken();
  const now = new Date().toISOString();
  const total = input.files.reduce((sum, file) => sum + file.size, 0);
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO client_approvals (id, token_hash, company_id, created_by, title, note, client_name, client_color, language, created_at, expires_at, total_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, sha256(token), input.companyId, input.createdBy, input.title, input.note, input.clientName, input.clientColor, input.language, now, input.expiresAt, total);
    const insert = db.prepare(
      "INSERT INTO client_approval_files (approval_id, idx, role, kind, name, mime, size, sha256, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    input.files.forEach((file, index) => insert.run(id, index, file.role, file.kind, file.name, file.mime, file.size, file.sha256, file.width, file.height));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  recordEvent(db, "approval_link_created", { companyId: input.companyId, userId: input.createdBy, meta: { files: input.files.length } });
  return { approval: getApproval(db, id)!, token };
}

export function getApproval(db: Db, id: string): Approval | null {
  const row = db.prepare("SELECT * FROM client_approvals WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toApproval(row);
}

export function approvalByToken(db: Db, token: string): Approval | null {
  if (!isTokenShape(token)) return null;
  const row = db.prepare("SELECT * FROM client_approvals WHERE token_hash = ?").get(sha256(token)) as Row | undefined;
  return row === undefined ? null : toApproval(row);
}

export function filesOf(db: Db, approvalId: string): Array<ApprovalFileRow> {
  return (
    db.prepare("SELECT idx, role, kind, name, mime, size, sha256, width, height FROM client_approval_files WHERE approval_id = ? ORDER BY idx").all(approvalId) as Array<{
      idx: number;
      role: "file" | "logo";
      kind: ApprovalFileKind;
      name: string;
      mime: string;
      size: number;
      sha256: string;
      width: number | null;
      height: number | null;
    }>
  ).map(({ idx, ...rest }) => ({ index: idx, ...rest }));
}

/** Open = not revoked, not expired, files still there. */
export function isOpen(approval: Approval, now = Date.now()): boolean {
  return approval.revokedAt === null && approval.filesDeletedAt === null && Date.parse(approval.expiresAt) > now;
}

/** Counts a view; returns true for the first one (the freelancer gets a notice once). */
export function recordView(db: Db, id: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE client_approvals SET view_count = view_count + 1, last_viewed_at = ?, first_viewed_at = COALESCE(first_viewed_at, ?), status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ? AND first_viewed_at IS NULL",
    )
    .run(now, now, id);
  if (Number(result.changes) > 0) return true;
  db.prepare("UPDATE client_approvals SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?").run(now, id);
  return false;
}

/** The client's decision; only once per link (a new version is a new link). */
export function decide(db: Db, id: string, input: { decision: "approved" | "changes"; comment: string | null; name: string | null }): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE client_approvals SET status = ?, comment = ?, decided_by_name = ?, decided_at = ?, first_viewed_at = COALESCE(first_viewed_at, ?) WHERE id = ? AND decided_at IS NULL AND revoked_at IS NULL",
    )
    .run(input.decision, input.comment, input.name, now, now, id);
  const decided = Number(result.changes) > 0;
  if (decided) recordEvent(db, "approval_link_decided", { companyId: getApproval(db, id)?.companyId ?? null, meta: { decision: input.decision } });
  return decided;
}

export function revoke(db: Db, id: string): boolean {
  const result = db.prepare("UPDATE client_approvals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id);
  return Number(result.changes) > 0;
}

export function markFilesDeleted(db: Db, id: string) {
  db.prepare("UPDATE client_approvals SET files_deleted_at = ? WHERE id = ? AND files_deleted_at IS NULL").run(new Date().toISOString(), id);
}

/** Bytes a company keeps on the hub for links whose files are still there. */
export function storedBytesOf(db: Db, companyId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(total_bytes), 0) AS total FROM client_approvals WHERE company_id = ? AND files_deleted_at IS NULL").get(companyId) as { total: number };
  return Number(row.total);
}

/** Links whose files should go: expired or revoked, files still on disk. */
export function dueForCleanup(db: Db, nowIso: string): Array<string> {
  return (
    db.prepare("SELECT id FROM client_approvals WHERE files_deleted_at IS NULL AND (expires_at <= ? OR revoked_at IS NOT NULL) LIMIT 500").all(nowIso) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Rows (status and comment) are kept 90 days after the link closed, then removed. */
export function pruneOld(db: Db, beforeIso: string): number {
  const result = db.prepare("DELETE FROM client_approvals WHERE files_deleted_at IS NOT NULL AND files_deleted_at <= ?").run(beforeIso);
  return Number(result.changes);
}

export function approvalsOfIds(db: Db, ids: ReadonlyArray<string>): Array<Approval> {
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT * FROM client_approvals WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as unknown as Array<Row>;
  return rows.map(toApproval);
}

export function approvalsOfCompany(db: Db, companyId: string, createdBy: string | null, limit = 100): Array<Approval> {
  const rows = (
    createdBy === null
      ? db.prepare("SELECT * FROM client_approvals WHERE company_id = ? ORDER BY created_at DESC LIMIT ?").all(companyId, limit)
      : db.prepare("SELECT * FROM client_approvals WHERE company_id = ? AND created_by = ? ORDER BY created_at DESC LIMIT ?").all(companyId, createdBy, limit)
  ) as unknown as Array<Row>;
  return rows.map(toApproval);
}
