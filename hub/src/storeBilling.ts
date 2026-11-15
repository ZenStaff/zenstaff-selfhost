// SQL for payments (v12): the company's billing account (its Stripe customer and subscription as
// the webhooks last reported them), the Stripe events already handled, one-off package orders and
// the fiscal invoices. The hub never stores card or bank details; Stripe keeps those.
import { newId } from "./crypto.ts";
import type { Db } from "./db.ts";
import { asStatus, type SubscriptionStatus } from "./billing/plan.ts";

const nowIso = () => new Date().toISOString();

export interface BillingAccount {
  readonly companyId: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly plan: "none" | "hosted";
  readonly status: SubscriptionStatus;
  readonly seats: number;
  readonly servers: number;
  readonly seatItemId: string | null;
  readonly serverItemId: string | null;
  /** Epoch seconds (Stripe's unit). */
  readonly trialEnd: number | null;
  readonly currentPeriodEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  /** Epoch ms. */
  readonly pastDueSince: number | null;
  readonly vatCountry: string | null;
  readonly vatId: string | null;
  /** valid | invalid | unavailable | not_eu (VIES), null when not checked. */
  readonly vatCheck: string | null;
  readonly vatCheckedAt: number | null;
  /** `created` of the last subscription event applied (epoch seconds): older events are ignored. */
  readonly lastEventAt: number | null;
}

interface AccountRow {
  company_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: "none" | "hosted";
  status: string;
  seats: number;
  servers: number;
  seat_item_id: string | null;
  server_item_id: string | null;
  trial_end: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  past_due_since: number | null;
  vat_country: string | null;
  vat_id: string | null;
  vat_check: string | null;
  vat_checked_at: number | null;
  last_event_at: number | null;
}

const toAccount = (row: AccountRow): BillingAccount => ({
  companyId: row.company_id,
  stripeCustomerId: row.stripe_customer_id,
  stripeSubscriptionId: row.stripe_subscription_id,
  plan: row.plan,
  status: asStatus(row.status),
  seats: row.seats,
  servers: row.servers,
  seatItemId: row.seat_item_id,
  serverItemId: row.server_item_id,
  trialEnd: row.trial_end,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  pastDueSince: row.past_due_since,
  vatCountry: row.vat_country,
  vatId: row.vat_id,
  vatCheck: row.vat_check,
  vatCheckedAt: row.vat_checked_at,
  lastEventAt: row.last_event_at,
});

export const emptyAccount = (companyId: string): BillingAccount => ({
  companyId,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  plan: "none",
  status: "none",
  seats: 0,
  servers: 0,
  seatItemId: null,
  serverItemId: null,
  trialEnd: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  vatCountry: null,
  vatId: null,
  vatCheck: null,
  vatCheckedAt: null,
  lastEventAt: null,
});

export function accountOf(db: Db, companyId: string): BillingAccount {
  const row = db.prepare("SELECT * FROM billing_accounts WHERE company_id = ?").get(companyId) as AccountRow | undefined;
  return row === undefined ? emptyAccount(companyId) : toAccount(row);
}

export function accountByCustomer(db: Db, customerId: string): BillingAccount | null {
  const row = db.prepare("SELECT * FROM billing_accounts WHERE stripe_customer_id = ?").get(customerId) as AccountRow | undefined;
  return row === undefined ? null : toAccount(row);
}

export function accountBySubscription(db: Db, subscriptionId: string): BillingAccount | null {
  const row = db.prepare("SELECT * FROM billing_accounts WHERE stripe_subscription_id = ?").get(subscriptionId) as AccountRow | undefined;
  return row === undefined ? null : toAccount(row);
}

/** Companies with a subscription that can still change (for the periodic seat reconcile). */
export function liveAccounts(db: Db): Array<BillingAccount> {
  return (
    db
      .prepare("SELECT * FROM billing_accounts WHERE stripe_subscription_id IS NOT NULL AND status IN ('trialing', 'active', 'past_due', 'incomplete')")
      .all() as unknown as Array<AccountRow>
  ).map(toAccount);
}

const COLUMNS: Record<string, string> = {
  stripeCustomerId: "stripe_customer_id",
  stripeSubscriptionId: "stripe_subscription_id",
  plan: "plan",
  status: "status",
  seats: "seats",
  servers: "servers",
  seatItemId: "seat_item_id",
  serverItemId: "server_item_id",
  trialEnd: "trial_end",
  currentPeriodEnd: "current_period_end",
  cancelAtPeriodEnd: "cancel_at_period_end",
  pastDueSince: "past_due_since",
  vatCountry: "vat_country",
  vatId: "vat_id",
  vatCheck: "vat_check",
  vatCheckedAt: "vat_checked_at",
  lastEventAt: "last_event_at",
};

