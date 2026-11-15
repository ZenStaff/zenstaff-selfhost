// SQL for the platform admin (/app/admin): hub staff and their roles, the lists of companies and
// accounts, plans set by hand (bank transfer), suspensions and support actions, and the platform
// audit chain. Metadata only: nothing here reads a chat, a shared view, company memory, a file or
// the content of an approval, and there is no way to sign in as someone else.
import { anchorsOf, type AuditDb, type AuditEvent, PLATFORM_CHAIN, verifyChain } from "./auditChain.ts";
import { newId, newSecret, sha256 } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { User } from "./store.ts";

const nowIso = () => new Date().toISOString();
const INVITE_TTL_MS = 14 * 24 * 60 * 60_000;

// ---- Staff roles -----------------------------------------------------------------------------

export const STAFF_ROLES = ["operator", "reviewer", "support"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** What a staff role may do in the admin. The routes check these; the page only hides tabs. */
export const ADMIN_CAPS = ["stats", "companies", "accounts", "billing.view", "billing.edit", "support", "library", "staff", "journal"] as const;
export type AdminCap = (typeof ADMIN_CAPS)[number];

export const ROLE_CAPS: Readonly<Record<StaffRole, ReadonlyArray<AdminCap>>> = {
  operator: ADMIN_CAPS,
  reviewer: ["library"],
  support: ["companies", "accounts", "support"],
};

/** E-mails from the environment that bootstrap staff before anyone is in hub_staff. */
export interface StaffBootstrap {
  /** HUB_ADMIN_EMAILS plus HUB_STATS_EMAILS (the older name keeps working): operators. */
  readonly operatorEmails: ReadonlyArray<string>;
  /** HUB_LIBRARY_REVIEWERS: reviewers. */
  readonly reviewerEmails: ReadonlyArray<string>;
}

const clean = (emails: ReadonlyArray<string> | undefined) => [...new Set((emails ?? []).map((email) => email.trim().toLowerCase()).filter((email) => email !== ""))];

export function staffBootstrap(input: { adminEmails?: ReadonlyArray<string>; statsEmails?: ReadonlyArray<string>; libraryReviewers?: ReadonlyArray<string> }): StaffBootstrap {
  return { operatorEmails: clean([...(input.adminEmails ?? []), ...(input.statsEmails ?? [])]), reviewerEmails: clean(input.libraryReviewers) };
}

export function staffRolesOf(db: Db, user: { id: string; email: string }, boot: StaffBootstrap): Array<StaffRole> {
  const roles = new Set<StaffRole>();
  const email = user.email.toLowerCase();
  if (boot.operatorEmails.includes(email)) roles.add("operator");
  if (boot.reviewerEmails.includes(email)) roles.add("reviewer");
  const row = db.prepare("SELECT role FROM hub_staff WHERE user_id = ?").get(user.id) as { role: StaffRole } | undefined;
  if (row !== undefined) roles.add(row.role);
  return STAFF_ROLES.filter((role) => roles.has(role));
}

export const capsOf = (roles: ReadonlyArray<StaffRole>): Array<AdminCap> => ADMIN_CAPS.filter((cap) => roles.some((role) => ROLE_CAPS[role].includes(cap)));

export interface StaffEntry {
  readonly userId: string | null;
  readonly email: string;
  readonly name: string | null;
  readonly role: StaffRole;
  /** "env": bootstrapped by an environment variable (changed only there); "table": hub_staff. */
  readonly source: "env" | "table";
  readonly grantedBy: string | null;
  readonly createdAt: string | null;
  readonly twoFactor: boolean;
}

export function listStaff(db: Db, boot: StaffBootstrap): Array<StaffEntry> {
  const rows = db
    .prepare(
      `SELECT s.user_id, s.role, s.created_at, u.email, u.name, g.email AS granted_by_email, t.enabled_at
       FROM hub_staff s JOIN users u ON u.id = s.user_id LEFT JOIN users g ON g.id = s.granted_by LEFT JOIN totp t ON t.user_id = s.user_id
       ORDER BY s.role, u.email`,
    )
    .all() as Array<{ user_id: string; role: StaffRole; created_at: string; email: string; name: string; granted_by_email: string | null; enabled_at: number | null }>;
  const fromEnv = (emails: ReadonlyArray<string>, role: StaffRole): Array<StaffEntry> =>
    emails.map((email) => {
      const user = db.prepare("SELECT u.id, u.name, t.enabled_at FROM users u LEFT JOIN totp t ON t.user_id = u.id WHERE u.email = ?").get(email) as
        | { id: string; name: string; enabled_at: number | null }
        | undefined;
      return { userId: user?.id ?? null, email, name: user?.name ?? null, role, source: "env", grantedBy: null, createdAt: null, twoFactor: user?.enabled_at != null };
    });
  return [
    ...fromEnv(boot.operatorEmails, "operator"),
    ...fromEnv(boot.reviewerEmails, "reviewer"),
    ...rows.map((row) => ({ userId: row.user_id, email: row.email, name: row.name, role: row.role, source: "table" as const, grantedBy: row.granted_by_email, createdAt: row.created_at, twoFactor: row.enabled_at !== null })),
  ];
}

export function userByEmail(db: Db, email: string): User | null {
  return (db.prepare("SELECT id, email, name FROM users WHERE email = ?").get(email.toLowerCase()) as User | undefined) ?? null;
}

/** Gives (or changes) one person's hub_staff role. Returns the role they had before. */
export function setStaffRole(db: Db, userId: string, role: StaffRole, grantedBy: string): StaffRole | null {
  const before = db.prepare("SELECT role FROM hub_staff WHERE user_id = ?").get(userId) as { role: StaffRole } | undefined;
  db.prepare("INSERT INTO hub_staff (user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by").run(
    userId,
    role,
    grantedBy,
    nowIso(),
  );
  return before?.role ?? null;
}

export function removeStaff(db: Db, userId: string): StaffRole | null {
  const before = db.prepare("SELECT role FROM hub_staff WHERE user_id = ?").get(userId) as { role: StaffRole } | undefined;
  if (before === undefined) return null;
  db.prepare("DELETE FROM hub_staff WHERE user_id = ?").run(userId);
  return before.role;
}

// ---- Pages -----------------------------------------------------------------------------------

export interface PageQuery {
  readonly page: number;
  readonly per: number;
}

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly page: number;
  readonly per: number;
  readonly total: number;
  readonly pages: number;
}

