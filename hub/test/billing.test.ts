// Payments for the hosted plan: the CUI / VAT validators, the Stripe webhook signature and the
// idempotent event store, seat sync math, the subscription state machine and soft enforcement,
// VAT treatment, and the fiscal invoicing seam (dry run and HoReCaOS, with a fake fetch). Stripe is
// a fake that records requests and answers like the API: no network call leaves the tests.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { billingConfigFromEnv } from "../src/billing/config.ts";
import { buildFiscalInvoice, dryRunInvoicing, efacturaWord, fiscalProblems, horecaosBody, horecaosInvoicing, type InvoicingProvider } from "../src/billing/invoicing.ts";
import { accessFor, allowedWhileReadOnly, DAY_MS, estimateNextInvoice, nextPastDueSince, RO_VAT_RATE, seatChange, seatCount, vatTreatment } from "../src/billing/plan.ts";
import { formEncode, periodEndOf, signStripePayload, type StripeApi, subscriptionOfInvoice, verifyStripeSignature } from "../src/billing/stripe.ts";
import { countryCode, isValidRoCui, parseEuVat, parseRoCui } from "../src/billing/taxId.ts";
import * as billingStore from "../src/storeBilling.ts";
import { emptyDetails } from "../src/storeDashboard.ts";
import { type Hub, makeClient, type Person, startHub, tick } from "./harness.ts";

const SECRET = "whsec_test_secret";
const PRICES_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_PRICE_SEAT: "price_seat",
  STRIPE_PRICE_SERVER: "price_server",
  STRIPE_PRICE_PACKAGE_START: "price_start",
  STRIPE_PRICE_PACKAGE_STANDARD: "price_standard",
  STRIPE_PRICE_PACKAGE_COMPLET: "price_complet",
};

// ---- Pure rules ---------------------------------------------------------------------------------

describe("CUI and VAT numbers", () => {
  it("accept a CUI with the right check digit, with or without RO", () => {
    assert.deepEqual(parseRoCui("43990858"), { digits: "43990858", vatPrefixed: false });
    assert.deepEqual(parseRoCui("ro 4399 0858"), { digits: "43990858", vatPrefixed: true });
    assert.ok(isValidRoCui("RO14399840")); // Dante International (eMAG)
    assert.ok(isValidRoCui("18547290"));
  });

  it("refuse a wrong check digit, letters, a leading zero and the wrong length", () => {
    for (const bad of ["43990857", "RO12345678", "4399O858", "043990858", "1", "12345678901", "", "RO"]) assert.equal(parseRoCui(bad), null, bad);
  });

  it("parse EU VAT numbers in their country's format (Greece is EL) and check RO ones too", () => {
    assert.deepEqual(parseEuVat("DE 123 456 789", "DE"), { prefix: "DE", number: "123456789", full: "DE123456789" });
    assert.deepEqual(parseEuVat("123456789", "GR"), { prefix: "EL", number: "123456789", full: "EL123456789" });
    assert.equal(parseEuVat("NL123456789B01", "NL")?.full, "NL123456789B01");
    assert.equal(parseEuVat("DE12345", "DE"), null);
    assert.equal(parseEuVat("RO12345678", "RO"), null);
    assert.equal(parseEuVat("RO43990858", "RO")?.full, "RO43990858");
    assert.equal(parseEuVat("123", "US"), null);
  });

  it("turn typed country names into ISO codes", () => {
    assert.equal(countryCode("România"), "RO");
    assert.equal(countryCode("ro"), "RO");
    assert.equal(countryCode("Germania"), "DE");
    assert.equal(countryCode("Atlantida"), null);
  });
});

describe("Stripe webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const now = 1_800_000_000;

  it("accepts Stripe's header and refuses a changed body, another secret or no header", () => {
    const header = signStripePayload(body, SECRET, now);
    assert.deepEqual(verifyStripeSignature(body, header, SECRET, now), { ok: true });
    assert.equal(verifyStripeSignature(`${body} `, header, SECRET, now).ok, false);
    assert.equal(verifyStripeSignature(body, header, "whsec_other", now).ok, false);
    assert.equal(verifyStripeSignature(body, undefined, SECRET, now).ok, false);
    assert.equal(verifyStripeSignature(body, "t=abc,v1=zz", SECRET, now).ok, false);
  });

  it("refuses a replay outside 5 minutes and accepts any v1 while a secret is rolled", () => {
    const header = signStripePayload(body, SECRET, now - 301);
    assert.deepEqual(verifyStripeSignature(body, header, SECRET, now), { ok: false, reason: "timestamp outside the tolerance" });
    const rolled = `${signStripePayload(body, "whsec_old", now)},${signStripePayload(body, SECRET, now).split(",")[1]}`;
    assert.deepEqual(verifyStripeSignature(body, rolled, SECRET, now), { ok: true });
  });
});

