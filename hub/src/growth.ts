// Growth (v18): the funnel, a small CRM for leads, partner referral codes and the common opt-out
// list. Only our hosted hub turns it on (HUB_GROWTH_TOKEN); the growth team's agents use it
// through /v1/growth/* (routes/growth.ts), never through a person's session.
// - Funnel events keep ids, a partner code, UTM fields and a small JSON meta: never an e-mail,
//   a name or an address. Existing flows record them with one call (recordEvent), which never
//   throws, so counting can not break a sign-up or an invitation.
// - The opt-out list (an e-mail or a whole domain) is what every sender checks before writing.
import type { Db } from "./db.ts";
import { newId } from "./crypto.ts";
import { lastDays } from "./stats.ts";

export const GROWTH_EVENTS = [
  "signup",
  "company_created",
  "invite_sent",
  "invite_accepted",
  "approval_link_created",
  "approval_link_decided",
  "first_task",
  "payment",
  "partner_click",
  "download",
] as const;
export type GrowthEvent = (typeof GROWTH_EVENTS)[number];

export const LEAD_STAGES = ["new", "contacted", "qualified", "meeting", "won", "lost", "opted_out"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const DEFAULT_LANDING_URL = "https://zenstaff.app/";

export interface GrowthConfig {
  /** Bearer token of the growth API (at least 32 characters). */
  readonly token: string;
  /** Where /r/<code> sends people (default https://zenstaff.app/). */
  readonly landingUrl: string;
}

/** HUB_GROWTH_TOKEN (32+ characters) turns growth on; shorter or empty = off. */
export function growthConfigFromEnv(env: Record<string, string | undefined>, log: (line: string) => void = () => undefined): GrowthConfig | undefined {
  const token = (env.HUB_GROWTH_TOKEN ?? "").trim();
  if (token === "") return undefined;
  if (token.length < 32) {
    log("growth: HUB_GROWTH_TOKEN is shorter than 32 characters; growth stays off");
    return undefined;
  }
  return { token, landingUrl: env.HUB_GROWTH_LANDING_URL?.trim() || DEFAULT_LANDING_URL };
}

// ---- Funnel events -------------------------------------------------------------------------------

export const META_MAX = 1024;

export interface EventInput {
  readonly companyId?: string | null;
  readonly userId?: string | null;
  readonly partnerCode?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  /** Small, no personal data: counts, roles, decisions, versions. */
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
  readonly ts?: string;
}

/** Inserts one event; throws on a bad value (the API validates first). */
export function insertEvent(db: Db, event: GrowthEvent, input: EventInput = {}): string {
  const meta = input.meta === undefined ? null : JSON.stringify(input.meta);
  if (meta !== null && meta.length > META_MAX) throw new Error("meta is too large");
  const id = newId("gev");
  db.prepare(
    "INSERT INTO growth_events (id, ts, event, company_id, user_id, partner_code, utm_source, utm_medium, utm_campaign, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.ts ?? new Date().toISOString(),
    event,
    input.companyId ?? null,
    input.userId ?? null,
    input.partnerCode ?? null,
    input.utmSource ?? null,
    input.utmMedium ?? null,
    input.utmCampaign ?? null,
    meta,
  );
  return id;
}

/** The hook existing flows call: records the event and never throws. */
export function recordEvent(db: Db, event: GrowthEvent, input: EventInput = {}): void {
  try {
    insertEvent(db, event, input);
  } catch {
    // Counting must never break the flow it counts.
  }
}

export interface GrowthSummary {
  readonly days: number;
  readonly since: string;
  readonly eventsByDay: ReadonlyArray<{ readonly day: string; readonly event: GrowthEvent; readonly n: number }>;
  readonly eventTotals: Readonly<Record<GrowthEvent, number>>;
  readonly leadsByStage: Readonly<Record<LeadStage, number>>;
  /** Open leads (not won, lost or opted out) whose next step is due. */
  readonly leadsDue: number;
  readonly partnerClicks: ReadonlyArray<{ readonly code: string; readonly n: number }>;
  readonly optouts: { readonly total: number; readonly emails: number; readonly domains: number };
}

export function summary(db: Db, days: number, now = Date.now()): GrowthSummary {
  const since = `${lastDays(days, now)[0]!}T00:00:00.000Z`;
  const eventsByDay = (
    db.prepare("SELECT substr(ts, 1, 10) AS day, event, COUNT(*) AS n FROM growth_events WHERE ts >= ? GROUP BY day, event ORDER BY day, event").all(since) as Array<{
      day: string;
      event: GrowthEvent;
      n: number;
    }>
  ).map((row) => ({ day: row.day, event: row.event, n: Number(row.n) }));
  const eventTotals = Object.fromEntries(GROWTH_EVENTS.map((event) => [event, 0])) as Record<GrowthEvent, number>;
  for (const row of eventsByDay) eventTotals[row.event] += row.n;
  const leadsByStage = Object.fromEntries(LEAD_STAGES.map((stage) => [stage, 0])) as Record<LeadStage, number>;
  for (const row of db.prepare("SELECT stage, COUNT(*) AS n FROM growth_leads GROUP BY stage").all() as Array<{ stage: LeadStage; n: number }>) {
    leadsByStage[row.stage] = Number(row.n);
  }
  const leadsDue = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM growth_leads WHERE next_step_at IS NOT NULL AND next_step_at <= ? AND stage NOT IN ('won', 'lost', 'opted_out')")
        .get(new Date(now).toISOString()) as { n: number }
    ).n,
  );
  const partnerClicks = (
    db
      .prepare("SELECT partner_code AS code, COUNT(*) AS n FROM growth_events WHERE event = 'partner_click' AND ts >= ? AND partner_code IS NOT NULL GROUP BY partner_code ORDER BY n DESC, code")
      .all(since) as Array<{ code: string; n: number }>
  ).map((row) => ({ code: row.code, n: Number(row.n) }));
  const kinds = db.prepare("SELECT kind, COUNT(*) AS n FROM growth_optouts GROUP BY kind").all() as Array<{ kind: "email" | "domain"; n: number }>;
  const emails = Number(kinds.find((row) => row.kind === "email")?.n ?? 0);
  const domains = Number(kinds.find((row) => row.kind === "domain")?.n ?? 0);
  return { days, since, eventsByDay, eventTotals, leadsByStage, leadsDue, partnerClicks, optouts: { total: emails + domains, emails, domains } };
}

