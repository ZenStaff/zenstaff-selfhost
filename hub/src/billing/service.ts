// Payments for the hosted plan: Checkout for the subscription and the one-off packages, the
// Customer Portal, seats kept equal to the paying members, the server add-on, the verified and
// idempotent webhook that keeps the hub's copy of the subscription, the soft enforcement, and the
// fiscal invoice issued for every paid invoice. Stripe is the source of truth for money; the hub
// keeps what it needs to show the Plan page and to decide what a company may change.
import { createHash } from "node:crypto";

import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import * as store from "../store.ts";
import * as billingStore from "../storeBilling.ts";
import { type CompanyDetails, companyDetails } from "../storeDashboard.ts";
import * as team from "../storeTeam.ts";
import type { BillingConfig } from "./config.ts";
import { buildFiscalInvoice, fiscalProblems, type InvoicingProvider } from "./invoicing.ts";
import {
  type AccessState,
  accessFor,
  allowedWhileReadOnly,
  asStatus,
  estimateNextInvoice,
  isLive,
  nextPastDueSince,
  PACKAGES,
  packageOf,
  PRICES,
  seatChange,
  seatCount,
  vatTreatment,
} from "./plan.ts";
import { idOf, periodEndOf, type StripeApi, subscriptionOfInvoice, verifyStripeSignature } from "./stripe.ts";
import { countryCode, isEuCountry, parseEuVat } from "./taxId.ts";