describe("Stripe requests and objects", () => {
  it("form-encode nested params like Stripe expects", () => {
    assert.equal(
      decodeURIComponent(formEncode({ mode: "subscription", line_items: [{ price: "p", quantity: 2 }], subscription_data: { trial_period_days: 14 }, skip: undefined })),
      "mode=subscription&line_items[0][price]=p&line_items[0][quantity]=2&subscription_data[trial_period_days]=14",
    );
  });

  it("read the subscription of an invoice and the period end, before and after API 2025-03", () => {
    assert.equal(subscriptionOfInvoice({ parent: { subscription_details: { subscription: "sub_new" } } }), "sub_new");
    assert.equal(subscriptionOfInvoice({ subscription: "sub_old" }), "sub_old");
    assert.equal(subscriptionOfInvoice({}), null);
    assert.equal(periodEndOf({ items: { data: [{ current_period_end: 200 }, { current_period_end: 100 }] } }), 100);
    assert.equal(periodEndOf({ current_period_end: 300, items: { data: [] } }), 300);
  });
});

describe("seats", () => {
  it("count owners, admins and members, never guests, at least one", () => {
    assert.equal(seatCount({ owner: 1, admin: 1, member: 3, guest: 9 }), 5);
    assert.equal(seatCount({ owner: 0, admin: 0, member: 0, guest: 2 }), 1);
  });

  it("change the Stripe quantity only when it differs and the subscription can change", () => {
    assert.deepEqual(seatChange({ status: "active", billedSeats: 3, desiredSeats: 4 }), { quantity: 4 });
    assert.deepEqual(seatChange({ status: "trialing", billedSeats: 3, desiredSeats: 2 }), { quantity: 2 });
    assert.equal(seatChange({ status: "active", billedSeats: 3, desiredSeats: 3 }), null);
    assert.equal(seatChange({ status: "canceled", billedSeats: 3, desiredSeats: 5 }), null);
    assert.equal(seatChange({ status: "unpaid", billedSeats: 3, desiredSeats: 5 }), null);
    assert.deepEqual(seatChange({ status: "past_due", billedSeats: 2, desiredSeats: 0 }), { quantity: 1 });
  });
});

describe("subscription state machine", () => {
  const now = Date.UTC(2026, 10, 8);

  it("never limits a self-hosted hub", () => {
    for (const status of ["canceled", "unpaid", "past_due"] as const) {
      assert.equal(accessFor({ hosted: false, status, pastDueSince: now - 30 * DAY_MS, now }).access, "full");
    }
  });

  it("gives full access when trialing, active or not subscribed yet", () => {
    assert.deepEqual(accessFor({ hosted: true, status: "trialing", pastDueSince: null, now }), { access: "full", reason: "trial", graceEndsAt: null });
    assert.equal(accessFor({ hosted: true, status: "active", pastDueSince: null, now }).access, "full");
    assert.equal(accessFor({ hosted: true, status: "none", pastDueSince: null, now }).reason, "none");
    assert.equal(accessFor({ hosted: true, status: "incomplete_expired", pastDueSince: null, now }).access, "full");
  });

  it("warns for 7 days after a failed payment, then goes read-only", () => {
    const since = now - 3 * DAY_MS;
    assert.deepEqual(accessFor({ hosted: true, status: "past_due", pastDueSince: since, now }), { access: "warn", reason: "payment_failed", graceEndsAt: since + 7 * DAY_MS });
    assert.equal(accessFor({ hosted: true, status: "past_due", pastDueSince: now - 7 * DAY_MS + 1, now }).access, "warn");
    assert.equal(accessFor({ hosted: true, status: "past_due", pastDueSince: now - 7 * DAY_MS, now }).access, "readonly");
    assert.equal(accessFor({ hosted: true, status: "past_due", pastDueSince: now - 2 * DAY_MS, now, graceDays: 1 }).access, "readonly");
    assert.equal(accessFor({ hosted: true, status: "incomplete", pastDueSince: null, now }).access, "warn");
  });

  it("is read-only when unpaid, canceled or paused", () => {
    for (const status of ["unpaid", "canceled", "paused"] as const) assert.equal(accessFor({ hosted: true, status, pastDueSince: null, now }).access, "readonly");
  });

  it("starts the grace period on the first failure, keeps it, and clears it when paid", () => {
    assert.equal(nextPastDueSince(null, "past_due", now), now);
    assert.equal(nextPastDueSince(now - DAY_MS, "past_due", now), now - DAY_MS);
    assert.equal(nextPastDueSince(now - DAY_MS, "unpaid", now), now - DAY_MS);
    assert.equal(nextPastDueSince(now - DAY_MS, "active", now), null);
  });

  it("keeps billing, leaving, removing members and the company details open while read-only", () => {
    assert.ok(allowedWhileReadOnly("POST", "/billing/portal"));
    assert.ok(allowedWhileReadOnly("PATCH", ""));
    assert.ok(allowedWhileReadOnly("DELETE", "/members/u1"));
    assert.ok(!allowedWhileReadOnly("POST", "/invites"));
    assert.ok(!allowedWhileReadOnly("PATCH", "/members/u1"));
    assert.ok(!allowedWhileReadOnly("PUT", "/settings"));
  });
});