// ---- Leads ---------------------------------------------------------------------------------------

export interface LeadFields {
  email: string | null;
  name: string | null;
  company: string | null;
  country: string | null;
  source: string | null;
  stage: LeadStage;
  seats: number | null;
  owner: string | null;
  notes: string | null;
  nextStepAt: string | null;
  consentBasis: string | null;
  lastContactAt: string | null;
}

export interface Lead extends LeadFields {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const LEAD_SELECT =
  "SELECT id, created_at AS createdAt, updated_at AS updatedAt, email, name, company, country, source, stage, seats, owner, notes, next_step_at AS nextStepAt, consent_basis AS consentBasis, last_contact_at AS lastContactAt FROM growth_leads";

const COLUMN: Record<keyof LeadFields, string> = {
  email: "email",
  name: "name",
  company: "company",
  country: "country",
  source: "source",
  stage: "stage",
  seats: "seats",
  owner: "owner",
  notes: "notes",
  nextStepAt: "next_step_at",
  consentBasis: "consent_basis",
  lastContactAt: "last_contact_at",
};

const asLead = (row: Record<string, unknown> | undefined): Lead | null => (row === undefined ? null : ({ ...row } as unknown as Lead));

export function getLead(db: Db, id: string): Lead | null {
  return asLead(db.prepare(`${LEAD_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
}

export function leadByEmail(db: Db, email: string): Lead | null {
  return asLead(db.prepare(`${LEAD_SELECT} WHERE email = ?`).get(email) as Record<string, unknown> | undefined);
}

export interface LeadFilter {
  readonly stage?: LeadStage;
  readonly owner?: string;
  /** Only open leads whose next step is due now. */
  readonly due?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export function listLeads(db: Db, filter: LeadFilter, now = Date.now()): { leads: Lead[]; total: number } {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.stage !== undefined) {
    where.push("stage = ?");
    args.push(filter.stage);
  }
  if (filter.owner !== undefined) {
    where.push("owner = ?");
    args.push(filter.owner);
  }
  if (filter.due === true) {
    where.push("next_step_at IS NOT NULL AND next_step_at <= ? AND stage NOT IN ('won', 'lost', 'opted_out')");
    args.push(new Date(now).toISOString());
  }
  const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM growth_leads${clause}`).get(...args) as { n: number }).n);
  const order = filter.due === true ? "next_step_at ASC, id" : "updated_at DESC, id";
  const leads = (db.prepare(`${LEAD_SELECT}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, filter.limit, filter.offset) as Array<Record<string, unknown>>).map(
    (row) => asLead(row)!,
  );
  return { leads, total };
}

export function createLead(db: Db, fields: LeadFields): Lead {
  const id = newId("lead");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO growth_leads (id, created_at, updated_at, email, name, company, country, source, stage, seats, owner, notes, next_step_at, consent_basis, last_contact_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    now,
    now,
    fields.email,
    fields.name,
    fields.company,
    fields.country,
    fields.source,
    fields.stage,
    fields.seats,
    fields.owner,
    fields.notes,
    fields.nextStepAt,
    fields.consentBasis,
    fields.lastContactAt,
  );
  return getLead(db, id)!;
}

export function updateLead(db: Db, id: string, patch: Partial<LeadFields>): Lead | null {
  const keys = Object.keys(patch) as Array<keyof LeadFields>;
  if (keys.length > 0) {
    const sets = keys.map((key) => `${COLUMN[key]} = ?`).join(", ");
    db.prepare(`UPDATE growth_leads SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => patch[key] ?? null), new Date().toISOString(), id);
  }
  return getLead(db, id);
}

