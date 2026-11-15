// A small Stripe client over fetch (no SDK: the hub keeps its dependencies few) and the webhook
// signature check. Requests are form-encoded, carry a pinned Stripe-Version and, for every write,
// an Idempotency-Key, so a retried call never creates a second customer, session or change.
import { createHmac, timingSafeEqual } from "node:crypto";

/** The API version the hub is written against (also set on the webhook endpoint in the dashboard). */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export type Params = { readonly [key: string]: Param };
type Param = string | number | boolean | null | undefined | Params | ReadonlyArray<Param>;

/** Stripe's bracket encoding: { items: [{ price: "p", quantity: 2 }] } -> items[0][price]=p&items[0][quantity]=2. */
export function formEncode(params: Params): string {
  const pairs: Array<string> = [];
  const walk = (prefix: string, value: Param) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Params)) walk(prefix === "" ? key : `${prefix}[${key}]`, inner);
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  walk("", params);
  return pairs.join("&");
}

export class StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** What the hub asks Stripe. Tests pass a fake; production uses makeStripe(). */
export interface StripeApi {
  readonly mode: "test" | "live";
  request(method: "GET" | "POST" | "DELETE", path: string, params?: Params, idempotencyKey?: string): Promise<any>;
}

export function makeStripe(secretKey: string, fetchImpl: typeof fetch = fetch): StripeApi {
  const mode = secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_") ? "live" : "test";
  return {
    mode,
    async request(method, path, params = {}, idempotencyKey) {
      const query = method === "GET" || method === "DELETE" ? formEncode(params) : "";
      const response = await fetchImpl(`https://api.stripe.com${path}${query === "" ? "" : `?${query}`}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        ...(method === "POST" ? { body: formEncode(params) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      if (!response.ok) {
        throw new StripeError(response.status, body.error?.message ?? `Stripe answered ${response.status}`, body.error?.code ?? null);
      }
      return body;
    },
  };
}

// ---- Webhooks ---------------------------------------------------------------------------------

/** Stripe's default: an event signed more than 5 minutes ago is refused (replays). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Checks the `Stripe-Signature` header ("t=<unix>,v1=<hex>[,v1=<hex>...]") over the raw body:
 * HMAC-SHA256 with the endpoint secret over "<t>.<body>", compared in constant time against every
 * v1 entry (there are two while a secret is being rolled), and a timestamp within the tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): { ok: true } | { ok: false; reason: string } {
  if (header === undefined || header === "") return { ok: false, reason: "missing signature" };
  let timestamp = Number.NaN;
  const signatures: Array<string> = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((item) => item.trim());
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value !== undefined && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (!Number.isInteger(timestamp) || signatures.length === 0) return { ok: false, reason: "malformed signature" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp outside the tolerance" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const match = signatures.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "signature does not match" };
}

/** A header the way Stripe builds it (for tests and the local `stripe trigger` replacement). */
export function signStripePayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

// ---- Reading Stripe objects ---------------------------------------------------------------------

/** The id of an expandable field (a string, or an object with an id). */
export const idOf = (value: unknown): string | null =>
  typeof value === "string" ? value : value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;

/** The subscription an invoice belongs to: `parent.subscription_details` (2025-03 and later) or the old top-level field. */
export function subscriptionOfInvoice(invoice: any): string | null {
  return idOf(invoice?.parent?.subscription_details?.subscription) ?? idOf(invoice?.subscription);
}

/** The end of the current period: on the items since 2025-03 (basil), on the subscription before. */
export function periodEndOf(subscription: any): number | null {
  const items: Array<any> = subscription?.items?.data ?? [];
  const ends = items.map((item) => item?.current_period_end).filter((value): value is number => typeof value === "number");
  if (ends.length > 0) return Math.min(...ends);
  return typeof subscription?.current_period_end === "number" ? subscription.current_period_end : null;
}
