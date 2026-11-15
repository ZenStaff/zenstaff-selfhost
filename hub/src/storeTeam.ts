// SQL for what the hub is the source of truth for besides membership: Enterprise pack grants,
// company settings (company memory address, never its key), per-person edition and language,
// Academy team progress, notifications, the admin audit log and runner metadata.
import { auditLogOf, type PLATFORM_CHAIN } from "./auditChain.ts";
import type { Db } from "./db.ts";
import { newId } from "./crypto.ts";
import type { Role } from "./policy.ts";

const nowIso = () => new Date().toISOString();

// ---- Per-person preferences ------------------------------------------------------------------

export type Edition = "office" | "code";
export type Language = "en" | "ro";

export function preferencesOf(db: Db, userId: string) {
  const row = db.prepare("SELECT edition, language, notify_email FROM users WHERE id = ?").get(userId) as
    | { edition: Edition | null; language: Language | null; notify_email: number }
    | undefined;
  return {
    edition: row?.edition ?? null,
    language: row?.language ?? null,
    notifyEmail: (row?.notify_email ?? 1) === 1,
  };
}

/** The language of the account with this e-mail address, if there is one and it chose one. */
export function languageOfEmail(db: Db, email: string): Language | null {
  const row = db.prepare("SELECT language FROM users WHERE email = ?").get(email) as { language: Language | null } | undefined;
  return row?.language ?? null;
}

export function setPreferences(
  db: Db,
  userId: string,
  input: { edition?: Edition | null; language?: Language | null; notifyEmail?: boolean },
) {
  if (input.edition !== undefined) db.prepare("UPDATE users SET edition = ? WHERE id = ?").run(input.edition, userId);
  if (input.language !== undefined) db.prepare("UPDATE users SET language = ? WHERE id = ?").run(input.language, userId);
  if (input.notifyEmail !== undefined) {
    db.prepare("UPDATE users SET notify_email = ? WHERE id = ?").run(input.notifyEmail ? 1 : 0, userId);
  }
}

// ---- Enterprise pack grants ------------------------------------------------------------------

export interface PackGrant {
  readonly id: string;
  readonly companyId: string;
  readonly packId: string;
  readonly kind: "use" | "install";
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly grantedBy: string;
  readonly grantedByName: string;
  /** The signed statement (canonical JSON) and its signature, so runners can check the admin. */
  readonly statement: string;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly createdAt: string;
}

export function addGrant(
  db: Db,
  input: {
    companyId: string;
    packId: string;
    kind: "use" | "install";
    userId: string | null;
    grantedBy: string;
    statement: string;
    signerKeyId: string;
    signature: string;
  },
): string {
  const id = newId("gr");
  db.prepare(
    "UPDATE pack_grants SET revoked_at = ? WHERE company_id = ? AND pack_id = ? AND kind = ? AND COALESCE(user_id, '') = COALESCE(?, '') AND revoked_at IS NULL",
  ).run(nowIso(), input.companyId, input.packId, input.kind, input.userId);
  db.prepare(
    "INSERT INTO pack_grants (id, company_id, pack_id, kind, user_id, granted_by, statement, signer_key_id, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.companyId, input.packId, input.kind, input.userId, input.grantedBy, input.statement, input.signerKeyId, input.signature, nowIso());
  return id;
}

export function revokeGrant(db: Db, companyId: string, grantId: string): boolean {
  return (
    Number(
      db
        .prepare("UPDATE pack_grants SET revoked_at = ? WHERE id = ? AND company_id = ? AND revoked_at IS NULL")
        .run(nowIso(), grantId, companyId).changes,
    ) > 0
  );
}

export function grantsOf(db: Db, companyId: string, onlyUserId: string | null = null): Array<PackGrant> {
  return (
    db
      .prepare(
        `SELECT g.*, u.email AS user_email, a.name AS granted_by_name FROM pack_grants g
         LEFT JOIN users u ON u.id = g.user_id JOIN users a ON a.id = g.granted_by
         WHERE g.company_id = ? AND g.revoked_at IS NULL AND (? IS NULL OR g.user_id = ? OR g.kind = 'install')
         ORDER BY g.created_at`,
      )
      .all(companyId, onlyUserId, onlyUserId) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    packId: String(row.pack_id),
    kind: row.kind as "use" | "install",
    userId: (row.user_id as string | null) ?? null,
    userEmail: (row.user_email as string | null) ?? null,
    grantedBy: String(row.granted_by),
    grantedByName: String(row.granted_by_name),
    statement: String(row.statement),
    signerKeyId: String(row.signer_key_id),
    signature: String(row.signature),
    createdAt: String(row.created_at),
  }));
}

