// SQL for the community library (migration v8): authors, packs, versions, review decisions,
// reports, install counts and reviewer preview links. The route module (routes/library.ts) does the
// checks and authorization; this file only reads and writes rows.
//
// Credit, not money: an author has a name, a company, their packs and the installs they gathered.
// A later "earn" model would read `installCounts` per author and pack and keep its own tables; nothing
// here pays, prices or promises anything.
import { newId, sha256 } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { CheckResult, PackMeta } from "./library/checks.ts";

const nowIso = () => new Date().toISOString();

export type VersionStatus = "pending" | "changes_requested" | "published" | "rejected" | "superseded" | "withdrawn";
export type Decision = "approve" | "changes" | "reject";

export interface Author {
  readonly userId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly company: string | null;
  readonly bio: string | null;
  readonly featured: boolean;
}

export interface LibraryPack {
  readonly id: string;
  readonly packId: string;
  readonly slug: string;
  readonly authorUserId: string;
  readonly state: "new" | "published" | "unpublished";
  readonly publishedVersionId: string | null;
  readonly featured: boolean;
  readonly unpublishedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredScreenshot {
  readonly name: string;
  readonly mime: string;
  readonly data: string;
}

export interface LibraryVersion {
  readonly id: string;
  readonly packRef: string;
  readonly version: string;
  readonly status: VersionStatus;
  readonly meta: PackMeta;
  readonly files: Map<string, Buffer>;
  readonly screenshots: Array<StoredScreenshot>;
  readonly workflows: Array<string> | null;
  readonly sha256: string;
  readonly size: number;
  readonly checks: Array<CheckResult>;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reviewNote: string | null;
  readonly signerKeyId: string;
}

// ---- Reviewers -------------------------------------------------------------------------------

/**
 * A hub reviewer: in the hub_staff table as reviewer or operator (v15), or listed by e-mail in the
 * bootstrap variables (HUB_LIBRARY_REVIEWERS, and the operators' HUB_ADMIN_EMAILS / HUB_STATS_EMAILS).
 */
export function isReviewer(db: Db, user: { id: string; email: string }, configured: ReadonlyArray<string>): boolean {
  if (configured.includes(user.email.toLowerCase())) return true;
  return db.prepare("SELECT 1 FROM hub_staff WHERE user_id = ? AND role IN ('reviewer', 'operator')").get(user.id) !== undefined;
}

export function addReviewer(db: Db, userId: string, grantedBy: string | null) {
  db.prepare("INSERT INTO hub_staff (user_id, role, granted_by, created_at) VALUES (?, 'reviewer', ?, ?) ON CONFLICT(user_id) DO NOTHING").run(userId, grantedBy, nowIso());
}

// ---- Authors ---------------------------------------------------------------------------------

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length >= 2 ? slug : `autor-${slug}`;
}

function uniqueSlug(db: Db, table: "library_authors" | "library_packs", base: string): string {
  let candidate = base;
  for (let n = 2; db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).get(candidate) !== undefined; n += 1) candidate = `${base}-${n}`;
  return candidate;
}

const authorRow = (row: Record<string, unknown> | undefined): Author | null =>
  row === undefined
    ? null
    : {
        userId: row.user_id as string,
        slug: row.slug as string,
        displayName: row.display_name as string,
        company: (row.company as string | null) ?? null,
        bio: (row.bio as string | null) ?? null,
        featured: row.featured === 1,
      };

