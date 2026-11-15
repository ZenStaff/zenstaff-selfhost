// The hosted plan's rules, as pure functions: prices, seats, what a Stripe subscription status
// means for the company (the state machine and the soft enforcement), the VAT treatment of an
// invoice and the next invoice estimate. No database, no network: tests cover them directly.
import { isEuCountry } from "./taxId.ts";

/** Final prices (Alex, 08.11.2026), in euro. Stripe holds the real prices; these are for display. */
export const PRICES = {
  seatEur: 29,
  serverEur: 9,
} as const;

/** "Făcut pentru tine": one-off setup packages, paid through Checkout in payment mode. */
export const PACKAGES = [
  {
    id: "start",
    name: "Start",
    priceEur: 49,
    items: ["Instalare și contul de AI al firmei", "3–5 unelte conectate", "2–3 agenți din catalog", "O scurtă instruire"],
  },
  {
    id: "standard",
    name: "Standard",
    priceEur: 149,
    items: ["Tot ce e în Start", "Profilul firmei, din interviu", "Memoria încărcată din documentele voastre", "5–8 agenți și fluxuri pe firmă", "Serverul non-stop configurat"],
  },
  {
    id: "complet",
    name: "Complet",
    priceEur: 290,
    items: ["Tot ce e în Standard", "Conectori speciali pentru programele voastre", "Importul chaturilor și documentelor vechi", "30 de zile de suport"],
  },
] as const;

export type PackageId = (typeof PACKAGES)[number]["id"];
export const packageOf = (id: unknown) => PACKAGES.find((item) => item.id === id) ?? null;

// ---- Seats ------------------------------------------------------------------------------------

/**
 * Paying seats: owners, admins and members. Guests are free (they only see what is shared with
 * them and cannot use the AI staff). A subscription always has at least one seat.
 */
export function seatCount(byRole: { owner: number; admin: number; member: number; guest: number }): number {
  return Math.max(1, byRole.owner + byRole.admin + byRole.member);
}

/**
 * What to send to Stripe for the seat item: null when nothing changes or the subscription cannot
 * take a change (ended). Stripe prorates by default: adding a seat mid-month bills the rest of the
 * month on the next invoice, removing one credits it. During the trial nothing is charged.
 */
export function seatChange(input: { status: SubscriptionStatus; billedSeats: number; desiredSeats: number }): { quantity: number } | null {
  if (!["trialing", "active", "past_due", "incomplete"].includes(input.status)) return null;
  const quantity = Math.max(1, Math.floor(input.desiredSeats));
  return quantity === input.billedSeats ? null : { quantity };
}

// ---- Subscription state ----------------------------------------------------------------------