// ---- Company settings ------------------------------------------------------------------------

export function companySettings(db: Db, companyId: string) {
  const row = db.prepare("SELECT memory_url, memory_save, updated_at FROM company_settings WHERE company_id = ?").get(companyId) as
    | { memory_url: string | null; memory_save: number; updated_at: string }
    | undefined;
  return {
    memory: { url: row?.memory_url ?? null, saveConversations: (row?.memory_save ?? 0) === 1 },
    updatedAt: row?.updated_at ?? null,
  };
}

export function setCompanyMemorySettings(
  db: Db,
  companyId: string,
  userId: string,
  input: { url: string | null; saveConversations: boolean },
) {
  db.prepare(
    "INSERT INTO company_settings (company_id, memory_url, memory_save, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET memory_url = excluded.memory_url, memory_save = excluded.memory_save, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
  ).run(companyId, input.url, input.saveConversations ? 1 : 0, userId, nowIso());
}

// ---- Academy team progress -------------------------------------------------------------------

export function setLessonDone(db: Db, companyId: string, userId: string, lessonId: string, done: boolean) {
  if (done) {
    db.prepare(
      "INSERT INTO academy_progress (company_id, user_id, lesson_id, done_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(companyId, userId, lessonId, nowIso());
  } else {
    db.prepare("DELETE FROM academy_progress WHERE company_id = ? AND user_id = ? AND lesson_id = ?").run(companyId, userId, lessonId);
  }
}

export function progressOf(db: Db, companyId: string, onlyUserId: string | null) {
  return db
    .prepare(
      `SELECT p.user_id AS userId, u.name, u.email, p.lesson_id AS lessonId, p.done_at AS doneAt
       FROM academy_progress p JOIN users u ON u.id = p.user_id
       WHERE p.company_id = ? AND (? IS NULL OR p.user_id = ?) ORDER BY u.name, p.done_at`,
    )
    .all(companyId, onlyUserId, onlyUserId) as Array<{
    userId: string;
    name: string;
    email: string;
    lessonId: string;
    doneAt: string;
  }>;
}

/** Topic counts and sanitized no-result searches, as the app's signals seam produces them. */
export function setSignals(
  db: Db,
  companyId: string,
  userId: string,
  topics: Record<string, number>,
  searches: Array<string>,
) {
  db.prepare(
    "INSERT INTO academy_signals (company_id, user_id, topics, searches, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id, user_id) DO UPDATE SET topics = excluded.topics, searches = excluded.searches, updated_at = excluded.updated_at",
  ).run(companyId, userId, JSON.stringify(topics), JSON.stringify(searches), nowIso());
}

/** Company-wide totals only: who asked what is not shown, just how often a topic comes up. */
export function signalTotals(db: Db, companyId: string) {
  const rows = db.prepare("SELECT topics, searches FROM academy_signals WHERE company_id = ?").all(companyId) as Array<{
    topics: string;
    searches: string;
  }>;
  const topics: Record<string, number> = {};
  const searches: Record<string, number> = {};
  for (const row of rows) {
    for (const [topic, count] of Object.entries(JSON.parse(row.topics) as Record<string, number>)) {
      topics[topic] = (topics[topic] ?? 0) + count;
    }
    for (const search of JSON.parse(row.searches) as Array<string>) searches[search] = (searches[search] ?? 0) + 1;
  }
  return { people: rows.length, topics, searches };
}

// ---- Notifications ---------------------------------------------------------------------------

export function addNotification(
  db: Db,
  input: {
    userId: string;
    kind: string;
    companyId: string | null;
    shareId: string | null;
    actorUserId: string | null;
    title: string;
    body: string;
  },
) {
  db.prepare(
    "INSERT INTO notifications (id, user_id, kind, company_id, share_id, actor_user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    newId("nt"),
    input.userId,
    input.kind,
    input.companyId,
    input.shareId,
    input.actorUserId,
    input.title.slice(0, 200),
    input.body.slice(0, 1000),
    nowIso(),
  );
}

export function notificationsOf(db: Db, userId: string, limit = 50) {
  return db
    .prepare(
      "SELECT n.id, n.kind, n.company_id AS companyId, n.share_id AS shareId, n.actor_user_id AS actorId, u.name AS actorName, n.title, n.body, n.created_at AS createdAt, n.read_at AS readAt FROM notifications n LEFT JOIN users u ON u.id = n.actor_user_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?",
    )
    .all(userId, limit) as Array<{
    id: string;
    kind: string;
    companyId: string | null;
    shareId: string | null;
    actorId: string | null;
    actorName: string | null;
    title: string;
    body: string;
    createdAt: string;
    readAt: string | null;
  }>;
}

export function markNotificationsRead(db: Db, userId: string, ids: ReadonlyArray<string> | null) {
  if (ids === null) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowIso(), userId);
    return;
  }
  const update = db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL");
  for (const id of ids) update.run(nowIso(), userId, id);
}