export function pageQuery(query: URLSearchParams, defaultPer = 25): PageQuery {
  const page = Math.max(1, Math.min(100_000, Number.parseInt(query.get("page") ?? "1", 10) || 1));
  const per = Math.max(5, Math.min(100, Number.parseInt(query.get("per") ?? String(defaultPer), 10) || defaultPer));
  return { page, per };
}

const pageOf = <T>(items: ReadonlyArray<T>, total: number, query: PageQuery): Page<T> => ({ items, page: query.page, per: query.per, total, pages: Math.max(1, Math.ceil(total / query.per)) });

const like = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// ---- Companies -------------------------------------------------------------------------------

export const PLANS = ["free", "hosted", "founder", "selfhost"] as const;
export type Plan = (typeof PLANS)[number];
export const SUB_STATUSES = ["trial", "active", "past_due", "cancelled"] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** Price per seat in EUR: Găzduit 29, founder offer 19 for 12 months, the free plans 0. */
export const PLAN_PRICE: Readonly<Record<Plan, number>> = { free: 0, hosted: 29, founder: 19, selfhost: 0 };

/** The plan a company has when nobody set one: our hosted hub starts in trial, a self-hosted hub is self-host. */
export interface PlanDefaults {
  readonly plan: Plan;
  readonly status: SubStatus;
}

export const planDefaults = (hubPlan: "hosted" | "selfhost" | undefined): PlanDefaults =>
  hubPlan === "hosted" ? { plan: "hosted", status: "trial" } : { plan: "selfhost", status: "active" };