/** Stripe subscription statuses, plus `none` (the company never subscribed). */
export const STATUSES = ["none", "incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "canceled", "paused"] as const;
export type SubscriptionStatus = (typeof STATUSES)[number];

export const asStatus = (value: unknown): SubscriptionStatus =>
  (STATUSES as ReadonlyArray<unknown>).includes(value) ? (value as SubscriptionStatus) : "none";

/**
 * What the company may do on the hosted hub.
 * - `full`: everything (trialing, active, no subscription yet, or a self-hosted hub).
 * - `warn`: everything, with a banner: a payment failed and the grace period runs (past_due), or
 *   the first payment is still being confirmed (incomplete, e.g. SEPA).
 * - `readonly`: team features stop changing (invitations, AI staff, packs, settings, runners);
 *   everything stays readable, nothing is deleted, and billing, leaving the company and the company
 *   details keep working. Personal use and self-hosted hubs are never limited.
 */
export type Access = "full" | "warn" | "readonly";

export interface AccessState {
  readonly access: Access;
  /** Why, for the banner: none | trial | active | payment_failed | grace_over | unpaid | canceled | paused | pending. */
  readonly reason: string;
  /** When the grace period ends (past_due), epoch ms. */
  readonly graceEndsAt: number | null;
}

export const DAY_MS = 24 * 60 * 60_000;

export function accessFor(input: {
  readonly hosted: boolean;
  readonly status: SubscriptionStatus;
  /** When the subscription first went past_due or unpaid (epoch ms), null when it is paid up. */
  readonly pastDueSince: number | null;
  readonly now: number;
  readonly graceDays?: number;
}): AccessState {
  if (!input.hosted) return { access: "full", reason: "selfhost", graceEndsAt: null };
  const graceMs = (input.graceDays ?? 7) * DAY_MS;
  switch (input.status) {
    case "none":
    case "incomplete_expired":
      return { access: "full", reason: "none", graceEndsAt: null };
    case "trialing":
      return { access: "full", reason: "trial", graceEndsAt: null };
    case "active":
      return { access: "full", reason: "active", graceEndsAt: null };
    case "incomplete":
      return { access: "warn", reason: "pending", graceEndsAt: null };
    case "past_due": {
      const since = input.pastDueSince ?? input.now;
      const graceEndsAt = since + graceMs;
      return input.now < graceEndsAt
        ? { access: "warn", reason: "payment_failed", graceEndsAt }
        : { access: "readonly", reason: "grace_over", graceEndsAt };
    }
    case "unpaid":
      return { access: "readonly", reason: "unpaid", graceEndsAt: null };
    case "canceled":
      return { access: "readonly", reason: "canceled", graceEndsAt: null };
    case "paused":
      return { access: "readonly", reason: "paused", graceEndsAt: null };
  }
}

/**
 * The next value of `past_due_since` when a subscription moves to `status`: the grace period starts
 * the first time a payment fails and is kept while it stays unpaid; paying clears it.
 */
export function nextPastDueSince(previous: number | null, status: SubscriptionStatus, now: number): number | null {
  if (status === "past_due" || status === "unpaid") return previous ?? now;
  return null;
}

/** A subscription that is live (Checkout must not start a second one). */
export const isLive = (status: SubscriptionStatus) => ["trialing", "active", "past_due", "unpaid", "incomplete", "paused"].includes(status);

/**
 * Mutating requests that stay allowed while the company is read-only: billing itself, leaving or
 * removing a member (it lowers the bill), the company details (needed for invoices) and its name.
 */
export function allowedWhileReadOnly(method: string, rest: string): boolean {
  if (rest === "" && method === "PATCH") return true;
  if (rest.startsWith("/billing")) return true;
  if (method === "DELETE" && /^\/members\/[^/]+$/.test(rest)) return true;
  if (method === "DELETE" && /^\/invites\/[^/]+$/.test(rest)) return true;
  return false;
}

// ---- VAT ------------------------------------------------------------------------------------

/** Romania's standard VAT rate since 1 August 2025 (Legea 141/2025; it was 19% before). */
export const RO_VAT_RATE = 21;

export type VatTreatment =
  /** The seller is not registered for VAT (art. 310 Cod fiscal): no VAT on any invoice. */
  | { readonly kind: "not_registered"; readonly rate: 0; readonly note: string }
  /** Romanian VAT charged. */
  | { readonly kind: "standard"; readonly rate: number; readonly note: null }
  /** EU business with a valid VAT number: the customer accounts for the VAT. */
  | { readonly kind: "reverse_charge"; readonly rate: 0; readonly note: string }
  /** Customer outside the EU: the service is not taxed in Romania. */
  | { readonly kind: "outside_scope"; readonly rate: 0; readonly note: string };

/**
 * How an invoice to this customer is taxed. The seller, FORTITUDO VINCIT S.R.L. (CUI 43990858), is not registered
 * for VAT (ANAF, checked 08.11.2026: scpTVA false), so the default is `not_registered`; once it
 * registers, set BILLING_SELLER_VAT=registered.
 * An EU customer with a VAT number that VIES did not reject gets reverse charge (Stripe Tax does the
 * same when the number is well formed).
 */
export function vatTreatment(input: {
  readonly sellerVatRegistered: boolean;
  readonly country: string | null;
  readonly euVatValid: boolean;
}): VatTreatment {
  if (!input.sellerVatRegistered) {
    return { kind: "not_registered", rate: 0, note: "Furnizor neplătitor de TVA (art. 310 Cod fiscal)." };
  }
  const country = input.country ?? "RO";
  if (country === "RO") return { kind: "standard", rate: RO_VAT_RATE, note: null };
  if (isEuCountry(country)) {
    if (input.euVatValid) return { kind: "reverse_charge", rate: 0, note: "Taxare inversă (art. 196 Directiva 2006/112/CE; art. 278 alin. (2) Cod fiscal)." };
    // A consumer or an unregistered business in the EU: Romanian VAT while under the EU-wide 10,000 €
    // threshold for e-services (Stripe Tax switches to the customer's country above it, via OSS).
    return { kind: "standard", rate: RO_VAT_RATE, note: null };
  }
  return { kind: "outside_scope", rate: 0, note: "Serviciu neimpozabil în România (art. 278 alin. (2) Cod fiscal)." };
}

/** The next invoice of a live subscription, estimated here (Stripe computes the real one). */
export function estimateNextInvoice(input: { seats: number; servers: number; vat: VatTreatment }) {
  const subtotal = input.seats * PRICES.seatEur + input.servers * PRICES.serverEur;
  const vat = Math.round(subtotal * input.vat.rate) / 100;
  return { subtotalEur: subtotal, vatEur: vat, totalEur: subtotal + vat, vatRate: input.vat.rate, treatment: input.vat.kind };
}
