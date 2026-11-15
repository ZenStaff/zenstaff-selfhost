// SQL for the web dashboard (v7): company details, the count of requests sent to the company
// runner, and the read-only summaries the overview shows. Everything here is metadata the hub
// already has (records, routing, times); never a profile, a prompt or a chat.
import type { Db } from "./db.ts";

const DAY_MS = 24 * 60 * 60_000;

// ---- Company details -------------------------------------------------------------------------

export interface CompanyDetails {
  /** Legal name, e.g. "Casa Verde SRL". */
  readonly legalName: string | null;
  /** CUI / CIF, e.g. "RO12345678". */
  readonly taxId: string | null;
  /** Trade register number, e.g. "J26/123/2020". */
  readonly registryNo: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly county: string | null;
  readonly country: string | null;
  readonly billingEmail: string | null;
}

export const DETAIL_FIELDS = ["legalName", "taxId", "registryNo", "address", "city", "county", "country", "billingEmail"] as const;

export const emptyDetails = (): CompanyDetails => ({
  legalName: null,
  taxId: null,
  registryNo: null,
  address: null,
  city: null,
  county: null,
  country: null,
  billingEmail: null,
});

export function companyDetails(db: Db, companyId: string): CompanyDetails {
  const row = db.prepare("SELECT details FROM companies WHERE id = ?").get(companyId) as { details: string | null } | undefined;
  if (row?.details == null) return emptyDetails();
  try {
    const parsed = JSON.parse(row.details) as Record<string, unknown>;
    const details: Record<string, string | null> = { ...emptyDetails() };
    for (const field of DETAIL_FIELDS) details[field] = typeof parsed[field] === "string" ? (parsed[field] as string) : null;
    return details as unknown as CompanyDetails;
  } catch {
    return emptyDetails();
  }
}

export function setCompanyProfile(db: Db, companyId: string, input: { name?: string; details?: CompanyDetails }) {
  if (input.name !== undefined) db.prepare("UPDATE companies SET name = ? WHERE id = ?").run(input.name, companyId);
  if (input.details !== undefined) db.prepare("UPDATE companies SET details = ? WHERE id = ?").run(JSON.stringify(input.details), companyId);
}

// ---- Company runner requests -----------------------------------------------------------------

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One request a member sent to the company runner (op only, e.g. staff.task). */
export function countRunnerCall(db: Db, companyId: string, op: string, nowMs = Date.now()) {
  db.prepare(
    "INSERT INTO company_runner_calls (company_id, day, op, count) VALUES (?, ?, ?, 1) ON CONFLICT (company_id, day, op) DO UPDATE SET count = count + 1",
  ).run(companyId, dayOf(nowMs), op);
}

// ---- Overview --------------------------------------------------------------------------------

export interface WeekActivity {
  readonly since: string;
  /** The last 7 days, oldest first: what happened each day (counts only). */
  readonly days: ReadonlyArray<{ readonly day: string; readonly tasks: number; readonly changes: number; readonly shares: number }>;
  /** Tasks and status checks sent to the AI staff through the hub (op staff.task / staff.run). */
  readonly staffTasks: number;
  readonly staffLists: number;
  /** AI employees created, changed or removed (audit log). */
  readonly staffChanges: number;
  readonly sharesCreated: number;
  readonly handovers: number;
  readonly comments: number;
  readonly packChanges: number;
  readonly memberChanges: number;
}

export function weekActivity(db: Db, companyId: string, nowMs = Date.now()): WeekActivity {
  return activityOver(db, companyId, 7, nowMs);
}

/** Like weekActivity, over the last `span` days (1..90), oldest day first. */
export function activityOver(db: Db, companyId: string, span: number, nowMs = Date.now()): WeekActivity {
  const sinceMs = nowMs - (span - 1) * DAY_MS;
  const sinceDay = dayOf(sinceMs);
  const sinceIso = `${sinceDay}T00:00:00.000Z`;
  const days = Array.from({ length: span }, (_, index) => dayOf(sinceMs + index * DAY_MS));
  const perDay = new Map(days.map((day) => [day, { day, tasks: 0, changes: 0, shares: 0 }]));

  const calls = db
    .prepare("SELECT day, op, count FROM company_runner_calls WHERE company_id = ? AND day >= ?")
    .all(companyId, sinceDay) as Array<{ day: string; op: string; count: number }>;
  let staffTasks = 0;
  let staffLists = 0;
  for (const call of calls) {
    if (call.op === "staff.list") staffLists += call.count;
    else {
      staffTasks += call.count;
      const entry = perDay.get(call.day);
      if (entry !== undefined) entry.tasks += call.count;
    }
  }

  const audits = db
    .prepare("SELECT action, substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM audit_log WHERE company_id = ? AND created_at >= ? GROUP BY action, day")
    .all(companyId, sinceIso) as Array<{ action: string; day: string; n: number }>;
  let staffChanges = 0;
  let packChanges = 0;
  let memberChanges = 0;
  for (const row of audits) {
    if (row.action.startsWith("staff.")) staffChanges += row.n;
    else if (row.action.startsWith("pack.")) packChanges += row.n;
    else if (row.action.startsWith("member.") || row.action === "invite.accept") memberChanges += row.n;
    if (row.action.startsWith("staff.") || row.action.startsWith("pack.")) {
      const entry = perDay.get(row.day);
      if (entry !== undefined) entry.changes += row.n;
    }
  }

  const shares = db
    .prepare("SELECT kind, substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM shares WHERE company_id = ? AND created_at >= ? GROUP BY kind, day")
    .all(companyId, sinceIso) as Array<{ kind: string; day: string; n: number }>;
  let sharesCreated = 0;
  let handovers = 0;
  for (const row of shares) {
    if (row.kind === "handover") handovers += row.n;
    else sharesCreated += row.n;
    const entry = perDay.get(row.day);
    if (entry !== undefined) entry.shares += row.n;
  }

  const comments = (
    db
      .prepare("SELECT COUNT(*) AS n FROM comments c JOIN shares s ON s.id = c.share_id WHERE s.company_id = ? AND c.created_at >= ?")
      .get(companyId, sinceIso) as { n: number }
  ).n;

  return {
    since: sinceIso,
    days: days.map((day) => perDay.get(day)!),
    staffTasks,
    staffLists,
    staffChanges,
    sharesCreated,
    handovers,
    comments,
    packChanges,
    memberChanges,
  };
}