export interface CompanyRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly owner: { readonly userId: string; readonly email: string; readonly name: string } | null;
  readonly plan: Plan;
  readonly status: SubStatus;
  /** False when nobody set a plan yet (the hub's default applies). */
  readonly planSet: boolean;
  readonly pricePerSeat: number;
  readonly seatsUsed: number;
  readonly seatsPaid: number;
  readonly members: number;
  readonly lastActivity: string;
  readonly runners: number;
  readonly runnerIds: ReadonlyArray<string>;
  readonly packsPublished: number;
  readonly suspended: { readonly at: string; readonly reason: string } | null;
}

export interface CompanyFilter {
  readonly q?: string | null;
  readonly plan?: string | null;
  readonly status?: string | null;
  readonly suspended?: boolean | null;
  readonly sort?: string | null;
}

const COMPANY_SELECT = `
  SELECT c.id, c.name, c.created_at, c.suspended_at, c.suspended_reason,
    o.user_id AS owner_id, o.email AS owner_email, o.name AS owner_name,
    s.plan AS set_plan, COALESCE(s.plan, :defaultPlan) AS plan, COALESCE(s.status, :defaultStatus) AS status,
    s.price_eur, COALESCE(s.seats, 0) AS seats_paid,
    (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id) AS members,
    (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.role != 'guest') AS seats_used,
    MAX(c.created_at,
        COALESCE((SELECT MAX(a.created_at) FROM audit_log a WHERE a.company_id = c.id), ''),
        COALESCE((SELECT MAX(e.last_seen_at) FROM environment_runners r JOIN environments e ON e.id = r.environment_id WHERE r.company_id = c.id), ''),
        COALESCE((SELECT MAX(u.last_signin_at) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = c.id), '')) AS last_activity,
    (SELECT COUNT(*) FROM environment_runners r WHERE r.company_id = c.id) AS runners,
    (SELECT COUNT(*) FROM library_packs p WHERE p.state = 'published' AND p.author_user_id IN (SELECT m.user_id FROM memberships m WHERE m.company_id = c.id)) AS packs_published
  FROM companies c
  LEFT JOIN platform_subscriptions s ON s.company_id = c.id
  LEFT JOIN (SELECT m.company_id, u.id AS user_id, u.email, u.name, ROW_NUMBER() OVER (PARTITION BY m.company_id ORDER BY m.created_at) AS n
             FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner') o ON o.company_id = c.id AND o.n = 1`;

interface CompanySqlRow {
  id: string;
  name: string;
  created_at: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  owner_id: string | null;
  owner_email: string | null;
  owner_name: string | null;
  set_plan: Plan | null;
  plan: Plan;
  status: SubStatus;
  price_eur: number | null;
  seats_paid: number;
  members: number;
  seats_used: number;
  last_activity: string;
  runners: number;
  packs_published: number;
}

const toCompanyRow = (db: Db, row: CompanySqlRow): CompanyRow => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  owner: row.owner_id === null ? null : { userId: row.owner_id, email: row.owner_email!, name: row.owner_name! },
  plan: row.plan,
  status: row.status,
  planSet: row.set_plan !== null,
  pricePerSeat: row.price_eur ?? PLAN_PRICE[row.plan],
  seatsUsed: row.seats_used,
  seatsPaid: row.seats_paid,
  members: row.members,
  lastActivity: row.last_activity,
  runners: row.runners,
  runnerIds: (db.prepare("SELECT environment_id FROM environment_runners WHERE company_id = ?").all(row.id) as Array<{ environment_id: string }>).map((r) => r.environment_id),
  packsPublished: row.packs_published,
  suspended: row.suspended_at === null ? null : { at: row.suspended_at, reason: row.suspended_reason ?? "" },
});