// ---- Partner codes -------------------------------------------------------------------------------

export const PARTNER_CODE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface Partner {
  readonly code: string;
  readonly partnerName: string;
  readonly partnerEmail: string | null;
  readonly commissionPct: number;
  readonly active: boolean;
  readonly createdAt: string;
}

const PARTNER_SELECT =
  "SELECT code, partner_name AS partnerName, partner_email AS partnerEmail, commission_pct AS commissionPct, active, created_at AS createdAt FROM growth_partner_codes";

const asPartner = (row: Record<string, unknown> | undefined): Partner | null =>
  row === undefined ? null : ({ ...row, commissionPct: Number(row.commissionPct), active: Number(row.active) === 1 } as unknown as Partner);

export function getPartner(db: Db, code: string): Partner | null {
  return asPartner(db.prepare(`${PARTNER_SELECT} WHERE code = ?`).get(code) as Record<string, unknown> | undefined);
}

/** Every code with its clicks (all time). */
export function listPartners(db: Db): Array<Partner & { readonly clicks: number }> {
  const clicks = new Map(
    (db.prepare("SELECT partner_code AS code, COUNT(*) AS n FROM growth_events WHERE event = 'partner_click' GROUP BY partner_code").all() as Array<{ code: string; n: number }>).map(
      (row) => [row.code, Number(row.n)],
    ),
  );
  return (db.prepare(`${PARTNER_SELECT} ORDER BY created_at, code`).all() as Array<Record<string, unknown>>).map((row) => {
    const partner = asPartner(row)!;
    return { ...partner, clicks: clicks.get(partner.code) ?? 0 };
  });
}

/** Creates the code, or changes the fields given for an existing one. */
export function savePartner(
  db: Db,
  input: { code: string; partnerName?: string; partnerEmail?: string | null; commissionPct?: number; active?: boolean },
): { partner: Partner; created: boolean } {
  const existing = getPartner(db, input.code);
  if (existing === null) {
    if (input.partnerName === undefined) throw new Error("partnerName is required for a new code");
    db.prepare("INSERT INTO growth_partner_codes (code, partner_name, partner_email, commission_pct, active, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      input.code,
      input.partnerName,
      input.partnerEmail ?? null,
      input.commissionPct ?? 20,
      input.active === false ? 0 : 1,
      new Date().toISOString(),
    );
    return { partner: getPartner(db, input.code)!, created: true };
  }
  db.prepare("UPDATE growth_partner_codes SET partner_name = ?, partner_email = ?, commission_pct = ?, active = ? WHERE code = ?").run(
    input.partnerName ?? existing.partnerName,
    input.partnerEmail === undefined ? existing.partnerEmail : input.partnerEmail,
    input.commissionPct ?? existing.commissionPct,
    (input.active ?? existing.active) ? 1 : 0,
    input.code,
  );
  return { partner: getPartner(db, input.code)!, created: false };
}