export function unreadCount(db: Db, userId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId) as { n: number }
  ).n;
}

// ---- Audit log -------------------------------------------------------------------------------

/**
 * One admin or security event: the short list the dashboard has always shown (`audit_log`) and the
 * tamper-evident log (auditChain.ts, separate file, with address, device and user agent).
 */
export function audit(
  db: Db,
  input: { companyId: string | null; actorUserId: string | null; action: string; detail: string; target?: string | null; meta?: Record<string, unknown>; chain?: typeof PLATFORM_CHAIN },
) {
  const chained = auditLogOf(db);
  if (chained !== null) {
    const actor =
      input.actorUserId === null
        ? undefined
        : (db.prepare("SELECT email, name FROM users WHERE id = ?").get(input.actorUserId) as { email: string; name: string } | undefined);
    chained.append({
      companyId: input.companyId,
      ...(input.chain === undefined ? {} : { chain: input.chain }),
      actorUserId: input.actorUserId,
      actorEmail: actor?.email ?? null,
      actorName: actor?.name ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: { summary: input.detail.slice(0, 1000), ...input.meta },
    });
  }
  db.prepare("INSERT INTO audit_log (id, company_id, actor_user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("au"),
    input.companyId,
    input.actorUserId,
    input.action,
    input.detail.slice(0, 1000),
    nowIso(),
  );
}

export function auditOf(db: Db, companyId: string, limit = 100) {
  return db
    .prepare(
      "SELECT a.id, a.action, a.detail, a.created_at AS createdAt, u.name AS actorName FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.company_id = ? ORDER BY a.created_at DESC LIMIT ?",
    )
    .all(companyId, limit) as Array<{ id: string; action: string; detail: string; createdAt: string; actorName: string | null }>;
}

/** Owners and admins of a company: they receive the admin-action e-mails. */
export function managersOf(db: Db, companyId: string) {
  return db
    .prepare(
      "SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.role IN ('owner', 'admin')",
    )
    .all(companyId) as Array<{ id: string; email: string; name: string; role: Role }>;
}