export function companiesPage(db: Db, filter: CompanyFilter, query: PageQuery, defaults: PlanDefaults): Page<CompanyRow> {
  const where: Array<string> = [];
  const args: Record<string, string | number> = { defaultPlan: defaults.plan, defaultStatus: defaults.status };
  if (filter.q) {
    where.push("(lower(name) LIKE :q ESCAPE '\\' OR lower(COALESCE(owner_email, '')) LIKE :q ESCAPE '\\' OR id = :qid)");
    args.q = like(filter.q);
    args.qid = filter.q.trim();
  }
  if (filter.plan && (PLANS as ReadonlyArray<string>).includes(filter.plan)) {
    where.push("plan = :plan");
    args.plan = filter.plan;
  }
  if (filter.status && (SUB_STATUSES as ReadonlyArray<string>).includes(filter.status)) {
    where.push("status = :status");
    args.status = filter.status;
  }
  if (filter.suspended === true) where.push("suspended_at IS NOT NULL");
  if (filter.suspended === false) where.push("suspended_at IS NULL");
  const order = filter.sort === "name" ? "lower(name), id" : filter.sort === "activity" ? "last_activity DESC, id" : "created_at DESC, id";
  const base = `SELECT * FROM (${COMPANY_SELECT}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(args) as { n: number }).n;
  const rows = db.prepare(`${base} ORDER BY ${order} LIMIT :limit OFFSET :offset`).all({ ...args, limit: query.per, offset: (query.page - 1) * query.per }) as unknown as Array<CompanySqlRow>;
  return pageOf(
    rows.map((row) => toCompanyRow(db, row)),
    total,
    query,
  );
}

export function companyRow(db: Db, companyId: string, defaults: PlanDefaults): CompanyRow | null {
  const row = db.prepare(`SELECT * FROM (${COMPANY_SELECT}) WHERE id = :id`).get({ defaultPlan: defaults.plan, defaultStatus: defaults.status, id: companyId }) as CompanySqlRow | undefined;
  return row === undefined ? null : toCompanyRow(db, row);
}

/** Who is in a company and the invitations still open: names, e-mails, roles, dates. */
export function companyPeople(db: Db, companyId: string) {
  const members = db
    .prepare(
      `SELECT u.id AS userId, u.email, u.name, m.role, m.created_at AS joinedAt, u.suspended_at AS suspendedAt
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email`,
    )
    .all(companyId) as Array<{ userId: string; email: string; name: string; role: string; joinedAt: string; suspendedAt: string | null }>;
  const invites = db
    .prepare(
      `SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt FROM invites
       WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50`,
    )
    .all(companyId) as Array<{ id: string; email: string | null; role: string; createdAt: string; expiresAt: number }>;
  const runners = db
    .prepare(
      `SELECT e.id, e.name, e.last_seen_at AS lastSeenAt, u.email AS ownerEmail FROM environment_runners r
       JOIN environments e ON e.id = r.environment_id JOIN users u ON u.id = e.owner_user_id WHERE r.company_id = ? ORDER BY e.name`,
    )
    .all(companyId) as Array<{ id: string; name: string; lastSeenAt: string | null; ownerEmail: string }>;
  return {
    members: members.map((member) => ({ ...member })),
    invites: invites.map((invite) => ({ ...invite, expired: invite.expiresAt <= Date.now(), expiresAt: new Date(invite.expiresAt).toISOString() })),
    runners: runners.map((runner) => ({ ...runner })),
  };
}

// ---- Accounts --------------------------------------------------------------------------------

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly twoFactor: boolean;
  readonly passkeys: number;
  readonly devices: number;
  readonly sessions: number;
  readonly companies: ReadonlyArray<{ readonly id: string; readonly name: string; readonly role: string }>;
  readonly suspended: { readonly at: string; readonly reason: string } | null;
}

export interface AccountFilter {
  readonly q?: string | null;
  readonly twoFactor?: boolean | null;
  readonly suspended?: boolean | null;
  readonly companyId?: string | null;
}

export function accountsPage(db: Db, filter: AccountFilter, query: PageQuery): Page<AccountRow> {
  const where: Array<string> = [];
  const args: Record<string, string | number> = {};
  if (filter.q) {
    where.push("(lower(u.email) LIKE :q ESCAPE '\\' OR lower(u.name) LIKE :q ESCAPE '\\' OR u.id = :qid)");
    args.q = like(filter.q);
    args.qid = filter.q.trim();
  }
  if (filter.twoFactor === true) where.push("t.enabled_at IS NOT NULL");
  if (filter.twoFactor === false) where.push("t.enabled_at IS NULL");
  if (filter.suspended === true) where.push("u.suspended_at IS NOT NULL");
  if (filter.suspended === false) where.push("u.suspended_at IS NULL");
  if (filter.companyId) {
    where.push("u.id IN (SELECT user_id FROM memberships WHERE company_id = :company)");
    args.company = filter.companyId;
  }
  const from = `FROM users u LEFT JOIN totp t ON t.user_id = u.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.last_signin_at, u.suspended_at, u.suspended_reason, t.enabled_at,
         (SELECT COUNT(*) FROM device_keys d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
         (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > :now) AS sessions
       ${from} ORDER BY u.created_at DESC, u.id LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, now: Date.now(), limit: query.per, offset: (query.page - 1) * query.per }) as Array<{
    id: string;
    email: string;
    name: string;
    created_at: string;
    last_signin_at: string | null;
    suspended_at: string | null;
    suspended_reason: string | null;
    enabled_at: number | null;
    devices: number;
    passkeys: number;
    sessions: number;
  }>;
  const companies = db.prepare("SELECT c.id, c.name, m.role FROM memberships m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? ORDER BY c.name");
  return pageOf(
    rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.created_at,
      lastSignInAt: row.last_signin_at,
      twoFactor: row.enabled_at !== null,
      passkeys: row.passkeys,
      devices: row.devices,
      sessions: row.sessions,
      companies: (companies.all(row.id) as Array<{ id: string; name: string; role: string }>).map((company) => ({ ...company })),
      suspended: row.suspended_at === null ? null : { at: row.suspended_at, reason: row.suspended_reason ?? "" },
    })),
    total,
    query,
  );
}