export interface Trend {
  /** The last 30 days: AI staff activity per day (runner requests, changes, shares) and the totals. */
  readonly activity: WeekActivity;
  /** Current members by the day they joined, as a running total at the end of each day. */
  readonly members: ReadonlyArray<{ readonly day: string; readonly total: number }>;
  /** New devices reported as waiting for approval, per day (scoped like devicesWaiting). */
  readonly approvals: ReadonlyArray<{ readonly day: string; readonly n: number }>;
}

/** The series the dashboard draws as sparklines and the activity chart: counts per day, 30 days. */
export function trend(db: Db, companyId: string, onlyUserId: string | null, nowMs = Date.now(), span = 30): Trend {
  const activity = activityOver(db, companyId, span, nowMs);
  const days = activity.days.map((entry) => entry.day);
  const joined = db.prepare("SELECT substr(created_at, 1, 10) AS day FROM memberships WHERE company_id = ? ORDER BY created_at").all(companyId) as Array<{ day: string }>;
  const members = days.map((day) => ({ day, total: joined.filter((row) => row.day <= day).length }));
  const sinceMs = Date.parse(`${days[0]}T00:00:00.000Z`);
  const alerts = db
    .prepare(`SELECT created_at FROM device_approval_alerts WHERE company_id = ? AND created_at >= ? ${onlyUserId === null ? "" : "AND user_id = ?"}`)
    .all(...(onlyUserId === null ? [companyId, sinceMs] : [companyId, sinceMs, onlyUserId])) as Array<{ created_at: number }>;
  const perDay = new Map(days.map((day) => [day, 0]));
  for (const alert of alerts) {
    const day = dayOf(alert.created_at);
    if (perDay.has(day)) perDay.set(day, perDay.get(day)! + 1);
  }
  return { activity, members, approvals: days.map((day) => ({ day, n: perDay.get(day)! })) };
}

/**
 * New devices a company runner reported as waiting for approval (first-device rule), from the last
 * 14 days, that no approved device of the same person has cross-signed and that are still signed in.
 * Approval on the runner itself is not reported back to the hub, so an entry can already be settled
 * there; the dashboard says so.
 */
export function devicesWaiting(db: Db, companyId: string, onlyUserId: string | null, nowMs = Date.now()) {
  return (
    db
      .prepare(
        `SELECT a.key_id, a.created_at, e.name AS environment_name, u.id AS user_id, u.name AS user_name, u.email, d.sign_public_key, d.label
         FROM device_approval_alerts a
         JOIN environments e ON e.id = a.environment_id
         JOIN users u ON u.id = a.user_id
         JOIN device_keys d ON d.key_id = a.key_id
         WHERE a.company_id = ? AND a.created_at > ? AND d.revoked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM device_certs c WHERE c.key_id = a.key_id)
           ${onlyUserId === null ? "" : "AND a.user_id = ?"}
         ORDER BY a.created_at DESC LIMIT 50`,
      )
      .all(...(onlyUserId === null ? [companyId, nowMs - 14 * DAY_MS] : [companyId, nowMs - 14 * DAY_MS, onlyUserId])) as Array<{
      key_id: string;
      created_at: number;
      environment_name: string;
      user_id: string;
      user_name: string;
      email: string;
      sign_public_key: string;
      label: string;
    }>
  ).map((row) => ({
    keyId: row.key_id,
    reportedAt: new Date(row.created_at).toISOString(),
    runnerName: row.environment_name,
    userId: row.user_id,
    userName: row.user_name,
    email: row.email,
    deviceLabel: row.label,
    signPublicKey: row.sign_public_key,
  }));
}

/** Chats handed over to this person in this company that wait for them to accept or decline. */
export function handoversWaiting(db: Db, companyId: string, userId: string) {
  return db
    .prepare(
      `SELECT s.id, s.created_at AS createdAt, u.name AS fromName FROM shares s JOIN users u ON u.id = s.owner_user_id
       WHERE s.company_id = ? AND s.kind = 'handover' AND s.audience_user_id = ? AND s.handover_state = 'pending' AND s.revoked_at IS NULL
       ORDER BY s.created_at DESC LIMIT 50`,
    )
    .all(companyId, userId) as Array<{ id: string; createdAt: string; fromName: string }>;
}

/** The person's own account events (passkeys added or removed); company events are in the company audit. */
export function accountAuditOf(db: Db, userId: string, limit = 50) {
  return db
    .prepare(
      "SELECT id, action, detail, created_at AS createdAt FROM audit_log WHERE company_id IS NULL AND actor_user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(userId, limit) as Array<{ id: string; action: string; detail: string; createdAt: string }>;
}