describe("VAT", () => {
  it("charges no VAT while the seller is not registered (FORTITUDO VINCIT S.R.L. today)", () => {
    const vat = vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false });
    assert.equal(vat.kind, "not_registered");
    assert.equal(vat.rate, 0);
    assert.match(vat.note!, /neplătitor de TVA/);
  });

  it("once registered: 21% in Romania, reverse charge for EU businesses, none outside the EU", () => {
    assert.equal(RO_VAT_RATE, 21);
    assert.deepEqual(vatTreatment({ sellerVatRegistered: true, country: "RO", euVatValid: true }), { kind: "standard", rate: 21, note: null });
    assert.equal(vatTreatment({ sellerVatRegistered: true, country: "DE", euVatValid: true }).kind, "reverse_charge");
    assert.equal(vatTreatment({ sellerVatRegistered: true, country: "DE", euVatValid: false }).kind, "standard");
    assert.equal(vatTreatment({ sellerVatRegistered: true, country: "US", euVatValid: false }).kind, "outside_scope");
  });

  it("estimates the next invoice from seats and servers", () => {
    assert.deepEqual(estimateNextInvoice({ seats: 3, servers: 1, vat: vatTreatment({ sellerVatRegistered: true, country: "RO", euVatValid: false }) }), {
      subtotalEur: 96,
      vatEur: 20.16,
      totalEur: 116.16,
      vatRate: 21,
      treatment: "standard",
    });
  });
});

// ---- The invoicing seam ---------------------------------------------------------------------------

const paidInvoice = (id: string, customer: string, overrides: Record<string, unknown> = {}) => ({
  id,
  object: "invoice",
  number: "ZEN-0001",
  customer,
  currency: "eur",
  amount_paid: 7700,
  total: 7700,
  tax: 0,
  status_transitions: { paid_at: 1_796_000_000 },
  parent: { subscription_details: { subscription: "sub_1" } },
  lines: {
    data: [
      { amount: 5800, quantity: 2, description: "2 × Zen Staff", pricing: { price_details: { price: "price_seat" } }, period: { start: 1_796_000_000, end: 1_798_600_000 } },
      { amount: 900, quantity: 1, description: "Server", pricing: { price_details: { price: "price_server" } }, period: { start: 1_796_000_000, end: 1_798_600_000 } },
      { amount: 1000, quantity: 1, description: "Remaining time", pricing: { price_details: { price: "price_seat" } }, parent: { subscription_item_details: { proration: true } } },
    ],
  },
  ...overrides,
});

const details = { ...emptyDetails(), legalName: "Casa Verde SRL", taxId: "43990858", address: "Str. Lungă 1", city: "Reghin", county: "Mureș", country: "RO", billingEmail: "facturi@casaverde.test" };
const seller = { legalName: "FORTITUDO VINCIT S.R.L.", taxId: "43990858", registryNo: "J2021000522266", vatRegistered: false };
const prices = { seat: "price_seat", server: "price_server", packages: { start: "price_start", standard: null, complet: null } };