export function getAccount(db: Db, userId: string): (User & { suspendedAt: string | null }) | null {
  const row = db.prepare("SELECT id, email, name, suspended_at FROM users WHERE id = ?").get(userId) as { id: string; email: string; name: string; suspended_at: string | null } | undefined;
  return row === undefined ? null : { id: row.id, email: row.email, name: row.name, suspendedAt: row.suspended_at };
}

// ---- Subscriptions (set by hand) -------------------------------------------------------------

export interface Subscription {
  readonly plan: Plan;
  readonly pricePerSeat: number;
  readonly seats: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly status: SubStatus;
  readonly trialEnd: string | null;
  /** "Factură emisă manual în HoReCaOS (nr.)": the number of the invoice the operator issued by hand. */
  readonly invoiceRef: string | null;
  readonly note: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
  /** False: nothing set yet, these are the hub's defaults. */
  readonly set: boolean;
}

export function subscriptionOf(db: Db, companyId: string, defaults: PlanDefaults): Subscription {
  const row = db
    .prepare(
      "SELECT s.*, u.email AS updated_by_email FROM platform_subscriptions s LEFT JOIN users u ON u.id = s.updated_by WHERE s.company_id = ?",
    )
    .get(companyId) as
    | {
        plan: Plan;
        price_eur: number;
        seats: number;
        period_start: string | null;
        period_end: string | null;
        status: SubStatus;
        trial_end: string | null;
        invoice_ref: string | null;
        note: string;
        updated_by_email: string | null;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return { plan: defaults.plan, pricePerSeat: PLAN_PRICE[defaults.plan], seats: 0, periodStart: null, periodEnd: null, status: defaults.status, trialEnd: null, invoiceRef: null, note: "", updatedBy: null, updatedAt: null, set: false };
  }
  return {
    plan: row.plan,
    pricePerSeat: row.price_eur,
    seats: row.seats,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    trialEnd: row.trial_end,
    invoiceRef: row.invoice_ref,
    note: row.note,
    updatedBy: row.updated_by_email,
    updatedAt: row.updated_at,
    set: true,
  };
}

