// Billing configuration from the environment (README.md, "Billing"). Everything is optional: with
// no Stripe key the Plan page shows the prices and says payments are not switched on; with no
// HoReCaOS key fiscal invoices are a dry run (logged, never issued).
import type { Seller } from "./invoicing.ts";
import type { HoReCaOSConfig } from "./invoicing.ts";

export interface BillingConfig {
  readonly stripeSecretKey: string | null;
  readonly stripeWebhookSecret: string | null;
  readonly prices: {
    readonly seat: string | null;
    readonly server: string | null;
    readonly packages: { readonly start: string | null; readonly standard: string | null; readonly complet: string | null };
  };
  /** Stripe Tax computes VAT on Checkout and invoices (STRIPE_TAX=1); off while the seller is not VAT registered. */
  readonly stripeTax: boolean;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly seller: Seller;
  readonly horecaos: HoReCaOSConfig | null;
}

const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : value.trim());
const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export function billingConfigFromEnv(env: Record<string, string | undefined>, log: (line: string) => void = () => undefined): BillingConfig {
  let secret = text(env.STRIPE_SECRET_KEY);
  if (secret !== null && /^(sk|rk)_live_/.test(secret) && env.STRIPE_LIVE !== "1") {
    log("billing: STRIPE_SECRET_KEY is a live key but STRIPE_LIVE is not 1; payments stay off");
    secret = null;
  }
  const baseUrl = text(env.HORECAOS_API_URL)?.replace(/\/$/, "") ?? null;
  const apiKey = text(env.HORECAOS_API_KEY);
  return {
    stripeSecretKey: secret,
    stripeWebhookSecret: text(env.STRIPE_WEBHOOK_SECRET),
    prices: {
      seat: text(env.STRIPE_PRICE_SEAT),
      server: text(env.STRIPE_PRICE_SERVER),
      packages: {
        start: text(env.STRIPE_PRICE_PACKAGE_START),
        standard: text(env.STRIPE_PRICE_PACKAGE_STANDARD),
        complet: text(env.STRIPE_PRICE_PACKAGE_COMPLET),
      },
    },
    stripeTax: env.STRIPE_TAX === "1",
    trialDays: int(env.BILLING_TRIAL_DAYS, 14, 0, 60),
    graceDays: int(env.BILLING_GRACE_DAYS, 7, 0, 60),
    seller: {
      legalName: text(env.BILLING_SELLER_NAME) ?? "FORTITUDO VINCIT S.R.L.",
      taxId: text(env.BILLING_SELLER_CUI) ?? "43990858",
      registryNo: text(env.BILLING_SELLER_REG) ?? "J2021000522266",
      vatRegistered: env.BILLING_SELLER_VAT === "registered",
    },
    horecaos:
      baseUrl !== null && apiKey !== null
        ? { baseUrl, apiKey, seriesId: text(env.HORECAOS_INVOICE_SERIES_ID), locationId: text(env.HORECAOS_LOCATION_ID) }
        : null,
  };
}

/** Defaults for tests and for hubs without billing: nothing configured. */
export const noBilling = (): BillingConfig => billingConfigFromEnv({});