describe("fiscal invoices", () => {
  it("are built from the paid Stripe invoice with Romanian line names and add up", () => {
    const fiscal = buildFiscalInvoice({
      stripeInvoice: paidInvoice("in_1", "cus_1"),
      companyId: "c1",
      details,
      country: "RO",
      vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }),
      seller,
      prices,
    });
    assert.equal(fiscal.idempotencyKey, "in_1");
    assert.equal(fiscal.issueDate, "2026-11-30");
    assert.equal(fiscal.lines[0]!.quantity, 2);
    assert.equal(fiscal.lines[0]!.unitPriceCents, 2900);
    assert.match(fiscal.lines[0]!.name, /^Zen Staff Găzduit \(Echipă\), utilizatori \(30 nov. 2026 – /);
    assert.match(fiscal.lines[1]!.name, /^Zen Staff Server non-stop/);
    assert.match(fiscal.lines[2]!.name, /^Diferență pentru restul perioadei/);
    assert.deepEqual(fiscalProblems(fiscal), []);
    assert.equal(fiscal.vat.kind, "not_registered");
  });

  it("are held back when details are missing or the lines do not match the total", () => {
    const fiscal = buildFiscalInvoice({
      stripeInvoice: paidInvoice("in_2", "cus_1", { amount_paid: 9999 }),
      companyId: "c1",
      details: { ...details, legalName: null, taxId: null },
      country: "RO",
      vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }),
      seller,
      prices,
    });
    const problems = fiscalProblems({ ...fiscal, customer: { ...fiscal.customer, legalName: "" } });
    assert.ok(problems.includes("legal name missing"));
    assert.ok(problems.includes("CUI missing"));
    assert.ok(problems.some((problem) => problem.includes("do not add up")));
  });

  it("are only logged by the dry run", async () => {
    const lines: Array<string> = [];
    const provider = dryRunInvoicing((line) => lines.push(line));
    const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_3", "cus_1"), companyId: "c1", details, country: "RO", vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }), seller, prices });
    assert.deepEqual(await provider.issue(fiscal), { status: "dry_run", ref: null, series: null, number: null, pdfUrl: null, efacturaStatus: null });
    assert.match(lines[0]!, /dry run, fiscal invoice not issued/);
    assert.match(lines[0]!, /Casa Verde SRL/);
  });

  it("go to HoReCaOS as one idempotent call that issues and sends to e-Factura (fake fetch)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/efactura")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response(JSON.stringify({ invoice: { id: "inv_77", series: "ZEN", number: "0042", efactura: { status: "sending" } } }), { status: 201 });
    }) as unknown as typeof fetch;
    const provider = horecaosInvoicing({ baseUrl: "https://horecaos.test", apiKey: "zzk_test", seriesId: "ser_1", locationId: null }, () => undefined, fakeFetch);
    const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_4", "cus_1"), companyId: "c1", details, country: "RO", vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }), seller, prices });
    const issued = await provider.issue(fiscal);
    assert.deepEqual(issued, { status: "issued", ref: "inv_77", series: "ZEN", number: "0042", pdfUrl: null, efacturaStatus: "pending" });
    assert.equal(calls[0]!.url, "https://horecaos.test/api/v1/invoices");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["idempotency-key"], "zen-hub:in_4");
    assert.equal(headers.authorization, "Bearer zzk_test");
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.external_id, "zen-hub:in_4");
    assert.equal(sent.series_id, "ser_1");
    assert.equal(sent.currency, "EUR");
    assert.equal(sent.customer.cif, "43990858");
    assert.equal(sent.lines[0].unit_price, 29);
    assert.equal(sent.lines[0].vat_category, "O");
    assert.equal(sent.send_to_efactura, true);
    assert.equal(sent.customer.is_vat_payer, null);
    assert.equal(sent.validate_only, undefined);
    assert.deepEqual(await provider.status!({ ref: "inv_77" }), { efacturaStatus: "accepted", pdfUrl: null });
  });

  it("take HoReCaOS's 409 (same external_id) and 424 (issued, ANAF not connected) as issued", async () => {
    for (const [status, code] of [[409, "duplicate_external_id"], [424, "anaf_not_connected"]] as const) {
      const fakeFetch = (async () =>
        new Response(JSON.stringify({ error: code, invoice: { id: "inv_9", series: "ZEN", number: "0009", efactura: { status: status === 409 ? "accepted" : null } } }), { status })) as unknown as typeof fetch;
      const provider = horecaosInvoicing({ baseUrl: "https://horecaos.test", apiKey: "zzk_x", seriesId: null, locationId: null }, () => undefined, fakeFetch);
      const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_9", "cus_1"), companyId: "c1", details, country: "RO", vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }), seller, prices });
      const issued = await provider.issue(fiscal);
      assert.equal(issued.status, "issued");
      assert.equal(issued.ref, "inv_9");
      assert.equal(issued.efacturaStatus, status === 409 ? "accepted" : null);
    }
    const failing = horecaosInvoicing({ baseUrl: "https://horecaos.test", apiKey: "zzk_x", seriesId: null, locationId: null }, () => undefined, (async () =>
      new Response(JSON.stringify({ error: "vat_not_allowed", message: "no VAT" }), { status: 422 })) as unknown as typeof fetch);
    const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_10", "cus_1"), companyId: "c1", details, country: "RO", vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }), seller, prices });
    await assert.rejects(failing.issue(fiscal), /422 vat_not_allowed/);
  });

  it("validate with validate_only: true, without an Idempotency-Key (nothing is issued)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ validate_only: true, would_issue: { currency: "EUR", exchange_rate: 4.97, totals: { net: 67, vat: 0, gross: 67 } }, warnings: ["x"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = horecaosInvoicing({ baseUrl: "https://horecaos.test", apiKey: "zzk_x", seriesId: "ser_1", locationId: null }, () => undefined, fakeFetch);
    const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_11", "cus_1"), companyId: "c1", details, country: "RO", vat: vatTreatment({ sellerVatRegistered: false, country: "RO", euVatValid: false }), seller, prices });
    const result = await provider.validate!(fiscal);
    assert.deepEqual(result.warnings, ["x"]);
    assert.equal((result.preview as any).exchange_rate, 4.97);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["idempotency-key"], undefined);
    assert.equal(JSON.parse(String(calls[0]!.init.body)).validate_only, true);
  });

  it("map reverse charge to category AE and HoReCaOS e-Factura states to the hub's", () => {
    const fiscal = buildFiscalInvoice({ stripeInvoice: paidInvoice("in_5", "cus_1"), companyId: "c1", details: { ...details, country: "DE", taxId: "DE123456789" }, country: "DE", vat: vatTreatment({ sellerVatRegistered: true, country: "DE", euVatValid: true }), seller: { ...seller, vatRegistered: true }, prices });
    const body = horecaosBody(fiscal, { seriesId: null, locationId: null });
    assert.equal(body.lines[0]!.vat_category, "AE");
    assert.equal(body.customer.is_vat_payer, true);
    assert.match(body.notes, /Taxare inversă/);
    assert.equal(efacturaWord("nok"), "rejected");
    assert.equal(efacturaWord("in_prelucrare"), "in_processing");
    assert.equal(efacturaWord(null), null);
  });

  it("are a dry run when HoReCaOS is not configured, and live keys need STRIPE_LIVE=1", () => {
    assert.equal(horecaosInvoicing(billingConfigFromEnv({}).horecaos, () => undefined).dryRun, true);
    assert.equal(billingConfigFromEnv({ STRIPE_SECRET_KEY: "sk_live_x" }).stripeSecretKey, null);
    assert.equal(billingConfigFromEnv({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_LIVE: "1" }).stripeSecretKey, "sk_live_x");
    assert.equal(billingConfigFromEnv({}).seller.vatRegistered, false);
  });
});