export type SubscriptionInput = Omit<Subscription, "updatedBy" | "updatedAt" | "set">;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (day: string) => DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function addMonths(day: string, months: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Checks and completes a plan set by hand. Throws an Error with a message for people on a mistake. */
export function normalizeSubscription(input: {
  plan: unknown;
  pricePerSeat?: unknown;
  seats?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  status?: unknown;
  trialEnd?: unknown;
  invoiceRef?: unknown;
  note?: unknown;
}): SubscriptionInput {
  const fail = (message: string): never => {
    throw new RangeError(message);
  };
  const plan = typeof input.plan === "string" && (PLANS as ReadonlyArray<string>).includes(input.plan) ? (input.plan as Plan) : fail("Choose a plan: free, hosted, founder or selfhost.");
  const status =
    input.status === undefined || input.status === null || input.status === ""
      ? "active"
      : typeof input.status === "string" && (SUB_STATUSES as ReadonlyArray<string>).includes(input.status)
        ? (input.status as SubStatus)
        : fail("Choose a status: trial, active, past_due or cancelled.");
  const int = (value: unknown, fallback: number, max: number, what: string) => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) fail(`${what} must be a whole number from 0 to ${max}.`);
    return n;
  };
  const day = (value: unknown, what: string): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !validDay(value)) fail(`${what} must be a date (YYYY-MM-DD).`);
    return value as string;
  };
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const free = plan === "free" || plan === "selfhost";
  const pricePerSeat = int(input.pricePerSeat, PLAN_PRICE[plan], 1000, "The price per seat");
  if (free && pricePerSeat !== 0) fail("A free plan has no price per seat.");
  const seats = int(input.seats, 0, 100_000, "Seats");
  const periodStart = day(input.periodStart, "The period start") ?? (free ? null : today());
  // The founder offer: 19 EUR per seat for 12 months from the start, unless another end is given.
  const periodEnd = day(input.periodEnd, "The period end") ?? (plan === "founder" && periodStart !== null ? addMonths(periodStart, 12) : null);
  if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) fail("The period cannot end before it starts.");
  const trialEnd = day(input.trialEnd, "The trial end") ?? (status === "trial" ? addDays(today(), 14) : null);
  const invoiceRef = text(input.invoiceRef, 60) || null;
  if (invoiceRef !== null && !/^[\p{L}\p{N} ./-]+$/u.test(invoiceRef)) fail("The invoice number has letters, digits, spaces, dots, dashes and slashes only.");
  return { plan, pricePerSeat, seats, periodStart, periodEnd, status, trialEnd, invoiceRef, note: text(input.note, 500) };
}

const subscriptionJson = (sub: SubscriptionInput | Subscription) => ({
  plan: sub.plan,
  pricePerSeat: sub.pricePerSeat,
  seats: sub.seats,
  periodStart: sub.periodStart,
  periodEnd: sub.periodEnd,
  status: sub.status,
  trialEnd: sub.trialEnd,
  invoiceRef: sub.invoiceRef,
  note: sub.note,
});