export interface BillingDeps {
  readonly db: Db;
  readonly config: BillingConfig;
  /** Our hosted hub (HUB_PLAN=hosted). Self-hosted hubs never charge and never limit anyone. */
  readonly hosted: boolean;
  readonly publicUrl: string;
  readonly stripe: StripeApi | null;
  readonly invoicing: InvoicingProvider;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export type Billing = ReturnType<typeof makeBilling>;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Fields a company must fill in before paying (they go on the fiscal invoice). */
export function missingDetails(details: CompanyDetails): Array<string> {
  const country = countryCode(details.country);
  const missing: Array<string> = [];
  if (details.legalName === null) missing.push("legalName");
  if (details.address === null) missing.push("address");
  if (details.city === null) missing.push("city");
  if (country === null) missing.push("country");
  if (details.billingEmail === null) missing.push("billingEmail");
  if (country === "RO" && details.taxId === null) missing.push("taxId");
  return missing;
}

export function makeBilling(deps: BillingDeps) {
  const { db, config, stripe, log } = deps;
  const now = deps.now ?? Date.now;
  const enabled = deps.hosted && stripe !== null && config.prices.seat !== null;
  const prices = { seat: config.prices.seat, server: config.prices.server, packages: { ...config.prices.packages } };

  const requireStripe = (): StripeApi => {
    if (!enabled || stripe === null) throw new HttpError(503, "Payments are not switched on for this hub yet.", "billing_not_configured");
    return stripe;
  };

  const byRole = (companyId: string) => {
    const counts = { owner: 0, admin: 0, member: 0, guest: 0 };
    for (const member of store.membersOf(db, companyId)) counts[member.role] += 1;
    return counts;
  };

  const accessOf = (account: billingStore.BillingAccount): AccessState =>
    accessFor({ hosted: deps.hosted, status: account.status, pastDueSince: account.pastDueSince, now: now(), graceDays: config.graceDays });

  const treatmentOf = (companyId: string) => {
    const details = companyDetails(db, companyId);
    const account = billingStore.accountOf(db, companyId);
    const country = countryCode(details.country) ?? "RO";
    const euVatValid = country !== "RO" && isEuCountry(country) && account.vatId !== null && account.vatCheck !== "invalid";
    return { details, country, vat: vatTreatment({ sellerVatRegistered: config.seller.vatRegistered, country, euVatValid }) };
  };

  // ---- Seats ----------------------------------------------------------------------------------

  const seatQueue = new Map<string, Promise<void>>();

  /** Sets the seat quantity on Stripe to the paying members; one change at a time per company. */
  const syncSeats = (companyId: string): Promise<void> => {
    const previous = seatQueue.get(companyId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!enabled || stripe === null) return;
        const account = billingStore.accountOf(db, companyId);
        if (account.seatItemId === null) return;
        const change = seatChange({ status: account.status, billedSeats: account.seats, desiredSeats: seatCount(byRole(companyId)) });
        if (change === null) return;
        await stripe.request(
          "POST",
          `/v1/subscription_items/${encodeURIComponent(account.seatItemId)}`,
          { quantity: change.quantity, proration_behavior: "create_prorations" },
          `seats:${account.seatItemId}:${account.seats}->${change.quantity}`,
        );
        billingStore.patchAccount(db, companyId, { seats: change.quantity });
        team.audit(db, { companyId, actorUserId: null, action: "billing.seats", detail: `Seats on the hosted plan: ${account.seats} -> ${change.quantity}` });
      });
    seatQueue.set(companyId, next);
    void next.finally(() => {
      if (seatQueue.get(companyId) === next) seatQueue.delete(companyId);
    });
    return next;
  };

  /** Called after an invitation is accepted, a role changes or a member leaves. Never blocks the request. */
  const membersChanged = (companyId: string) => {
    if (!enabled) return;
    syncSeats(companyId).catch((error) => log(`[billing] seat sync for ${companyId} failed, the hourly reconcile retries: ${String(error)}`));
  };

  // ---- Fiscal invoices ------------------------------------------------------------------------

  const issueFiscal = async (stripeInvoiceId: string, stripeInvoice?: any) => {
    const stored = billingStore.getInvoice(db, stripeInvoiceId);
    if (stored === null || stored.fiscalStatus === "issued" || stored.fiscalStatus === "dry_run") return;
    try {
      const invoice = stripeInvoice ?? (stripe === null ? null : await stripe.request("GET", `/v1/invoices/${encodeURIComponent(stripeInvoiceId)}`));
      if (invoice === null) throw new Error("the Stripe invoice is not available");
      const { details, country, vat } = treatmentOf(stored.companyId);
      const fiscal = buildFiscalInvoice({ stripeInvoice: invoice, companyId: stored.companyId, details, country, vat, seller: config.seller, prices });
      const problems = fiscalProblems(fiscal);
      if (problems.length > 0) throw new Error(`not issued: ${problems.join("; ")}`);
      const issued = await deps.invoicing.issue(fiscal);
      billingStore.setFiscal(db, stripeInvoiceId, {
        provider: deps.invoicing.name,
        status: issued.status,
        ref: issued.ref,
        series: issued.series,
        number: issued.number,
        pdfUrl: issued.pdfUrl,
        efacturaStatus: issued.efacturaStatus,
        error: null,
      });
      if (issued.status === "issued") {
        team.audit(db, { companyId: stored.companyId, actorUserId: null, action: "billing.invoice", detail: `Invoice ${issued.series ?? ""}${issued.number ?? ""} issued (${deps.invoicing.name})` });
      }
    } catch (error) {
      billingStore.setFiscal(db, stripeInvoiceId, { provider: deps.invoicing.name, status: "failed", error: String(error instanceof Error ? error.message : error) });
      log(`[billing] fiscal invoice for ${stripeInvoiceId} failed: ${String(error)}`);
    }
  };

  // ---- Webhook --------------------------------------------------------------------------------

  const companyExists = (companyId: unknown): companyId is string => typeof companyId === "string" && store.getCompany(db, companyId) !== null;

  /** The company a Stripe object belongs to: our records first, then the metadata we set. */
  const companyFor = (object: any): string | null => {
    const subscriptionId = object?.object === "subscription" ? idOf(object.id) : (idOf(object?.subscription) ?? subscriptionOfInvoice(object));
    if (subscriptionId !== null) {
      const account = billingStore.accountBySubscription(db, subscriptionId);
      if (account !== null) return account.companyId;
    }
    const customerId = idOf(object?.customer);
    if (customerId !== null) {
      const account = billingStore.accountByCustomer(db, customerId);
      if (account !== null) return account.companyId;
    }
    const candidate = object?.metadata?.company_id ?? object?.client_reference_id ?? object?.subscription_details?.metadata?.company_id;
    return companyExists(candidate) ? candidate : null;
  };

  /** Copies a subscription into the hub; events older than the last one applied are ignored. */
  const applySubscription = (companyId: string, subscription: any, eventCreated: number) => {
    const account = billingStore.accountOf(db, companyId);
    if (account.stripeSubscriptionId !== null && account.stripeSubscriptionId !== subscription.id && isLive(account.status)) {
      log(`[billing] company ${companyId} already has subscription ${account.stripeSubscriptionId}; ignoring ${subscription.id} (cancel one in Stripe)`);
      return;
    }
    if (account.stripeSubscriptionId === subscription.id && account.lastEventAt !== null && eventCreated < account.lastEventAt) return;
    const items: Array<any> = subscription?.items?.data ?? [];
    const priceOf = (item: any) => idOf(item?.price) ?? idOf(item?.plan);
    const seatItem = items.find((item) => priceOf(item) === prices.seat) ?? items.find((item) => priceOf(item) !== prices.server) ?? null;
    const serverItem = items.find((item) => prices.server !== null && priceOf(item) === prices.server) ?? null;
    const status = asStatus(subscription.status);
    billingStore.patchAccount(db, companyId, {
      plan: "hosted",
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: idOf(subscription.customer) ?? account.stripeCustomerId,
      status,
      seats: Number(seatItem?.quantity ?? 0),
      servers: Number(serverItem?.quantity ?? 0),
      seatItemId: idOf(seatItem?.id) ?? null,
      serverItemId: idOf(serverItem?.id) ?? null,
      trialEnd: typeof subscription.trial_end === "number" ? subscription.trial_end : account.trialEnd,
      currentPeriodEnd: periodEndOf(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true || typeof subscription.cancel_at === "number",
      pastDueSince: nextPastDueSince(account.pastDueSince, status, now()),
      lastEventAt: eventCreated,
    });
    if (status !== account.status) {
      team.audit(db, { companyId, actorUserId: null, action: "billing.status", detail: `Hosted plan: ${account.status} -> ${status}` });
    }
  };

  const handleEvent = async (event: any): Promise<string | null> => {
    const object = event?.data?.object ?? {};
    const created = Number(event.created ?? 0);
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const companyId = companyFor(object);
        if (companyId === null) return null;
        const customerId = idOf(object.customer);
        if (customerId !== null && billingStore.accountOf(db, companyId).stripeCustomerId === null) {
          billingStore.patchAccount(db, companyId, { stripeCustomerId: customerId });
        }
        if (object.mode === "subscription") {
          const subscriptionId = idOf(object.subscription);
          if (subscriptionId === null) return companyId;
          const subscription =
            typeof object.subscription === "object" && object.subscription !== null
              ? object.subscription
              : await requireStripe().request("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
          applySubscription(companyId, subscription, created);
          // Members may have joined while the customer was on the Checkout page.
          membersChanged(companyId);
        } else if (object.mode === "payment" && (object.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded")) {
          billingStore.markOrder(db, object.id, "paid");
          team.audit(db, { companyId, actorUserId: null, action: "billing.package", detail: `Package "${object.metadata?.package ?? "?"}" paid` });
        }
        return companyId;
      }
      case "checkout.session.expired": {
        billingStore.markOrder(db, object.id, "expired");
        return companyFor(object);
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      case "customer.subscription.trial_will_end": {
        const companyId = companyFor(object);
        if (companyId === null) return null;
        applySubscription(companyId, object, created);
        return companyId;
      }
      case "invoice.paid": {
        const companyId = companyFor(object);
        if (companyId === null) return null;
        const amount = Number(object.amount_paid ?? 0);
        // Trial start and fully credited invoices are 0 €: nothing to invoice fiscally.
        if (amount <= 0) return companyId;
        const subscriptionId = subscriptionOfInvoice(object);
        const line = object?.lines?.data?.[0];
        billingStore.recordInvoice(db, {
          stripeInvoiceId: object.id,
          companyId,
          kind: subscriptionId === null ? "package" : "subscription",
          amountCents: amount,
          taxCents: Number(object.tax ?? (object.total_taxes ?? []).reduce((sum: number, tax: any) => sum + Number(tax?.amount ?? 0), 0)),
          currency: String(object.currency ?? "eur"),
          periodStart: typeof line?.period?.start === "number" ? line.period.start : null,
          periodEnd: typeof line?.period?.end === "number" ? line.period.end : null,
          paidAt: Number(object.status_transitions?.paid_at ?? created),
          stripePdfUrl: typeof object.invoice_pdf === "string" ? object.invoice_pdf : null,
        });
        await issueFiscal(object.id, object);
        return companyId;
      }
      case "invoice.payment_failed": {
        const companyId = companyFor(object);
        if (companyId === null) return null;
        // The subscription event sets past_due; this starts the grace period even if it comes first.
        const account = billingStore.accountOf(db, companyId);
        if (account.pastDueSince === null && isLive(account.status)) billingStore.patchAccount(db, companyId, { pastDueSince: now() });
        team.audit(db, { companyId, actorUserId: null, action: "billing.payment_failed", detail: "A payment for the hosted plan failed" });
        return companyId;
      }
      case "customer.tax_id.updated":
      case "customer.tax_id.created": {
        const companyId = companyFor(object);
        if (companyId === null) return null;
        const status = object?.verification?.status;
        if (status === "verified") billingStore.patchAccount(db, companyId, { vatCheck: "valid", vatCheckedAt: now() });
        else if (status === "unverified") billingStore.patchAccount(db, companyId, { vatCheck: "invalid", vatCheckedAt: now() });
        return companyId;
      }
      default:
        return null;
    }
  };

  /** The webhook: signature first, then the event store (each event handled once), then the change. */
  const handleWebhook = async (rawBody: string, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (config.stripeWebhookSecret === null) return { status: 503, body: { error: "Webhook secret not configured." } };
    const verified = verifyStripeSignature(rawBody, signature, config.stripeWebhookSecret, Math.floor(now() / 1000));
    if (!verified.ok) return { status: 400, body: { error: `Invalid signature: ${verified.reason}.` } };
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "Invalid JSON." } };
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") return { status: 400, body: { error: "Not a Stripe event." } };
    const claim = billingStore.claimEvent(db, { id: event.id, type: event.type, created: Number(event.created ?? 0) });
    if (claim === "done") return { status: 200, body: { received: true, duplicate: true } };
    try {
      const companyId = await handleEvent(event);
      billingStore.finishEvent(db, event.id, { companyId });
      return { status: 200, body: { received: true } };
    } catch (error) {
      billingStore.finishEvent(db, event.id, { companyId: null, error: String(error) });
      log(`[billing] event ${event.id} (${event.type}) failed, Stripe will retry: ${String(error)}`);
      return { status: 500, body: { error: "Not processed; retry." } };
    }
  };

  // ---- Customer, Checkout, Portal ----------------------------------------------------------

  const ensureCustomer = async (companyId: string): Promise<string> => {
    const api = requireStripe();
    const account = billingStore.accountOf(db, companyId);
    const details = companyDetails(db, companyId);
    const missing = missingDetails(details);
    if (missing.length > 0) throw new HttpError(400, `Fill in the billing details first: ${missing.join(", ")}.`, "billing_details_missing");
    const country = countryCode(details.country)!;
    const params = {
      name: details.legalName,
      email: details.billingEmail,
      address: { line1: details.address, city: details.city, state: details.county, country },
      preferred_locales: ["ro", "en"],
      metadata: { company_id: companyId },
      invoice_settings: { custom_fields: details.taxId === null ? "" : [{ name: country === "RO" ? "CUI" : "VAT", value: details.taxId.slice(0, 30) }] },
    };
    if (account.stripeCustomerId !== null) {
      await api.request("POST", `/v1/customers/${encodeURIComponent(account.stripeCustomerId)}`, params, `cus-update:${account.stripeCustomerId}:${sha(params)}`);
      return account.stripeCustomerId;
    }
    const customer = await api.request("POST", "/v1/customers", params, `cus:${companyId}:${sha(params)}`);
    billingStore.patchAccount(db, companyId, { stripeCustomerId: customer.id });
    // An EU VAT number lets Stripe Tax apply reverse charge (and Stripe checks it against VIES).
    const vat = details.taxId === null ? null : parseEuVat(details.taxId, country);
    if (vat !== null && (country !== "RO" || /^RO/i.test(details.taxId ?? ""))) {
      await api.request("POST", `/v1/customers/${encodeURIComponent(customer.id)}/tax_ids`, { type: "eu_vat", value: vat.full }, `taxid:${customer.id}:${vat.full}`).catch((error) => {
        log(`[billing] could not add the VAT number to ${customer.id}: ${String(error)}`);
      });
    }
    return customer.id;
  };

  const urls = (query: string) => ({
    success_url: `${deps.publicUrl}/app/plan?plata=${query}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.publicUrl}/app/plan?plata=anulat`,
  });

  const startCheckout = async (companyId: string, input: { servers: number }) => {
    const api = requireStripe();
    const account = billingStore.accountOf(db, companyId);
    if (isLive(account.status)) throw new HttpError(409, "The company already has the hosted plan. Manage it from the billing portal.", "already_subscribed");
    if (input.servers > 0 && prices.server === null) throw new HttpError(503, "The server add-on is not configured.", "billing_not_configured");
    const customer = await ensureCustomer(companyId);
    const seats = seatCount(byRole(companyId));
    // One trial per company: a company that already had one pays from the first day.
    const trial = account.trialEnd === null && config.trialDays > 0 ? { trial_period_days: config.trialDays } : {};
    const params = {
      mode: "subscription",
      customer,
      client_reference_id: companyId,
      line_items: [{ price: prices.seat, quantity: seats }, ...(input.servers > 0 ? [{ price: prices.server, quantity: input.servers }] : [])],
      subscription_data: { ...trial, metadata: { company_id: companyId } },
      metadata: { company_id: companyId },
      locale: "ro",
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: config.stripeTax },
      payment_method_collection: "always",
      ...urls("ok"),
    };
    const session = await api.request("POST", "/v1/checkout/sessions", params, `checkout:${companyId}:${sha(params)}:${Math.floor(now() / 60_000)}`);
    return { url: String(session.url), trialDays: "trial_period_days" in trial ? config.trialDays : 0, seats };
  };

  const buyPackage = async (companyId: string, userId: string, packageId: string) => {
    const api = requireStripe();
    const item = packageOf(packageId);
    if (item === null) throw new HttpError(400, "package must be start, standard or complet.");
    const price = prices.packages[item.id];
    if (price === null) throw new HttpError(503, "This package is not configured.", "billing_not_configured");
    const customer = await ensureCustomer(companyId);
    const orderId = billingStore.createOrder(db, { companyId, packageId: item.id, amountEur: item.priceEur, createdBy: userId });
    const session = await api.request(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "payment",
        customer,
        client_reference_id: companyId,
        line_items: [{ price, quantity: 1 }],
        invoice_creation: { enabled: true, invoice_data: { metadata: { company_id: companyId, package: item.id, order_id: orderId } } },
        metadata: { company_id: companyId, package: item.id, order_id: orderId },
        locale: "ro",
        billing_address_collection: "required",
        customer_update: { address: "auto", name: "auto" },
        tax_id_collection: { enabled: true },
        automatic_tax: { enabled: config.stripeTax },
        ...urls("pachet"),
      },
      `package:${orderId}`,
    );
    billingStore.setOrderSession(db, orderId, String(session.id));
    return { url: String(session.url) };
  };

  const portal = async (companyId: string) => {
    const api = requireStripe();
    const account = billingStore.accountOf(db, companyId);
    if (account.stripeCustomerId === null) throw new HttpError(409, "There is nothing to manage yet: upgrade first.", "no_customer");
    const session = await api.request("POST", "/v1/billing_portal/sessions", {
      customer: account.stripeCustomerId,
      return_url: `${deps.publicUrl}/app/plan`,
      locale: "ro",
    });
    return { url: String(session.url) };
  };

  const setServers = async (companyId: string, servers: number) => {
    const api = requireStripe();
    if (prices.server === null) throw new HttpError(503, "The server add-on is not configured.", "billing_not_configured");
    const account = billingStore.accountOf(db, companyId);
    if (account.stripeSubscriptionId === null || !["trialing", "active"].includes(account.status)) {
      throw new HttpError(409, "Add servers once the hosted plan is active.", "no_subscription");
    }
    if (servers === account.servers) return { servers };
    if (account.serverItemId !== null && servers === 0) {
      await api.request("DELETE", `/v1/subscription_items/${encodeURIComponent(account.serverItemId)}`, { proration_behavior: "create_prorations" });
      billingStore.patchAccount(db, companyId, { servers: 0, serverItemId: null });
    } else if (account.serverItemId !== null) {
      await api.request("POST", `/v1/subscription_items/${encodeURIComponent(account.serverItemId)}`, { quantity: servers, proration_behavior: "create_prorations" }, `servers:${account.serverItemId}:${account.servers}->${servers}`);
      billingStore.patchAccount(db, companyId, { servers });
    } else {
      const item = await api.request(
        "POST",
        "/v1/subscription_items",
        { subscription: account.stripeSubscriptionId, price: prices.server, quantity: servers, proration_behavior: "create_prorations" },
        `servers:${account.stripeSubscriptionId}:new:${servers}`,
      );
      billingStore.patchAccount(db, companyId, { servers, serverItemId: String(item.id) });
    }
    team.audit(db, { companyId, actorUserId: null, action: "billing.servers", detail: `Server non-stop: ${account.servers} -> ${servers}` });
    return { servers };
  };

  // ---- Reading ------------------------------------------------------------------------------

  /** Everything the Plan page shows. `manager`: invoices and billing details too. */
  const view = (companyId: string, manager: boolean) => {
    const account = billingStore.accountOf(db, companyId);
    const roles = byRole(companyId);
    const access = accessOf(account);
    const { details, country, vat } = treatmentOf(companyId);
    const live = isLive(account.status);
    const seats = live ? account.seats : seatCount(roles);
    return {
      hosted: deps.hosted,
      enabled,
      mode: stripe?.mode ?? null,
      status: deps.hosted ? account.status : "none",
      access: access.access,
      reason: access.reason,
      graceEndsAt: access.graceEndsAt === null ? null : new Date(access.graceEndsAt).toISOString(),
      seats,
      payingMembers: seatCount(roles),
      guests: roles.guest,
      servers: account.servers,
      trialDays: config.trialDays,
      trialAvailable: account.trialEnd === null,
      trialEnd: account.trialEnd === null ? null : new Date(account.trialEnd * 1000).toISOString(),
      renewsAt: account.currentPeriodEnd === null ? null : new Date(account.currentPeriodEnd * 1000).toISOString(),
      cancelAtPeriodEnd: account.cancelAtPeriodEnd,
      prices: { seatEur: PRICES.seatEur, serverEur: PRICES.serverEur, serverAvailable: prices.server !== null },
      estimate: estimateNextInvoice({ seats, servers: account.servers, vat }),
      vat: { kind: vat.kind, rate: vat.rate, note: vat.note, country },
      packages: PACKAGES.map((item) => ({ ...item, available: enabled && prices.packages[item.id] !== null })),
      ...(manager
        ? {
            details,
            missing: missingDetails(details),
            vatCheck: account.vatCheck,
            hasCustomer: account.stripeCustomerId !== null,
            invoices: billingStore.invoicesOf(db, companyId).map((invoice) => ({
              id: invoice.stripeInvoiceId,
              kind: invoice.kind,
              amountEur: invoice.amountCents / 100,
              taxEur: invoice.taxCents / 100,
              currency: invoice.currency,
              paidAt: new Date(invoice.paidAt * 1000).toISOString(),
              periodStart: invoice.periodStart === null ? null : new Date(invoice.periodStart * 1000).toISOString(),
              periodEnd: invoice.periodEnd === null ? null : new Date(invoice.periodEnd * 1000).toISOString(),
              fiscal: {
                status: invoice.fiscalStatus,
                provider: invoice.fiscalProvider,
                series: invoice.fiscalSeries,
                number: invoice.fiscalNumber,
                pdf: invoice.fiscalPdfUrl !== null || (invoice.fiscalRef !== null && deps.invoicing.pdf !== undefined),
                efactura: invoice.efacturaStatus,
              },
              stripePdfUrl: invoice.stripePdfUrl,
            })),
            orders: billingStore.ordersOf(db, companyId),
          }
        : {}),
    };
  };

  /** The fiscal invoice PDF: the provider's link, or the file fetched with the provider's key. */
  const invoicePdf = async (companyId: string, stripeInvoiceId: string): Promise<{ redirect: string } | { file: Buffer; name: string }> => {
    const invoice = billingStore.getInvoice(db, stripeInvoiceId);
    if (invoice === null || invoice.companyId !== companyId) throw new HttpError(404, "No such invoice.");
    if (invoice.fiscalPdfUrl !== null) return { redirect: invoice.fiscalPdfUrl };
    if (invoice.fiscalRef === null || deps.invoicing.pdf === undefined) throw new HttpError(404, "The fiscal invoice has no PDF yet.");
    const name = `factura-${invoice.fiscalSeries ?? ""}${invoice.fiscalNumber ?? invoice.stripeInvoiceId}.pdf`.replace(/[^A-Za-z0-9._-]/g, "");
    return { file: await deps.invoicing.pdf(invoice.fiscalRef), name };
  };

  // ---- Enforcement --------------------------------------------------------------------------

  /** Throws 402 for a team change on a company whose hosted plan is read-only. */
  const gate = (method: string, pathname: string) => {
    if (!deps.hosted || method === "GET" || method === "HEAD") return;
    const match = /^\/v1\/companies\/([^/]+)(\/.*)?$/.exec(pathname);
    if (match === null) return;
    const rest = match[2] ?? "";
    if (allowedWhileReadOnly(method, rest)) return;
    const companyId = decodeURIComponent(match[1]!);
    const access = accessOf(billingStore.accountOf(db, companyId));
    if (access.access !== "readonly") return;
    throw new HttpError(
      402,
      "The company's hosted plan is not paid, so team features are read-only. Nothing was deleted; an owner or admin can pay from Plan.",
      "billing_read_only",
    );
  };

  // ---- Periodic work ------------------------------------------------------------------------

  /** Seats that drifted (a missed sync), fiscal invoices to retry, e-Factura answers to collect. */
  const tick = async () => {
    if (enabled) {
      for (const account of billingStore.liveAccounts(db)) await syncSeats(account.companyId).catch((error) => log(`[billing] reconcile ${account.companyId}: ${String(error)}`));
    }
    for (const invoice of billingStore.invoicesToIssue(db)) {
      if (invoice.fiscalStatus === "failed" && invoice.attempts > 0) {
        // Back off: retry a failed invoice after 2^attempts minutes.
        const waitMs = 2 ** invoice.attempts * 60_000;
        const row = db.prepare("SELECT updated_at FROM billing_invoices WHERE stripe_invoice_id = ?").get(invoice.stripeInvoiceId) as { updated_at: string };
        if (now() - Date.parse(row.updated_at) < waitMs) continue;
      }
      await issueFiscal(invoice.stripeInvoiceId);
    }
    if (deps.invoicing.status !== undefined) {
      for (const invoice of billingStore.invoicesAwaitingEfactura(db)) {
        try {
          const state = await deps.invoicing.status({ ref: invoice.fiscalRef });
          billingStore.setFiscal(db, invoice.stripeInvoiceId, { provider: deps.invoicing.name, status: "issued", efacturaStatus: state.efacturaStatus, pdfUrl: state.pdfUrl, countAttempt: false });
        } catch (error) {
          log(`[billing] e-Factura status of ${invoice.stripeInvoiceId}: ${String(error)}`);
        }
      }
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const start = (everyMs = 60 * 60_000) => {
    if (timer !== null) return;
    timer = setInterval(() => void tick().catch((error) => log(`[billing] tick failed: ${String(error)}`)), everyMs);
    timer.unref();
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  return {
    enabled,
    view,
    access: (companyId: string) => accessOf(billingStore.accountOf(db, companyId)),
    statusOf: (companyId: string) => (deps.hosted ? billingStore.accountOf(db, companyId).status : "none"),
    gate,
    startCheckout,
    buyPackage,
    portal,
    setServers,
    ensureCustomer,
    handleWebhook,
    syncSeats,
    membersChanged,
    issueFiscal,
    invoicePdf,
    tick,
    start,
    stop,
  };
}