export type AccountPatch = Partial<Omit<BillingAccount, "companyId">>;

/** Creates the row when missing and sets the given fields. */
export function patchAccount(db: Db, companyId: string, patch: AccountPatch) {
  db.prepare("INSERT INTO billing_accounts (company_id, updated_at) VALUES (?, ?) ON CONFLICT (company_id) DO NOTHING").run(companyId, nowIso());
  const entries = Object.entries(patch).filter(([key, value]) => COLUMNS[key] !== undefined && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
  const values = entries.map(([, value]) => (typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null)));
  db.prepare(`UPDATE billing_accounts SET ${sets}, updated_at = ? WHERE company_id = ?`).run(...values, nowIso(), companyId);
}

// ---- Webhook events (idempotency) ------------------------------------------------------------

/**
 * Records a Stripe event before handling it. "new": handle it; "done": it was handled already
 * (Stripe delivers at least once and retries), answer 200 and do nothing; "retry": it failed
 * before, handle it again.
 */
export function claimEvent(db: Db, event: { id: string; type: string; created: number }): "new" | "done" | "retry" {
  const existing = db.prepare("SELECT processed_at FROM billing_events WHERE id = ?").get(event.id) as { processed_at: string | null } | undefined;
  if (existing !== undefined) return existing.processed_at === null ? "retry" : "done";
  db.prepare("INSERT INTO billing_events (id, type, created, received_at) VALUES (?, ?, ?, ?)").run(event.id, event.type, event.created, nowIso());
  return "new";
}

export function finishEvent(db: Db, eventId: string, outcome: { companyId: string | null; error?: string }) {
  if (outcome.error === undefined) {
    db.prepare("UPDATE billing_events SET processed_at = ?, company_id = ?, error = NULL WHERE id = ?").run(nowIso(), outcome.companyId, eventId);
  } else {
    db.prepare("UPDATE billing_events SET error = ?, company_id = ? WHERE id = ?").run(outcome.error.slice(0, 500), outcome.companyId, eventId);
  }
}

export function eventCount(db: Db) {
  return (db.prepare("SELECT COUNT(*) AS n FROM billing_events").get() as { n: number }).n;
}

// ---- Package orders ---------------------------------------------------------------------------

export function createOrder(db: Db, input: { companyId: string; packageId: string; amountEur: number; createdBy: string }) {
  const id = newId("ord");
  db.prepare("INSERT INTO billing_orders (id, company_id, package, amount_eur, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    input.companyId,
    input.packageId,
    input.amountEur,
    input.createdBy,
    nowIso(),
  );
  return id;
}

export function setOrderSession(db: Db, orderId: string, sessionId: string) {
  db.prepare("UPDATE billing_orders SET checkout_session_id = ? WHERE id = ?").run(sessionId, orderId);
}

export function markOrder(db: Db, sessionId: string, status: "paid" | "expired") {
  db.prepare(`UPDATE billing_orders SET status = ?, paid_at = ${status === "paid" ? "?" : "NULL"} WHERE checkout_session_id = ? AND status = 'open'`).run(
    ...(status === "paid" ? [status, nowIso(), sessionId] : [status, sessionId]),
  );
}