export function rolesOfUser(db: Db, userId: string): Array<Role> {
  return (db.prepare("SELECT role FROM memberships WHERE user_id = ?").all(userId) as Array<{ role: Role }>).map(
    (row) => row.role,
  );
}

// ---- Runner metadata -------------------------------------------------------------------------

export interface AiAccount {
  readonly provider: "claude" | "codex";
  readonly mode: "seat" | "api-key";
  /** What people see, e.g. "Claude Team seat (ops@acme.example)" or "Company API key". */
  readonly label: string;
  readonly updatedAt: string;
}

/** The AI account a runner uses for one company (v9: per machine and company). */
export function setAiAccount(db: Db, environmentId: string, companyId: string, account: AiAccount | null) {
  db.prepare("UPDATE environment_runners SET ai_account = ? WHERE environment_id = ? AND company_id = ?").run(
    account === null ? null : JSON.stringify(account),
    environmentId,
    companyId,
  );
}

export function aiAccountOf(db: Db, environmentId: string, companyId: string): AiAccount | null {
  const row = db.prepare("SELECT ai_account FROM environment_runners WHERE environment_id = ? AND company_id = ?").get(environmentId, companyId) as
    | { ai_account: string | null }
    | undefined;
  return row?.ai_account ? (JSON.parse(row.ai_account) as AiAccount) : null;
}

/** Whether one of the company's servers recorded a company API key (label only, never the key). */
export function companyHasApiKey(db: Db, companyId: string): boolean {
  const rows = db.prepare("SELECT ai_account FROM environment_runners WHERE company_id = ? AND ai_account IS NOT NULL").all(companyId) as Array<{
    ai_account: string;
  }>;
  return rows.some((row) => {
    try {
      return (JSON.parse(row.ai_account) as Partial<AiAccount>).mode === "api-key";
    } catch {
      return false;
    }
  });
}

export function setEnvironmentKeys(db: Db, environmentId: string, signPublicKey: string, boxPublicKey: string) {
  db.prepare("UPDATE environments SET sign_public_key = ?, box_public_key = ? WHERE id = ?").run(
    signPublicKey,
    boxPublicKey,
    environmentId,
  );
}

export function environmentKeys(db: Db, environmentId: string) {
  const row = db.prepare("SELECT sign_public_key, box_public_key FROM environments WHERE id = ?").get(environmentId) as
    | { sign_public_key: string | null; box_public_key: string | null }
    | undefined;
  return row?.sign_public_key && row.box_public_key
    ? { signPublicKey: row.sign_public_key, boxPublicKey: row.box_public_key }
    : null;
}

export function deleteEnvironment(db: Db, environmentId: string) {
  db.prepare("DELETE FROM environments WHERE id = ?").run(environmentId);
}

/** Every company member, for company-wide notifications (guests excluded). */
export function fullMembersOf(db: Db, companyId: string) {
  return db
    .prepare(
      "SELECT u.id, u.email, u.name, u.notify_email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.role IN ('owner', 'admin', 'member')",
    )
    .all(companyId) as Array<{ id: string; email: string; name: string; notify_email: number }>;
}

// ---- First-device approval alerts ------------------------------------------------------------

/** Records that a runner asked about this key; false when it already did within `withinMs`. */
export function recordDeviceAlert(
  db: Db,
  input: { environmentId: string; keyId: string; userId: string; companyId: string | null; withinMs: number },
): boolean {
  const now = Date.now();
  const row = db
    .prepare("SELECT created_at FROM device_approval_alerts WHERE environment_id = ? AND key_id = ?")
    .get(input.environmentId, input.keyId) as { created_at: number } | undefined;
  if (row !== undefined && now - row.created_at < input.withinMs) return false;
  db.prepare(
    "INSERT INTO device_approval_alerts (environment_id, key_id, user_id, company_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(environment_id, key_id) DO UPDATE SET created_at = excluded.created_at, company_id = excluded.company_id",
  ).run(input.environmentId, input.keyId, input.userId, input.companyId, now);
  return true;
}