export function activePartner(db: Db, code: string): Partner | null {
  const partner = getPartner(db, code);
  return partner !== null && partner.active ? partner : null;
}

// ---- Opt-outs ------------------------------------------------------------------------------------

export const EMAIL = /^[^\s@]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** An e-mail or a domain, lower-case; null when it is neither. */
export function exclusionOf(raw: string): { value: string; kind: "email" | "domain" } | null {
  const value = raw.trim().toLowerCase();
  if (value.length > 254) return null;
  const domain = value.startsWith("@") ? value.slice(1) : value;
  if (domain.includes("@")) return EMAIL.test(domain) ? { value: domain, kind: "email" } : null;
  return DOMAIN.test(domain) && domain.length <= 253 ? { value: domain, kind: "domain" } : null;
}

export interface Optout {
  readonly value: string;
  readonly kind: "email" | "domain";
  readonly reason: string | null;
  readonly source: string | null;
  readonly createdAt: string;
}

/** The address itself, its domain and every parent domain with at least two labels. */
function candidatesOf(value: string): string[] {
  const at = value.lastIndexOf("@");
  const domain = at === -1 ? value : value.slice(at + 1);
  const labels = domain.split(".");
  const parents = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  return at === -1 ? parents : [value, ...parents];
}

/** Whether an e-mail (or a domain) is on the list: the address, its domain or a parent domain. */
export function excludedBy(db: Db, raw: string): Optout | null {
  const parsed = exclusionOf(raw);
  if (parsed === null) return null;
  const candidates = candidatesOf(parsed.value);
  const row = db
    .prepare(`SELECT value, kind, reason, source, created_at AS createdAt FROM growth_optouts WHERE value IN (${candidates.map(() => "?").join(", ")}) ORDER BY kind = 'email' DESC LIMIT 1`)
    .get(...candidates) as Optout | undefined;
  return row === undefined ? null : { ...row };
}

/**
 * Adds an e-mail or a domain (once; adding it again changes nothing) and moves the matching leads
 * to `opted_out`. Returns whether it was new and how many leads moved.
 */
export function addOptout(db: Db, input: { value: string; kind: "email" | "domain"; reason: string | null; source: string | null }): { optout: Optout; created: boolean; leadsMoved: number } {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    const created = Number(
      db.prepare("INSERT OR IGNORE INTO growth_optouts (value, kind, reason, source, created_at) VALUES (?, ?, ?, ?, ?)").run(input.value, input.kind, input.reason, input.source, now).changes,
    ) > 0;
    const moved =
      input.kind === "email"
        ? db.prepare("UPDATE growth_leads SET stage = 'opted_out', updated_at = ? WHERE email = ? AND stage <> 'opted_out'").run(now, input.value)
        : db
            .prepare("UPDATE growth_leads SET stage = 'opted_out', updated_at = ? WHERE (email LIKE ? OR email LIKE ?) AND stage <> 'opted_out'")
            .run(now, `%@${input.value}`, `%@%.${input.value}`);
    db.exec("COMMIT");
    const optout = db.prepare("SELECT value, kind, reason, source, created_at AS createdAt FROM growth_optouts WHERE value = ?").get(input.value) as unknown as Optout;
    return { optout: { ...optout }, created, leadsMoved: Number(moved.changes) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listOptouts(db: Db, limit: number, offset: number): { optouts: Optout[]; total: number } {
  const total = Number((db.prepare("SELECT COUNT(*) AS n FROM growth_optouts").get() as { n: number }).n);
  const optouts = (
    db.prepare("SELECT value, kind, reason, source, created_at AS createdAt FROM growth_optouts ORDER BY created_at DESC, value LIMIT ? OFFSET ?").all(limit, offset) as unknown as Optout[]
  ).map((row) => ({ ...row }));
  return { optouts, total };
}