// ---- Through the hub --------------------------------------------------------------------------------

/** A Stripe that answers like the API for the calls the hub makes, and records them. */
function fakeStripe() {
  const calls: Array<{ method: string; path: string; params: any; key: string | undefined }> = [];
  const subscription = {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "trialing",
    trial_end: 1_800_000_000,
    cancel_at_period_end: false,
    metadata: { company_id: "" },
    items: { data: [{ id: "si_seat", price: { id: "price_seat" }, quantity: 1, current_period_end: 1_800_000_000 }] },
  };
  const api: StripeApi = {
    mode: "test",
    async request(method, path, params = {}, key) {
      calls.push({ method, path, params, key });
      if (path === "/v1/customers") return { id: "cus_1" };
      if (path.startsWith("/v1/customers/")) return { id: "cus_1" };
      if (path === "/v1/checkout/sessions") return { id: `cs_${calls.length}`, url: "https://checkout.stripe.test/c/pay" };
      if (path === "/v1/billing_portal/sessions") return { url: "https://billing.stripe.test/p/session" };
      if (path === "/v1/subscriptions/sub_1") return subscription;
      if (path === "/v1/subscription_items") return { id: "si_server", quantity: (params as any).quantity };
      if (path.startsWith("/v1/subscription_items/")) return { id: path.split("/").pop(), quantity: (params as any).quantity };
      throw new Error(`fake Stripe: no answer for ${method} ${path}`);
    },
  };
  return { api, calls, subscription };
}

