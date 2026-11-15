// Data access. Plain SQL over node:sqlite; every function takes the db so tests use :memory:.
import type { Db } from "./db.ts";
import { newId, newLoginCode, newSecret, safeEqualHex, sha256 } from "./crypto.ts";
import type { EnvironmentRecord, Role, ShareKind, ShareRecord } from "./policy.ts";
import { recordEvent } from "./growth.ts";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

const LOGIN_CODE_TTL_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
const INVITE_TTL_MS = 14 * 24 * 60 * 60_000;

const nowIso = () => new Date().toISOString();

export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254 ? trimmed : null;
}

// ---- Login -----------------------------------------------------------------------------------

export function startLogin(db: Db, email: string) {
  const code = newLoginCode();
  const link = newSecret("ml");
  const pollSecret = newSecret("mp");
  const id = newId("lc");
  db.prepare(
    "INSERT INTO login_codes (id, email, code_hash, link_hash, poll_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    email,
    sha256(`${id}:${code}`),
    sha256(link),
    sha256(pollSecret),
    Date.now() + LOGIN_CODE_TTL_MS,
  );
  return { id, code, link, pollSecret };
}

interface LoginRow {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
}

/** A code is tried against the newest unused, unexpired request for that address. */
export function verifyLoginCode(db: Db, email: string, code: string): string | null {
  const row = db
    .prepare(
      "SELECT id, email, code_hash, attempts FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    )
    .get(email, Date.now()) as LoginRow | undefined;
  if (row === undefined || row.attempts >= LOGIN_MAX_ATTEMPTS) return null;
  if (!safeEqualHex(row.code_hash, sha256(`${row.id}:${code.trim()}`))) {
    db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return null;
  }
  db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row.email;
}

/** The magic link approves the pending request; the app that started it collects the session. */
export function approveLoginLink(db: Db, link: string): string | null {
  const row = db
    .prepare(
      "SELECT id, email FROM login_codes WHERE link_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(sha256(link), Date.now()) as { id: string; email: string } | undefined;
  if (row === undefined) return null;
  db.prepare("UPDATE login_codes SET approved_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row.email;
}

/** null while waiting; the e-mail once the link was opened (the request is then used up). */
export function pollLogin(db: Db, requestId: string, pollSecret: string): string | null {
  const row = db
    .prepare(
      "SELECT id, email, poll_hash FROM login_codes WHERE id = ? AND used_at IS NULL AND approved_at IS NOT NULL AND expires_at > ?",
    )
    .get(requestId, Date.now()) as { id: string; email: string; poll_hash: string } | undefined;
  if (row === undefined || !safeEqualHex(row.poll_hash, sha256(pollSecret))) return null;
  db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row.email;
}

export function upsertUser(db: Db, email: string, name?: string): User {
  const existing = db.prepare("SELECT id, email, name FROM users WHERE email = ?").get(email) as
    | User
    | undefined;
  if (existing !== undefined) return existing;
  const user = { id: newId("usr"), email, name: name?.trim() || email.split("@")[0] || email };
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
    user.id,
    user.email,
    user.name,
    nowIso(),
  );
  recordEvent(db, "signup", { userId: user.id });
  return user;
}

export function setUserName(db: Db, userId: string, name: string) {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, userId);
}

export function getUser(db: Db, userId: string): User | null {
  return (
    (db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(userId) as User | undefined) ??
    null
  );
}

// ---- Companies -------------------------------------------------------------------------------

export function createCompany(db: Db, userId: string, name: string) {
  const id = newId("co");
  const at = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO companies (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      name,
      userId,
      at,
    );
    db.prepare(
      "INSERT INTO memberships (company_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).run(id, userId, at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  recordEvent(db, "company_created", { companyId: id, userId });
  return { id, name, role: "owner" as Role, createdAt: at };
}

export function roleOf(db: Db, companyId: string, userId: string): Role | null {
  const row = db
    .prepare("SELECT role FROM memberships WHERE company_id = ? AND user_id = ?")
    .get(companyId, userId) as { role: Role } | undefined;
  return row?.role ?? null;
}

export function membershipLookup(db: Db, userId: string) {
  const cache = new Map<string, Role | null>();
  return (companyId: string): Role | null => {
    if (!cache.has(companyId)) cache.set(companyId, roleOf(db, companyId, userId));
    return cache.get(companyId) ?? null;
  };
}

export function companiesOf(db: Db, userId: string) {
  return db
    .prepare(
      "SELECT c.id, c.name, m.role, c.created_at AS createdAt FROM memberships m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? ORDER BY c.name",
    )
    .all(userId) as Array<{ id: string; name: string; role: Role; createdAt: string }>;
}

export function getCompany(db: Db, companyId: string) {
  return (
    (db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId) as
      | { id: string; name: string }
      | undefined) ?? null
  );
}

export function membersOf(db: Db, companyId: string) {
  return db
    .prepare(
      "SELECT u.id AS userId, u.email, u.name, m.role, m.created_at AS joinedAt FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name",
    )
    .all(companyId) as Array<{ userId: string; email: string; name: string; role: Role; joinedAt: string }>;
}

export function ownerCount(db: Db, companyId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'owner'")
    .get(companyId) as { n: number };
  return row.n;
}

export function setRole(db: Db, companyId: string, userId: string, role: Role) {
  db.prepare("UPDATE memberships SET role = ? WHERE company_id = ? AND user_id = ?").run(
    role,
    companyId,
    userId,
  );
}

export function removeMember(db: Db, companyId: string, userId: string) {
  db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = ?").run(companyId, userId);
  // Their shares in this company stop; a runner they own stops serving the company.
  db.prepare(
    "UPDATE shares SET revoked_at = ? WHERE company_id = ? AND (owner_user_id = ? OR audience_user_id = ?) AND revoked_at IS NULL",
  ).run(nowIso(), companyId, userId, userId);
  db.prepare(
    "DELETE FROM environment_runners WHERE company_id = ? AND environment_id IN (SELECT id FROM environments WHERE owner_user_id = ?)",
  ).run(companyId, userId);
  db.prepare(
    "UPDATE shares SET revoked_at = ? WHERE company_id = ? AND kind = 'company' AND revoked_at IS NULL AND environment_id IN (SELECT id FROM environments WHERE owner_user_id = ?)",
  ).run(nowIso(), companyId, userId);
}

// ---- Invites ---------------------------------------------------------------------------------

export function createInvite(
  db: Db,
  input: { companyId: string; email: string | null; role: Role; createdBy: string },
) {
  const token = newSecret("inv");
  const id = newId("iv");
  db.prepare(
    "INSERT INTO invites (id, company_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.companyId,
    input.email,
    input.role,
    sha256(token),
    input.createdBy,
    nowIso(),
    Date.now() + INVITE_TTL_MS,
  );
  recordEvent(db, "invite_sent", { companyId: input.companyId, userId: input.createdBy, meta: { role: input.role, byEmail: input.email !== null } });
  return { id, token };
}

export function pendingInvites(db: Db, companyId: string) {
  return db
    .prepare(
      "SELECT id, email, role, created_by AS createdBy, created_at AS createdAt FROM invites WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    )
    .all(companyId, Date.now()) as Array<{ id: string; email: string | null; role: Role; createdBy: string; createdAt: string }>;
}

export function invitesForEmail(db: Db, email: string) {
  return db
    .prepare(
      "SELECT i.id, i.role, c.id AS companyId, c.name AS companyName FROM invites i JOIN companies c ON c.id = i.company_id WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?",
    )
    .all(email, Date.now()) as Array<{ id: string; role: Role; companyId: string; companyName: string }>;
}

export function revokeInvite(db: Db, companyId: string, inviteId: string) {
  db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND company_id = ?").run(
    nowIso(),
    inviteId,
    companyId,
  );
}

type InviteResult =
  | { ok: true; companyId: string; role: Role }
  | { ok: false; reason: string };

function acceptRow(
  db: Db,
  row: { id: string; company_id: string; email: string | null; role: Role } | undefined,
  user: User,
): InviteResult {
  if (row === undefined) return { ok: false, reason: "This invitation is not valid any more." };
  if (row.email !== null && row.email !== user.email) {
    return { ok: false, reason: `This invitation is for ${row.email}. Sign in with that address.` };
  }
  const existing = roleOf(db, row.company_id, user.id);
  db.exec("BEGIN");
  try {
    if (existing === null) {
      db.prepare(
        "INSERT INTO memberships (company_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      ).run(row.company_id, user.id, row.role, nowIso());
    }
    db.prepare("UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ?").run(
      user.id,
      nowIso(),
      row.id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  recordEvent(db, "invite_accepted", { companyId: row.company_id, userId: user.id, meta: { role: row.role, alreadyMember: existing !== null } });
  return { ok: true, companyId: row.company_id, role: existing ?? row.role };
}

const INVITE_COLUMNS = "id, company_id, email, role";
const INVITE_OPEN = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

export function acceptInviteToken(db: Db, token: string, user: User): InviteResult {
  const row = db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ? AND ${INVITE_OPEN}`)
    .get(sha256(token), Date.now()) as
    | { id: string; company_id: string; email: string | null; role: Role }
    | undefined;
  return acceptRow(db, row, user);
}

/**
 * What the invitation page shows before anyone signs in: the company, who invites and the role.
 * The token is the secret; without a valid, open invitation nothing is returned.
 */
export function previewInvite(db: Db, token: string) {
  const row = db
    .prepare(
      `SELECT i.role AS role, i.email AS email, c.name AS company, u.name AS inviter, u.email AS inviterEmail FROM invites i JOIN companies c ON c.id = i.company_id LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as
    | { role: Role; email: string | null; company: string; inviter: string | null; inviterEmail: string | null }
    | undefined;
  return row ?? null;
}

/** An e-mail invitation is also accepted from the app by id, by the invited address only. */
export function acceptInviteById(db: Db, inviteId: string, user: User): InviteResult {
  const row = db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ? AND email = ? AND ${INVITE_OPEN}`)
    .get(inviteId, user.email, Date.now()) as
    | { id: string; company_id: string; email: string | null; role: Role }
    | undefined;
  return acceptRow(db, row, user);
}

// ---- Environments ----------------------------------------------------------------------------

interface EnvironmentRow {
  id: string;
  owner_user_id: string;
  name: string;
  last_seen_at: string | null;
}

/** v9: one machine may be the runner of several companies (`environment_runners`). */
export function runnerCompaniesOf(db: Db, environmentId: string): Array<string> {
  return (db.prepare("SELECT company_id FROM environment_runners WHERE environment_id = ? ORDER BY created_at, company_id").all(environmentId) as Array<{
    company_id: string;
  }>).map((row) => row.company_id);
}

export type StoredEnvironment = EnvironmentRecord & { name: string; lastSeenAt: string | null };

const toEnvironment = (db: Db, row: EnvironmentRow): StoredEnvironment => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  runnerCompanyIds: runnerCompaniesOf(db, row.id),
  name: row.name,
  lastSeenAt: row.last_seen_at,
});

const ENV_COLUMNS = "id, owner_user_id, name, last_seen_at";

export function registerEnvironment(db: Db, userId: string, name: string) {
  const credential = newSecret("zrc");
  const id = newId("env");
  db.prepare(
    "INSERT INTO environments (id, owner_user_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, name, sha256(credential), nowIso());
  return { id, credential };
}

export function environmentForCredential(db: Db, credential: string) {
  const row = db.prepare(`SELECT ${ENV_COLUMNS} FROM environments WHERE credential_hash = ?`).get(sha256(credential)) as EnvironmentRow | undefined;
  return row === undefined ? null : toEnvironment(db, row);
}

export function getEnvironment(db: Db, id: string) {
  const row = db.prepare(`SELECT ${ENV_COLUMNS} FROM environments WHERE id = ?`).get(id) as EnvironmentRow | undefined;
  return row === undefined ? null : toEnvironment(db, row);
}

export function environmentsOf(db: Db, userId: string) {
  return (
    db.prepare(`SELECT ${ENV_COLUMNS} FROM environments WHERE owner_user_id = ? ORDER BY created_at`).all(userId) as unknown as Array<EnvironmentRow>
  ).map((row) => toEnvironment(db, row));
}

export function runnersOf(db: Db, companyId: string) {
  return db
    .prepare(
      "SELECT e.id, e.name, e.last_seen_at AS lastSeenAt, u.name AS ownerName FROM environment_runners r JOIN environments e ON e.id = r.environment_id JOIN users u ON u.id = e.owner_user_id WHERE r.company_id = ? ORDER BY e.name",
    )
    .all(companyId) as Array<{ id: string; name: string; lastSeenAt: string | null; ownerName: string }>;
}

export function isRunnerOf(db: Db, environmentId: string, companyId: string): boolean {
  return db.prepare("SELECT 1 FROM environment_runners WHERE environment_id = ? AND company_id = ?").get(environmentId, companyId) !== undefined;
}

export function addRunnerCompany(db: Db, environmentId: string, companyId: string) {
  db.prepare("INSERT OR IGNORE INTO environment_runners (environment_id, company_id, created_at) VALUES (?, ?, ?)").run(environmentId, companyId, nowIso());
}

/** The machine stops serving one company: its company chats there stop, its AI account goes. */
export function removeRunnerCompany(db: Db, environmentId: string, companyId: string) {
  db.prepare("DELETE FROM environment_runners WHERE environment_id = ? AND company_id = ?").run(environmentId, companyId);
  db.prepare(
    "UPDATE shares SET revoked_at = ? WHERE environment_id = ? AND company_id = ? AND kind = 'company' AND revoked_at IS NULL",
  ).run(nowIso(), environmentId, companyId);
}

export function touchEnvironment(db: Db, environmentId: string) {
  db.prepare("UPDATE environments SET last_seen_at = ? WHERE id = ?").run(nowIso(), environmentId);
}

export function renameEnvironment(db: Db, environmentId: string, name: string) {
  db.prepare("UPDATE environments SET name = ? WHERE id = ?").run(name, environmentId);
}

// ---- Shares ----------------------------------------------------------------------------------

interface ShareRow {
  id: string;
  environment_id: string;
  thread_id: string;
  owner_user_id: string;
  company_id: string;
  kind: ShareKind;
  audience_user_id: string | null;
  title: string;
  title_sealed: string | null;
  handover_state: ShareRecord["handoverState"];
  created_at: string;
  revoked_at: string | null;
}

/**
 * `title` is plaintext only on rows made before v4 (legacy); new shares keep it empty and carry
 * `titleSealed`, sealed by the owner's runner to its own key (only that runner opens it).
 */
export type StoredShare = ShareRecord & {
  readonly title: string;
  readonly titleSealed: string | null;
  readonly createdAt: string;
};

const toShare = (row: ShareRow): StoredShare => ({
  id: row.id,
  environmentId: row.environment_id,
  threadId: row.thread_id,
  ownerUserId: row.owner_user_id,
  companyId: row.company_id,
  kind: row.kind,
  audienceUserId: row.audience_user_id,
  title: row.title,
  titleSealed: row.title_sealed,
  handoverState: row.handover_state,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});

export function createShare(
  db: Db,
  input: {
    environmentId: string;
    threadId: string;
    ownerUserId: string;
    companyId: string;
    kind: ShareKind;
    audienceUserId: string | null;
    titleSealed: string | null;
  },
): StoredShare {
  const id = newId("sh");
  // One live share per thread, audience and kind: sharing again replaces the old record.
  db.prepare(
    "UPDATE shares SET revoked_at = ? WHERE environment_id = ? AND thread_id = ? AND kind = ? AND company_id = ? AND COALESCE(audience_user_id, '') = COALESCE(?, '') AND revoked_at IS NULL",
  ).run(nowIso(), input.environmentId, input.threadId, input.kind, input.companyId, input.audienceUserId);
  db.prepare(
    "INSERT INTO shares (id, environment_id, thread_id, owner_user_id, company_id, kind, audience_user_id, title, title_sealed, handover_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)",
  ).run(
    id,
    input.environmentId,
    input.threadId,
    input.ownerUserId,
    input.companyId,
    input.kind,
    input.audienceUserId,
    input.titleSealed,
    input.kind === "handover" ? "pending" : null,
    nowIso(),
  );
  return getShare(db, id)!;
}

export function getShare(db: Db, id: string): StoredShare | null {
  const row = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as ShareRow | undefined;
  return row === undefined ? null : toShare(row);
}

/** Live shares the user can possibly see: theirs, addressed to them, or company-wide. */
export function candidateSharesFor(db: Db, userId: string): Array<StoredShare> {
  return (
    db
      .prepare(
        `SELECT s.* FROM shares s
         WHERE s.revoked_at IS NULL AND (
           s.owner_user_id = ? OR s.audience_user_id = ? OR
           (s.audience_user_id IS NULL AND s.company_id IN (SELECT company_id FROM memberships WHERE user_id = ?))
         ) ORDER BY s.created_at DESC LIMIT 500`,
      )
      .all(userId, userId, userId) as unknown as Array<ShareRow>
  ).map(toShare);
}

export function liveSharesOfEnvironment(db: Db, environmentId: string): Array<StoredShare> {
  return (
    db
      .prepare("SELECT * FROM shares WHERE environment_id = ? AND revoked_at IS NULL")
      .all(environmentId) as unknown as Array<ShareRow>
  ).map(toShare);
}

export function revokeShare(db: Db, shareId: string) {
  db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    nowIso(),
    shareId,
  );
}

export function setHandoverState(db: Db, shareId: string, state: "completed" | "declined") {
  db.prepare("UPDATE shares SET handover_state = ?, revoked_at = ? WHERE id = ?").run(
    state,
    nowIso(),
    shareId,
  );
}

/**
 * A comment as the hub keeps it: v4 rows hold only `sealed` (ciphertext for the share's runner)
 * and the author's device signature; rows from before v4 hold a plaintext `body` (legacy).
 */
export function addComment(
  db: Db,
  input: { shareId: string; authorUserId: string; sealed: string; sig: string; deviceKeyId: string },
) {
  const id = newId("cm");
  const at = nowIso();
  db.prepare(
    "INSERT INTO comments (id, share_id, author_user_id, message_id, body, sealed, sig, device_key_id, created_at) VALUES (?, ?, ?, NULL, '', ?, ?, ?, ?)",
  ).run(id, input.shareId, input.authorUserId, input.sealed, input.sig, input.deviceKeyId, at);
  return { id, createdAt: at };
}

export interface StoredComment {
  readonly id: string;
  readonly createdAt: string;
  readonly authorId: string;
  readonly authorName: string;
  /** Only on legacy rows (before v4). */
  readonly messageId: string | null;
  readonly body: string | null;
  /** v4 rows: ciphertext, signature JSON and the author's device key id. */
  readonly sealed: string | null;
  readonly sig: string | null;
  readonly deviceKeyId: string | null;
}

export function commentsOf(db: Db, shareId: string): Array<StoredComment> {
  const rows = db
    .prepare(
      "SELECT c.id, c.message_id, c.body, c.sealed, c.sig, c.device_key_id, c.created_at, u.id AS author_id, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_user_id WHERE c.share_id = ? ORDER BY c.created_at, c.rowid",
    )
    .all(shareId) as Array<{
    id: string;
    message_id: string | null;
    body: string;
    sealed: string | null;
    sig: string | null;
    device_key_id: string | null;
    created_at: string;
    author_id: string;
    author_name: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    authorId: row.author_id,
    authorName: row.author_name,
    messageId: row.sealed === null ? row.message_id : null,
    body: row.sealed === null ? row.body : null,
    sealed: row.sealed,
    sig: row.sig,
    deviceKeyId: row.device_key_id,
  }));
}