export function setSubscription(
  db: Db,
  input: { companyId: string; next: SubscriptionInput; actorUserId: string; action: string; reason: string; defaults: PlanDefaults },
): { before: Subscription; after: Subscription } {
  const before = subscriptionOf(db, input.companyId, input.defaults);
  const now = nowIso();
  const next = input.next;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO platform_subscriptions (company_id, plan, price_eur, seats, period_start, period_end, status, trial_end, invoice_ref, note, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET plan = excluded.plan, price_eur = excluded.price_eur, seats = excluded.seats, period_start = excluded.period_start,
         period_end = excluded.period_end, status = excluded.status, trial_end = excluded.trial_end, invoice_ref = excluded.invoice_ref, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(input.companyId, next.plan, next.pricePerSeat, next.seats, next.periodStart, next.periodEnd, next.status, next.trialEnd, next.invoiceRef, next.note, input.actorUserId, now);
    db.prepare("INSERT INTO platform_subscription_history (id, company_id, action, before, after, reason, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      newId("sh"),
      input.companyId,
      input.action,
      before.set ? JSON.stringify(subscriptionJson(before)) : null,
      JSON.stringify(subscriptionJson(next)),
      input.reason.slice(0, 500),
      input.actorUserId,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { before, after: subscriptionOf(db, input.companyId, input.defaults) };
}

export function subscriptionHistory(db: Db, companyId: string, limit = 50) {
  return (
    db
      .prepare(
        `SELECT h.id, h.action, h.before, h.after, h.reason, h.changed_at, u.email AS changed_by FROM platform_subscription_history h
         LEFT JOIN users u ON u.id = h.changed_by WHERE h.company_id = ? ORDER BY h.changed_at DESC, h.rowid DESC LIMIT ?`,
      )
      .all(companyId, limit) as Array<{ id: string; action: string; before: string | null; after: string; reason: string; changed_at: string; changed_by: string | null }>
  ).map((row) => ({
    id: row.id,
    action: row.action,
    before: row.before === null ? null : (JSON.parse(row.before) as Record<string, unknown>),
    after: JSON.parse(row.after) as Record<string, unknown>,
    reason: row.reason,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
  }));
}

/**
 * What the payments branch (wave/payments, v12) keeps, read-only, when its tables exist: the Stripe
 * subscription and the fiscal invoices issued through HoReCaOS. Absent tables: `available: false`.
 */
/**
 * The Stripe side of a company (v12), read-only. "Off" while this hub has no Stripe configured and
 * the company has no billing row or invoice yet (bank-transfer clients only).
 */
export function paymentsOf(db: Db, companyId: string, enabled: boolean) {
  const has = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  if (!has("billing_accounts")) return { available: false as const };
  const account = db
    .prepare("SELECT plan, status, seats, servers, trial_end, current_period_end, cancel_at_period_end, past_due_since, updated_at FROM billing_accounts WHERE company_id = ?")
    .get(companyId) as Record<string, unknown> | undefined;
  const invoices = has("billing_invoices")
    ? (db
        .prepare(
          `SELECT stripe_invoice_id AS id, kind, amount_cents AS amountCents, currency, paid_at AS paidAt, fiscal_status AS fiscalStatus, fiscal_series AS fiscalSeries,
                  fiscal_number AS fiscalNumber, efactura_status AS efacturaStatus FROM billing_invoices WHERE company_id = ? ORDER BY paid_at DESC LIMIT 24`,
        )
        .all(companyId) as Array<Record<string, unknown>>)
    : [];
  if (!enabled && account === undefined && invoices.length === 0) return { available: false as const };
  return { available: true as const, account: account === undefined ? null : { ...account }, invoices: invoices.map((row) => ({ ...row })) };
}

// ---- Suspensions -----------------------------------------------------------------------------

export function isUserSuspended(db: Db, userId: string): boolean {
  return db.prepare("SELECT 1 FROM users WHERE id = ? AND suspended_at IS NOT NULL").get(userId) !== undefined;
}

export function isCompanySuspended(db: Db, companyId: string): boolean {
  return db.prepare("SELECT 1 FROM companies WHERE id = ? AND suspended_at IS NOT NULL").get(companyId) !== undefined;
}

/** Ends every session of a person and revokes their device keys. Returns the keys, for the runners. */
export function revokeAllSessions(db: Db, userId: string): { sessions: number; keyIds: Array<string> } {
  const keys = (db.prepare("SELECT key_id FROM device_keys WHERE user_id = ? AND revoked_at IS NULL AND session_hash IS NOT NULL").all(userId) as Array<{ key_id: string }>).map((row) => row.key_id);
  db.prepare("UPDATE device_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND session_hash IS NOT NULL").run(Date.now(), userId);
  const sessions = Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
  return { sessions, keyIds: keys };
}

export function setUserSuspended(db: Db, userId: string, reason: string | null) {
  if (reason === null) db.prepare("UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?").run(userId);
  else db.prepare("UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?").run(nowIso(), reason.slice(0, 500), userId);
}

export function setCompanySuspended(db: Db, companyId: string, reason: string | null) {
  if (reason === null) db.prepare("UPDATE companies SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?").run(companyId);
  else db.prepare("UPDATE companies SET suspended_at = ?, suspended_reason = ? WHERE id = ?").run(nowIso(), reason.slice(0, 500), companyId);
}

/** Machines a person owns (a suspended account's runners are disconnected). */
export function environmentsOwnedBy(db: Db, userId: string): Array<string> {
  return (db.prepare("SELECT id FROM environments WHERE owner_user_id = ?").all(userId) as Array<{ id: string }>).map((row) => row.id);
}

/** A pending invitation by e-mail gets a fresh link (the old one stops working) and 14 more days. */
export function renewInvite(db: Db, inviteId: string) {
  const invite = db
    .prepare(
      `SELECT i.id, i.company_id, i.email, i.role, i.accepted_at, i.revoked_at, c.name AS company_name, u.name AS inviter_name
       FROM invites i JOIN companies c ON c.id = i.company_id LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?`,
    )
    .get(inviteId) as
    | { id: string; company_id: string; email: string | null; role: string; accepted_at: string | null; revoked_at: string | null; company_name: string; inviter_name: string | null }
    | undefined;
  if (invite === undefined || invite.accepted_at !== null || invite.revoked_at !== null) return null;
  if (invite.email === null) return { ok: false as const, reason: "link" };
  const token = newSecret("inv");
  db.prepare("UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ?").run(sha256(token), Date.now() + INVITE_TTL_MS, invite.id);
  return { ok: true as const, token, companyId: invite.company_id, companyName: invite.company_name, email: invite.email, role: invite.role, inviterName: invite.inviter_name ?? invite.company_name };
}

// ---- The platform audit chain ------------------------------------------------------------------

export interface JournalFilter {
  readonly q?: string | null;
  readonly action?: string | null;
  readonly actor?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

function journalWhere(filter: JournalFilter) {
  const where = ["chain = ?"];
  const args: Array<string> = [PLATFORM_CHAIN];
  if (filter.q) {
    where.push("(lower(target) LIKE ? ESCAPE '\\' OR lower(detail) LIKE ? ESCAPE '\\' OR lower(action) LIKE ? ESCAPE '\\' OR lower(COALESCE(actor_email, '')) LIKE ? ESCAPE '\\')");
    const text = like(filter.q);
    args.push(text, text, text, text);
  }
  if (filter.action) {
    where.push("(action = ? OR action LIKE ? ESCAPE '\\')");
    args.push(filter.action, `${filter.action.replace(/[\\%_]/g, (char) => `\\${char}`)}.%`);
  }
  if (filter.actor) {
    where.push("(actor_user_id = ? OR lower(COALESCE(actor_email, '')) = ?)");
    args.push(filter.actor, filter.actor.toLowerCase());
  }
  if (filter.from && validDay(filter.from)) {
    where.push("ts >= ?");
    args.push(filter.from);
  }
  if (filter.to && validDay(filter.to)) {
    where.push("ts < ?");
    args.push(addDays(filter.to, 1));
  }
  return { sql: where.join(" AND "), args };
}

export function journalPage(auditDb: AuditDb, filter: JournalFilter, query: PageQuery, search: (seqs: ReadonlyArray<number>) => Array<AuditEvent>): Page<AuditEvent> {
  const { sql, args } = journalWhere(filter);
  const total = (auditDb.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE ${sql}`).get(...args) as { n: number }).n;
  const seqs = (auditDb.prepare(`SELECT seq FROM audit_events WHERE ${sql} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, query.per, (query.page - 1) * query.per) as Array<{ seq: number }>).map(
    (row) => row.seq,
  );
  return pageOf(search(seqs), total, query);
}

export function journalSeqs(auditDb: AuditDb, filter: JournalFilter, limit: number): Array<number> {
  const { sql, args } = journalWhere(filter);
  return (auditDb.prepare(`SELECT seq FROM audit_events WHERE ${sql} ORDER BY seq DESC LIMIT ?`).all(...args, limit) as Array<{ seq: number }>).map((row) => row.seq);
}

export function journalActions(auditDb: AuditDb): Array<string> {
  return (auditDb.prepare("SELECT DISTINCT action FROM audit_events WHERE chain = ? ORDER BY action").all(PLATFORM_CHAIN) as Array<{ action: string }>).map((row) => row.action);
}

export function verifyPlatformChain(auditDb: AuditDb, hubDb: Db) {
  const anchors = anchorsOf(hubDb, PLATFORM_CHAIN);
  return { ...verifyChain(auditDb, PLATFORM_CHAIN, anchors), anchors };
}