export function authorOf(db: Db, userId: string): Author | null {
  return authorRow(db.prepare("SELECT * FROM library_authors WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined);
}

export function authorBySlug(db: Db, slug: string): Author | null {
  return authorRow(db.prepare("SELECT * FROM library_authors WHERE slug = ?").get(slug) as Record<string, unknown> | undefined);
}

/** The author record, created from the account name on the first submission. */
export function ensureAuthor(db: Db, user: { id: string; name: string; email: string }): Author {
  const existing = authorOf(db, user.id);
  if (existing !== null) return existing;
  const name = user.name.trim() || user.email.split("@")[0]!;
  const now = nowIso();
  db.prepare("INSERT INTO library_authors (user_id, slug, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    user.id,
    uniqueSlug(db, "library_authors", slugify(name)),
    name,
    now,
    now,
  );
  return authorOf(db, user.id)!;
}

export function updateAuthor(db: Db, userId: string, input: { displayName: string; company: string | null; bio: string | null }) {
  db.prepare("UPDATE library_authors SET display_name = ?, company = ?, bio = ?, updated_at = ? WHERE user_id = ?").run(
    input.displayName,
    input.company,
    input.bio,
    nowIso(),
    userId,
  );
}

export function setAuthorFeatured(db: Db, slug: string, featured: boolean): boolean {
  return db.prepare("UPDATE library_authors SET featured = ?, updated_at = ? WHERE slug = ?").run(featured ? 1 : 0, nowIso(), slug).changes > 0;
}

// ---- Packs and versions ----------------------------------------------------------------------

const packRow = (row: Record<string, unknown> | undefined): LibraryPack | null =>
  row === undefined
    ? null
    : {
        id: row.id as string,
        packId: row.pack_id as string,
        slug: row.slug as string,
        authorUserId: row.author_user_id as string,
        state: row.state as LibraryPack["state"],
        publishedVersionId: (row.published_version_id as string | null) ?? null,
        featured: row.featured === 1,
        unpublishedReason: (row.unpublished_reason as string | null) ?? null,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };

export function packByPackId(db: Db, packId: string): LibraryPack | null {
  return packRow(db.prepare("SELECT * FROM library_packs WHERE pack_id = ?").get(packId) as Record<string, unknown> | undefined);
}

export function packBySlug(db: Db, slug: string): LibraryPack | null {
  return packRow(db.prepare("SELECT * FROM library_packs WHERE slug = ?").get(slug) as Record<string, unknown> | undefined);
}

export function packByRef(db: Db, id: string): LibraryPack | null {
  return packRow(db.prepare("SELECT * FROM library_packs WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

export function packsOfAuthor(db: Db, userId: string): Array<LibraryPack> {
  return (db.prepare("SELECT * FROM library_packs WHERE author_user_id = ? ORDER BY created_at").all(userId) as Array<Record<string, unknown>>).map((row) => packRow(row)!);
}

export function createPack(db: Db, input: { packId: string; title: string; authorUserId: string }): LibraryPack {
  const now = nowIso();
  const id = newId("lp");
  db.prepare("INSERT INTO library_packs (id, pack_id, slug, author_user_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'new', ?, ?)").run(
    id,
    input.packId,
    uniqueSlug(db, "library_packs", slugify(input.title)),
    input.authorUserId,
    now,
    now,
  );
  return packByRef(db, id)!;
}

const versionRow = (row: Record<string, unknown> | undefined): LibraryVersion | null => {
  if (row === undefined) return null;
  const files = JSON.parse(row.files as string) as Record<string, string>;
  return {
    id: row.id as string,
    packRef: row.pack_ref as string,
    version: row.version as string,
    status: row.status as VersionStatus,
    meta: JSON.parse(row.meta as string) as PackMeta,
    files: new Map(Object.entries(files).map(([path, data]) => [path, Buffer.from(data, "base64")])),
    screenshots: JSON.parse(row.screenshots as string) as Array<StoredScreenshot>,
    workflows: row.workflows === null ? null : (JSON.parse(row.workflows as string) as Array<string>),
    sha256: row.sha256 as string,
    size: row.size as number,
    checks: JSON.parse(row.checks as string) as Array<CheckResult>,
    submittedBy: row.submitted_by as string,
    submittedAt: row.submitted_at as string,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
    reviewNote: (row.review_note as string | null) ?? null,
    signerKeyId: row.signer_key_id as string,
  };
};

const VERSION_COLUMNS =
  "id, pack_ref, version, status, meta, files, screenshots, workflows, sha256, size, checks, submitted_by, submitted_at, decided_by, decided_at, review_note, signer_key_id";

export function getVersion(db: Db, id: string): LibraryVersion | null {
  return versionRow(db.prepare(`SELECT ${VERSION_COLUMNS} FROM library_versions WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
}

export function versionsOf(db: Db, packRef: string): Array<LibraryVersion> {
  return (db.prepare(`SELECT ${VERSION_COLUMNS} FROM library_versions WHERE pack_ref = ? ORDER BY submitted_at DESC`).all(packRef) as Array<Record<string, unknown>>).map(
    (row) => versionRow(row)!,
  );
}

/** The approved (published or superseded) row with this version number: earlier submissions may share it. */
export function versionByNumber(db: Db, packRef: string, version: string): LibraryVersion | null {
  return versionRow(
    db.prepare(`SELECT ${VERSION_COLUMNS} FROM library_versions WHERE pack_ref = ? AND version = ? AND status IN ('published', 'superseded') ORDER BY submitted_at DESC`).get(packRef, version) as
      | Record<string, unknown>
      | undefined,
  );
}

export function archiveOf(db: Db, versionId: string): Buffer | null {
  const row = db.prepare("SELECT archive FROM library_versions WHERE id = ?").get(versionId) as { archive: Uint8Array } | undefined;
  return row === undefined ? null : Buffer.from(row.archive);
}

export function addVersion(
  db: Db,
  input: {
    packRef: string;
    version: string;
    meta: PackMeta;
    files: ReadonlyMap<string, Buffer>;
    screenshots: ReadonlyArray<StoredScreenshot>;
    workflows: ReadonlyArray<string> | null;
    archive: Buffer;
    sha256: string;
    checks: ReadonlyArray<CheckResult>;
    statement: string;
    signerKeyId: string;
    signature: string;
    submittedBy: string;
  },
): LibraryVersion {
  const id = newId("lv");
  // An older submission still waiting is replaced by the new one (the author sent a fix).
  db.prepare("UPDATE library_versions SET status = 'withdrawn', decided_at = ? WHERE pack_ref = ? AND status IN ('pending', 'changes_requested')").run(nowIso(), input.packRef);
  db.prepare(
    `INSERT INTO library_versions (id, pack_ref, version, status, meta, files, screenshots, workflows, archive, sha256, size, checks, statement, signer_key_id, signature, submitted_by, submitted_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.packRef,
    input.version,
    JSON.stringify(input.meta),
    JSON.stringify(Object.fromEntries([...input.files].map(([path, bytes]) => [path, bytes.toString("base64")]))),
    JSON.stringify(input.screenshots),
    input.workflows === null ? null : JSON.stringify(input.workflows),
    input.archive,
    input.sha256,
    input.archive.length,
    JSON.stringify(input.checks),
    input.statement,
    input.signerKeyId,
    input.signature,
    input.submittedBy,
    nowIso(),
  );
  db.prepare("UPDATE library_packs SET updated_at = ? WHERE id = ?").run(nowIso(), input.packRef);
  return getVersion(db, id)!;
}

/** Waiting for a reviewer, oldest first. */
export function queue(db: Db): Array<LibraryVersion> {
  return (db.prepare(`SELECT ${VERSION_COLUMNS} FROM library_versions WHERE status = 'pending' ORDER BY submitted_at`).all() as Array<Record<string, unknown>>).map((row) => versionRow(row)!);
}

export function decide(db: Db, input: { versionId: string; decision: Decision; note: string; reviewerUserId: string }): LibraryVersion {
  const version = getVersion(db, input.versionId)!;
  const now = nowIso();
  const status: VersionStatus = input.decision === "approve" ? "published" : input.decision === "changes" ? "changes_requested" : "rejected";
  db.exec("BEGIN");
  try {
    if (status === "published") {
      db.prepare("UPDATE library_versions SET status = 'superseded' WHERE pack_ref = ? AND status = 'published'").run(version.packRef);
      db.prepare("UPDATE library_packs SET state = 'published', published_version_id = ?, unpublished_reason = NULL, updated_at = ? WHERE id = ?").run(version.id, now, version.packRef);
    }
    db.prepare("UPDATE library_versions SET status = ?, decided_by = ?, decided_at = ?, review_note = ? WHERE id = ?").run(status, input.reviewerUserId, now, input.note, version.id);
    db.prepare("INSERT INTO library_reviews (id, version_id, reviewer_user_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      newId("lr"),
      version.id,
      input.reviewerUserId,
      input.decision,
      input.note,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getVersion(db, version.id)!;
}

export function reviewsOf(db: Db, versionId: string) {
  return db
    .prepare(
      "SELECT r.id, r.decision, r.note, r.created_at AS createdAt, u.name AS reviewerName FROM library_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id WHERE r.version_id = ? ORDER BY r.created_at",
    )
    .all(versionId) as Array<{ id: string; decision: Decision; note: string; createdAt: string; reviewerName: string | null }>;
}

export function setPackState(db: Db, packRef: string, state: "published" | "unpublished", reason: string | null) {
  db.prepare("UPDATE library_packs SET state = ?, unpublished_reason = ?, updated_at = ? WHERE id = ?").run(state, reason, nowIso(), packRef);
}

export function setPackFeatured(db: Db, packRef: string, featured: boolean) {
  db.prepare("UPDATE library_packs SET featured = ?, updated_at = ? WHERE id = ?").run(featured ? 1 : 0, nowIso(), packRef);
}

/** Published packs (with a published version), featured first, then by installs. */
export function publishedPacks(db: Db): Array<LibraryPack & { installs: number }> {
  return (
    db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM library_installs i WHERE i.pack_ref = p.id) AS installs FROM library_packs p
         WHERE p.state = 'published' AND p.published_version_id IS NOT NULL ORDER BY p.featured DESC, installs DESC, p.created_at`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...packRow(row)!, installs: row.installs as number }));
}

export function unpublishedPacks(db: Db): Array<LibraryPack> {
  return (db.prepare("SELECT * FROM library_packs WHERE state = 'unpublished'").all() as Array<Record<string, unknown>>).map((row) => packRow(row)!);
}

// ---- Installs ----------------------------------------------------------------------------------

/** Counts one install per person (or per anonymous address) and pack. */
export function countInstall(db: Db, packRef: string, installer: string): boolean {
  return (
    db.prepare("INSERT INTO library_installs (pack_ref, installer, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(packRef, sha256(installer), nowIso()).changes > 0
  );
}

export function installsOf(db: Db, packRef: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM library_installs WHERE pack_ref = ?").get(packRef) as { n: number }).n;
}

/** Installs per pack of one author: the input a later "earn" model would read. */
export function installCounts(db: Db, authorUserId: string): Array<{ packRef: string; installs: number }> {
  return db
    .prepare(
      "SELECT p.id AS packRef, (SELECT COUNT(*) FROM library_installs i WHERE i.pack_ref = p.id) AS installs FROM library_packs p WHERE p.author_user_id = ?",
    )
    .all(authorUserId) as Array<{ packRef: string; installs: number }>;
}

// ---- Reports ----------------------------------------------------------------------------------

export function addReport(db: Db, input: { packRef: string; reporterUserId: string | null; reason: string; detail: string }): string {
  const id = newId("rp");
  db.prepare("INSERT INTO library_reports (id, pack_ref, reporter_user_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(
    id,
    input.packRef,
    input.reporterUserId,
    input.reason,
    input.detail,
    nowIso(),
  );
  return id;
}

export function reportsOf(db: Db, status: "open" | "resolved" | null) {
  return db
    .prepare(
      `SELECT r.id, r.reason, r.detail, r.status, r.resolution, r.created_at AS createdAt, r.resolved_at AS resolvedAt, p.slug, p.pack_id AS packId, p.state AS packState
       FROM library_reports r JOIN library_packs p ON p.id = r.pack_ref ${status === null ? "" : "WHERE r.status = ?"} ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all(...(status === null ? [] : [status])) as Array<Record<string, unknown>>;
}

export function openReportCount(db: Db, packRef: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM library_reports WHERE pack_ref = ? AND status = 'open'").get(packRef) as { n: number }).n;
}

export function resolveReport(db: Db, id: string, resolution: string, userId: string): boolean {
  return (
    db.prepare("UPDATE library_reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(resolution, userId, nowIso(), id)
      .changes > 0
  );
}

// ---- Reviewer previews -------------------------------------------------------------------------

export const PREVIEW_TTL_MS = 2 * 60 * 60_000;

export function createPreview(db: Db, versionId: string, userId: string, token: string) {
  db.prepare("DELETE FROM library_previews WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO library_previews (token_hash, version_id, created_by, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), versionId, userId, Date.now() + PREVIEW_TTL_MS);
}

export function previewVersion(db: Db, token: string): string | null {
  const row = db.prepare("SELECT version_id FROM library_previews WHERE token_hash = ? AND expires_at > ?").get(sha256(token), Date.now()) as { version_id: string } | undefined;
  return row?.version_id ?? null;
}

// ---- Audit ----------------------------------------------------------------------------------

export function libraryAudit(db: Db, limit = 200) {
  return db
    .prepare(
      "SELECT a.id, a.action, a.detail, a.created_at AS createdAt, u.name AS actorName FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.company_id IS NULL AND a.action LIKE 'library.%' ORDER BY a.created_at DESC LIMIT ?",
    )
    .all(limit) as Array<{ id: string; action: string; detail: string; createdAt: string; actorName: string | null }>;
}