export function ordersOf(db: Db, companyId: string) {
  return db
    .prepare("SELECT id, package, amount_eur AS amountEur, status, created_at AS createdAt, paid_at AS paidAt FROM billing_orders WHERE company_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(companyId) as Array<{ id: string; package: string; amountEur: number; status: string; createdAt: string; paidAt: string | null }>;
}

// ---- Fiscal invoices --------------------------------------------------------------------------

export interface StoredInvoice {
  readonly stripeInvoiceId: string;
  readonly companyId: string;
  readonly kind: "subscription" | "package";
  readonly amountCents: number;
  readonly taxCents: number;
  readonly currency: string;
  readonly periodStart: number | null;
  readonly periodEnd: number | null;
  readonly paidAt: number;
  readonly stripePdfUrl: string | null;
  readonly fiscalProvider: string | null;
  readonly fiscalRef: string | null;
  readonly fiscalStatus: "pending" | "issued" | "dry_run" | "failed";
  readonly fiscalSeries: string | null;
  readonly fiscalNumber: string | null;
  readonly fiscalPdfUrl: string | null;
  readonly efacturaStatus: string | null;
  readonly fiscalError: string | null;
  readonly attempts: number;
}

const INVOICE_SELECT = `SELECT stripe_invoice_id AS stripeInvoiceId, company_id AS companyId, kind, amount_cents AS amountCents, tax_cents AS taxCents,
  currency, period_start AS periodStart, period_end AS periodEnd, paid_at AS paidAt, stripe_pdf_url AS stripePdfUrl, fiscal_provider AS fiscalProvider, fiscal_ref AS fiscalRef,
  fiscal_status AS fiscalStatus, fiscal_series AS fiscalSeries, fiscal_number AS fiscalNumber, fiscal_pdf_url AS fiscalPdfUrl,
  efactura_status AS efacturaStatus, fiscal_error AS fiscalError, attempts FROM billing_invoices`;

/** Records a paid Stripe invoice once; false when it was already recorded (a repeated event). */
export function recordInvoice(
  db: Db,
  input: Omit<StoredInvoice, "fiscalProvider" | "fiscalRef" | "fiscalStatus" | "fiscalSeries" | "fiscalNumber" | "fiscalPdfUrl" | "efacturaStatus" | "fiscalError" | "attempts">,
): boolean {
  const result = db
    .prepare(
      `INSERT INTO billing_invoices (stripe_invoice_id, company_id, kind, amount_cents, tax_cents, currency, period_start, period_end, paid_at, stripe_pdf_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stripe_invoice_id) DO NOTHING`,
    )
    .run(
      input.stripeInvoiceId,
      input.companyId,
      input.kind,
      input.amountCents,
      input.taxCents,
      input.currency,
      input.periodStart,
      input.periodEnd,
      input.paidAt,
      input.stripePdfUrl,
      nowIso(),
      nowIso(),
    );
  return Number(result.changes) > 0;
}

export function getInvoice(db: Db, stripeInvoiceId: string): StoredInvoice | null {
  return (db.prepare(`${INVOICE_SELECT} WHERE stripe_invoice_id = ?`).get(stripeInvoiceId) as unknown as StoredInvoice | undefined) ?? null;
}

export function invoicesOf(db: Db, companyId: string, limit = 50): Array<StoredInvoice> {
  return db.prepare(`${INVOICE_SELECT} WHERE company_id = ? ORDER BY paid_at DESC LIMIT ?`).all(companyId, limit) as unknown as Array<StoredInvoice>;
}

/** Invoices whose fiscal invoice still has to be issued (pending, or failed fewer than `maxAttempts` times). */
export function invoicesToIssue(db: Db, maxAttempts = 8): Array<StoredInvoice> {
  return db
    .prepare(`${INVOICE_SELECT} WHERE fiscal_status IN ('pending', 'failed') AND attempts < ? ORDER BY paid_at LIMIT 20`)
    .all(maxAttempts) as unknown as Array<StoredInvoice>;
}

/** Issued fiscal invoices whose e-Factura answer is not final yet (to ask the provider again). */
export function invoicesAwaitingEfactura(db: Db): Array<StoredInvoice> {
  return db
    .prepare(`${INVOICE_SELECT} WHERE fiscal_status = 'issued' AND (efactura_status IS NULL OR efactura_status IN ('pending', 'uploaded', 'in_processing')) ORDER BY paid_at LIMIT 20`)
    .all() as unknown as Array<StoredInvoice>;
}

export function setFiscal(
  db: Db,
  stripeInvoiceId: string,
  patch: {
    provider: string;
    status: StoredInvoice["fiscalStatus"];
    ref?: string | null;
    series?: string | null;
    number?: string | null;
    pdfUrl?: string | null;
    efacturaStatus?: string | null;
    error?: string | null;
    countAttempt?: boolean;
  },
) {
  db.prepare(
    `UPDATE billing_invoices SET fiscal_provider = ?, fiscal_status = ?, fiscal_ref = COALESCE(?, fiscal_ref), fiscal_series = COALESCE(?, fiscal_series), fiscal_number = COALESCE(?, fiscal_number),
       fiscal_pdf_url = COALESCE(?, fiscal_pdf_url), efactura_status = COALESCE(?, efactura_status), fiscal_error = ?, attempts = attempts + ?, updated_at = ?
     WHERE stripe_invoice_id = ?`,
  ).run(
    patch.provider,
    patch.status,
    patch.ref ?? null,
    patch.series ?? null,
    patch.number ?? null,
    patch.pdfUrl ?? null,
    patch.efacturaStatus ?? null,
    patch.error ?? null,
    patch.countAttempt === false ? 0 : 1,
    nowIso(),
    stripeInvoiceId,
  );
}