describe("billing through the hub", () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let client: ReturnType<typeof makeClient>;
  let owner: Person;
  let member: Person;
  let guest: Person;
  let acme = "";
  let clock = Date.UTC(2026, 10, 8, 12);
  let eventSeq = 0;
  const stripe = fakeStripe();
  const issued: Array<string> = [];
  const invoicing: InvoicingProvider = {
    name: "fake",
    dryRun: false,
    async issue(invoice) {
      issued.push(invoice.idempotencyKey);
      return { status: "issued", ref: "inv_1", series: "ZEN", number: `ZEN000${issued.length}`, pdfUrl: null, efacturaStatus: "pending" };
    },
    async pdf() {
      return Buffer.from("%PDF-1.7 fake");
    },
  };

  const send = async (type: string, object: unknown, opts: { id?: string; created?: number; secret?: string } = {}) => {
    eventSeq += 1;
    const body = JSON.stringify({ id: opts.id ?? `evt_${eventSeq}`, type, created: opts.created ?? Math.floor(clock / 1000) + eventSeq, data: { object } });
    const response = await fetch(`${hub.base}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, opts.secret ?? SECRET, Math.floor(clock / 1000)) },
      body,
    });
    return { status: response.status, json: (await response.json()) as any };
  };
  const billingOf = async (person: Person = owner) => (await client.call(person.token, "GET", `/v1/companies/${acme}/billing`)).json.billing;

  before(async () => {
    hub = await startHub({
      config: { plan: "hosted" },
      billing: {
        config: billingConfigFromEnv(PRICES_ENV),
        stripe: stripe.api,
        invoicing,
        now: () => clock,
        viesFetch: (async () => new Response(JSON.stringify({ isValid: true, name: "CASA VERDE SRL" }), { status: 200 })) as unknown as typeof fetch,
      },
    });
    client = makeClient(hub);
    owner = await client.signIn("owner@verde.test");
    member = await client.signIn("member@verde.test");
    guest = await client.signIn("guest@verde.test");
    acme = (await client.call(owner.token, "POST", "/v1/companies", { name: "Casa Verde" })).json.id;
    stripe.subscription.metadata.company_id = acme;
    await client.enableTotp(owner);
  });
  after(() => hub.close());

  it("shows the plan and asks for billing details before paying", async () => {
    const view = await billingOf();
    assert.equal(view.enabled, true);
    assert.equal(view.status, "none");
    assert.equal(view.seats, 1);
    assert.equal(view.trialDays, 14);
    assert.deepEqual(view.missing, ["legalName", "address", "city", "country", "billingEmail"]);
    const checkout = await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/checkout`, {});
    assert.equal(checkout.status, 400);
    assert.equal(checkout.json.code, "billing_details_missing");
  });

  it("validates the CUI check digit and checks EU VAT numbers in VIES", async () => {
    const wrong = await client.call(owner.token, "PUT", `/v1/companies/${acme}/billing/details`, { details: { country: "RO", taxId: "43990857" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, "invalid_cui");
    const saved = await client.call(owner.token, "PUT", `/v1/companies/${acme}/billing/details`, {
      details: { legalName: "Casa Verde SRL", taxId: "RO 43990858", address: "Str. Lungă 1", city: "Reghin", county: "Mureș", country: "România", billingEmail: "Facturi@CasaVerde.test" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.details.taxId, "RO43990858");
    assert.equal(saved.json.details.country, "RO");
    assert.equal(saved.json.vatCheck, "valid");
    assert.deepEqual(saved.json.billing.missing, []);
  });

  it("starts Checkout with one seat per paying member and a 14-day trial", async () => {
    const result = await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/checkout`, {});
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.url, "https://checkout.stripe.test/c/pay");
    const customer = stripe.calls.find((call) => call.path === "/v1/customers")!;
    assert.equal(customer.params.metadata.company_id, acme);
    assert.equal(customer.params.address.country, "RO");
    assert.ok(stripe.calls.some((call) => call.path === "/v1/customers/cus_1/tax_ids" && call.params.value === "RO43990858"));
    const session = stripe.calls.find((call) => call.path === "/v1/checkout/sessions")!;
    assert.equal(session.params.mode, "subscription");
    assert.deepEqual(session.params.line_items, [{ price: "price_seat", quantity: 1 }]);
    assert.equal(session.params.subscription_data.trial_period_days, 14);
    assert.equal(session.params.client_reference_id, acme);
    assert.ok(session.key !== undefined);
    // Members cannot pay or open the portal.
    const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role: "member" });
    assert.equal((await client.call(member.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    assert.equal((await client.call(member.token, "POST", `/v1/companies/${acme}/billing/checkout`, {})).status, 403);
    assert.equal((await billingOf(member)).invoices, undefined);
  });

  it("refuses webhooks without a valid signature", async () => {
    const forged = await send("customer.subscription.updated", { ...stripe.subscription, status: "active" }, { secret: "whsec_forged" });
    assert.equal(forged.status, 400);
    const response = await fetch(`${hub.base}/v1/billing/webhook`, { method: "POST", body: "{}" });
    assert.equal(response.status, 400);
    assert.equal((await billingOf()).status, "none");
  });

  it("links the subscription on checkout.session.completed and handles each event once", async () => {
    const event = { id: "cs_done", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_1", client_reference_id: acme, metadata: { company_id: acme } };
    const first = await send("checkout.session.completed", event, { id: "evt_checkout" });
    assert.deepEqual(first.json, { received: true });
    const before = billingStore.eventCount(hub.db);
    const again = await send("checkout.session.completed", event, { id: "evt_checkout" });
    assert.deepEqual(again.json, { received: true, duplicate: true });
    assert.equal(billingStore.eventCount(hub.db), before);
    const view = await billingOf();
    assert.equal(view.status, "trialing");
    assert.equal(view.access, "full");
    assert.ok(view.trialEnd !== null);
  });

  it("syncs seats with paying members: the member who joined adds one, guests are free, leaving removes one", async () => {
    await tick(50);
    const seatCalls = () => stripe.calls.filter((call) => call.path === "/v1/subscription_items/si_seat");
    assert.equal(seatCalls().at(-1)?.params.quantity, 2);
    assert.equal(seatCalls().at(-1)?.params.proration_behavior, "create_prorations");
    const calls = seatCalls().length;
    const invite = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role: "guest" });
    assert.equal((await client.call(guest.token, "POST", "/v1/invites/accept", { token: invite.json.link })).status, 200);
    await tick(50);
    assert.equal(seatCalls().length, calls);
    assert.equal((await client.call(owner.token, "DELETE", `/v1/companies/${acme}/members/${member.userId}`)).status, 200);
    await tick(50);
    assert.equal(seatCalls().at(-1)?.params.quantity, 1);
    assert.equal((await billingOf()).seats, 1);
  });

  it("adds the server add-on as a second subscription item", async () => {
    const result = await client.call(owner.token, "PUT", `/v1/companies/${acme}/billing/servers`, { servers: 1 });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const created = stripe.calls.find((call) => call.path === "/v1/subscription_items")!;
    assert.deepEqual({ ...created.params }, { subscription: "sub_1", price: "price_server", quantity: 1, proration_behavior: "create_prorations" });
    assert.equal((await billingOf()).estimate.subtotalEur, 29 + 9);
  });

  it("ignores an event older than the last one applied", async () => {
    const view = await billingOf();
    const stale = await send("customer.subscription.updated", { ...stripe.subscription, status: "canceled" }, { created: 1 });
    assert.equal(stale.status, 200);
    assert.equal((await billingOf()).status, view.status);
  });

  it("issues the fiscal invoice once for invoice.paid and lists it under Facturi", async () => {
    const invoice = paidInvoice("in_paid_1", "cus_1", {
      amount_paid: 3800,
      total: 3800,
      lines: { data: [{ amount: 2900, quantity: 1, pricing: { price_details: { price: "price_seat" } } }, { amount: 900, quantity: 1, pricing: { price_details: { price: "price_server" } } }] },
    });
    assert.equal((await send("invoice.paid", invoice, { id: "evt_paid" })).status, 200);
    assert.equal((await send("invoice.paid", invoice, { id: "evt_paid_again" })).status, 200);
    assert.deepEqual(issued, ["in_paid_1"]);
    const view = await billingOf();
    assert.equal(view.invoices.length, 1);
    assert.deepEqual(view.invoices[0].fiscal, { status: "issued", provider: "fake", series: "ZEN", number: "ZEN0001", pdf: true, efactura: "pending" });
    const pdf = await fetch(`${hub.base}/v1/companies/${acme}/billing/invoices/in_paid_1/pdf`, { headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    // A 0 € invoice (the trial start) is not a fiscal invoice.
    await send("invoice.paid", paidInvoice("in_zero", "cus_1", { amount_paid: 0, total: 0 }));
    assert.equal((await billingOf()).invoices.length, 1);
  });

  it("warns while a payment is past due, then makes team changes read-only after 7 days, never deleting", async () => {
    await send("customer.subscription.updated", { ...stripe.subscription, status: "past_due" });
    let view = await billingOf();
    assert.equal(view.access, "warn");
    assert.equal(view.reason, "payment_failed");
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role: "member" })).status, 200);

    clock += 8 * DAY_MS;
    view = await billingOf();
    assert.equal(view.access, "readonly");
    const blocked = await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role: "member" });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.json.code, "billing_read_only");
    // Reading, billing, the details and leaving still work; the guest is still there.
    assert.equal((await client.call(owner.token, "GET", `/v1/companies/${acme}`)).status, 200);
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/portal`)).json.url, "https://billing.stripe.test/p/session");
    assert.equal((await client.call(owner.token, "PATCH", `/v1/companies/${acme}`, { name: "Casa Verde SRL" })).status, 200);
    assert.equal((await client.call(guest.token, "DELETE", `/v1/companies/${acme}/members/${guest.userId}`)).status, 200);
    // Personal work is never blocked: the owner can still create another company.
    assert.equal((await client.call(owner.token, "POST", "/v1/companies", { name: "Personal" })).status, 200);

    await send("customer.subscription.updated", { ...stripe.subscription, status: "active" });
    view = await billingOf();
    assert.equal(view.access, "full");
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${acme}/invites`, { role: "member" })).status, 200);
  });

  it("sells the one-off packages through Checkout in payment mode with an invoice", async () => {
    const bought = await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/packages`, { package: "standard" });
    assert.equal(bought.status, 200, JSON.stringify(bought.json));
    const session = stripe.calls.filter((call) => call.path === "/v1/checkout/sessions").at(-1)!;
    assert.equal(session.params.mode, "payment");
    assert.deepEqual(session.params.line_items, [{ price: "price_standard", quantity: 1 }]);
    assert.equal(session.params.invoice_creation.enabled, true);
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/packages`, { package: "mare" })).status, 400);
    const already = await client.call(owner.token, "POST", `/v1/companies/${acme}/billing/checkout`, {});
    assert.equal(already.status, 409);
  });
});

describe("billing on a self-hosted hub", () => {
  let hub: Hub;
  after(() => hub?.close());

  it("is off and never limits anyone, whatever the stored status", async () => {
    hub = await startHub({ billing: { config: billingConfigFromEnv(PRICES_ENV), stripe: fakeStripe().api } });
    const client = makeClient(hub);
    const owner = await client.signIn("owner@self.test");
    const company = (await client.call(owner.token, "POST", "/v1/companies", { name: "Self" })).json.id;
    await client.enableTotp(owner);
    billingStore.patchAccount(hub.db, company, { status: "canceled" });
    const view = (await client.call(owner.token, "GET", `/v1/companies/${company}/billing`)).json.billing;
    assert.equal(view.enabled, false);
    assert.equal(view.access, "full");
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${company}/invites`, { role: "member" })).status, 200);
    assert.equal((await client.call(owner.token, "POST", `/v1/companies/${company}/billing/checkout`, {})).json.code, "billing_not_configured");
  });
});
