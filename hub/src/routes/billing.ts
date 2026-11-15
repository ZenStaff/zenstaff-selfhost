// Billing routes for the hosted plan (/app -> Plan). Reading the plan: full members. Paying,
// the portal, add-ons, packages and billing details: owners and admins. The Stripe webhook is a
// raw route (its signature covers the exact bytes) registered in app.ts.
import type { Kit } from "../app.ts";
import { HttpError, bad, forbidden, obj, optStr } from "../http.ts";
import * as policy from "../policy.ts";
import * as store from "../store.ts";
import * as billingStore from "../storeBilling.ts";
import * as dashboard from "../storeDashboard.ts";
import * as team from "../storeTeam.ts";
import { checkVies, countryCode, isEuCountry, parseEuVat, parseRoCui } from "../billing/taxId.ts";

/**
 * The billing details form, stricter than the company page: the country as an ISO code, a
 * Romanian CUI that passes its check digit, an EU VAT number in its country's format.
 */
export function parseBillingDetails(input: Record<string, unknown>): dashboard.CompanyDetails {
  const text = (key: string, max: number) => {
    const value = optStr(input, key, max);
    return value === null || value === "" ? null : value;
  };
  const country = countryCode(text("country", 60));
  if (country === null) throw bad("Choose the country (e.g. RO).");
  const taxRaw = text("taxId", 20);
  let taxId: string | null = null;
  if (taxRaw !== null) {
    if (country === "RO") {
      const cui = parseRoCui(taxRaw);
      if (cui === null) throw new HttpError(400, "This CUI is not valid (check digit). Example: 43990858 or RO43990858.", "invalid_cui");
      taxId = `${cui.vatPrefixed ? "RO" : ""}${cui.digits}`;
    } else if (isEuCountry(country)) {
      const vat = parseEuVat(taxRaw, country);
      if (vat === null) throw new HttpError(400, `This is not a valid VAT number for ${country}.`, "invalid_vat");
      taxId = vat.full;
    } else {
      taxId = taxRaw.replace(/\s+/g, "").toUpperCase();
    }
  }
  const emailRaw = text("billingEmail", 254);
  const billingEmail = emailRaw === null ? null : store.normalizeEmail(emailRaw);
  if (emailRaw !== null && billingEmail === null) throw bad("Enter a valid billing e-mail address.");
  return {
    legalName: text("legalName", 160),
    taxId,
    registryNo: text("registryNo", 40),
    address: text("address", 300),
    city: text("city", 80),
    county: text("county", 80),
    country,
    billingEmail,
  };
}

export function registerBillingRoutes(kit: Kit, options: { viesFetch?: typeof fetch } = {}) {
  const { db, route, requireRole, billing } = kit;

  const manager = (companyId: string, userId: string) => {
    const role = requireRole(companyId, userId);
    if (!policy.canManageCompany(role)) throw forbidden("Only owners and admins manage the plan and payments.");
    return role;
  };

  route("GET", "/v1/companies/:id/billing", ({ session, params }) => {
    const companyId = params.id!;
    const role = requireRole(companyId, session.user.id);
    if (!policy.isFullMember(role)) throw forbidden("Guests do not see the company's plan.");
    return { role, billing: billing.view(companyId, policy.canManageCompany(role)) };
  });

  route("PUT", "/v1/companies/:id/billing/details", async ({ session, params, body }) => {
    const companyId = params.id!;
    manager(companyId, session.user.id);
    const details = parseBillingDetails(obj(body, "details"));
    dashboard.setCompanyProfile(db, companyId, { details });
    // VIES for EU VAT numbers (Romanian ones too when they start with RO). Not blocking: VIES is
    // often down; Stripe checks again and the fiscal invoice uses the result we have.
    const vat = details.taxId === null || details.country === null ? null : parseEuVat(details.taxId, details.country);
    const euVat = vat !== null && (details.country !== "RO" || details.taxId!.startsWith("RO")) ? vat : null;
    const check = euVat === null ? { result: details.country !== null && isEuCountry(details.country) ? null : "not_eu", name: null } : await checkVies(euVat, options.viesFetch);
    billingStore.patchAccount(db, companyId, {
      vatCountry: details.country,
      vatId: euVat?.full ?? null,
      vatCheck: check.result,
      vatCheckedAt: check.result === null ? null : Date.now(),
    });
    team.audit(db, { companyId, actorUserId: session.user.id, action: "company.profile", detail: "Billing details updated" });
    // Keep the Stripe customer in step once there is one.
    if (billing.enabled && billingStore.accountOf(db, companyId).stripeCustomerId !== null) {
      await billing.ensureCustomer(companyId).catch((error) => kit.log(`[billing] customer update for ${companyId}: ${String(error)}`));
    }
    return { details, vatCheck: check.result, viesName: check.name, billing: billing.view(companyId, true) };
  });

  route("POST", "/v1/companies/:id/billing/checkout", async ({ session, params, body }) => {
    const companyId = params.id!;
    manager(companyId, session.user.id);
    const servers = body.servers === undefined ? 0 : Number(body.servers);
    if (!Number.isInteger(servers) || servers < 0 || servers > 20) throw bad("servers must be a whole number from 0 to 20.");
    const result = await billing.startCheckout(companyId, { servers });
    team.audit(db, { companyId, actorUserId: session.user.id, action: "billing.checkout", detail: `Started paying for the hosted plan (${result.seats} seats)` });
    return result;
  });

  route("POST", "/v1/companies/:id/billing/portal", async ({ session, params }) => {
    const companyId = params.id!;
    manager(companyId, session.user.id);
    return billing.portal(companyId);
  });

  route("PUT", "/v1/companies/:id/billing/servers", async ({ session, params, body }) => {
    const companyId = params.id!;
    manager(companyId, session.user.id);
    const servers = Number(body.servers);
    if (!Number.isInteger(servers) || servers < 0 || servers > 20) throw bad("servers must be a whole number from 0 to 20.");
    return billing.setServers(companyId, servers);
  });

  route("POST", "/v1/companies/:id/billing/packages", async ({ session, params, body }) => {
    const companyId = params.id!;
    manager(companyId, session.user.id);
    const packageId = optStr(body, "package", 20);
    if (packageId === null) throw bad("package is required.");
    return billing.buyPackage(companyId, session.user.id, packageId);
  });

  kit.raw("GET", "/v1/companies/:id/billing/invoices/:invoiceId/pdf", async ({ session, params, res }) => {
    const companyId = params.id!;
    manager(companyId, session!.user.id);
    const pdf = await billing.invoicePdf(companyId, params.invoiceId!);
    if ("redirect" in pdf) {
      res.writeHead(302, { location: pdf.redirect, "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${pdf.name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(pdf.file);
  });

  kit.raw(
    "POST",
    "/v1/billing/webhook",
    async ({ req, res, rawBody }) => {
      const header = req.headers["stripe-signature"];
      const result = await billing.handleWebhook(rawBody, Array.isArray(header) ? header[0] : header);
      res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(result.body));
    },
    "public",
  );
}
