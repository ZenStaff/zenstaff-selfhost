// The Romanian fiscal invoice behind every paid Stripe invoice. A Stripe invoice is a receipt, not
// a Romanian invoice: B2B invoices must be issued by the seller's invoicing system and reported to
// RO e-Factura (SPV). On `invoice.paid` the hub builds a provider-neutral FiscalInvoice and hands
// it to an InvoicingProvider. The default provider is HoReCaOS (a business OS that
// issues invoices and sends them to e-Factura); the issuer is the operator's tenant there.
// Without credentials it is a dry run that only logs the invoice it would have issued.
import type { CompanyDetails } from "../storeDashboard.ts";
import type { VatTreatment } from "./plan.ts";

/** The seller, printed on the invoice (FORTITUDO VINCIT S.R.L. by default; the provider's tenant decides in the end). */
export interface Seller {
  readonly legalName: string;
  readonly taxId: string;
  readonly registryNo: string;
  readonly vatRegistered: boolean;
}

export interface FiscalLine {
  readonly name: string;
  readonly quantity: number;
  /** Euro cents, without VAT. May be negative (a proration credit for a removed seat). */
  readonly unitPriceCents: number;
  readonly totalCents: number;
  readonly unit: string;
  readonly vatRate: number;
}

export interface FiscalInvoice {
  /** The Stripe invoice id: the provider must issue at most one fiscal invoice per key. */
  readonly idempotencyKey: string;
  readonly issueDate: string;
  readonly currency: "EUR";
  readonly seller: Seller;
  readonly customer: {
    readonly legalName: string;
    readonly taxId: string | null;
    readonly registryNo: string | null;
    readonly address: string | null;
    readonly city: string | null;
    readonly county: string | null;
    readonly country: string;
    readonly email: string | null;
  };
  readonly lines: ReadonlyArray<FiscalLine>;
  readonly vat: { readonly kind: VatTreatment["kind"]; readonly rate: number; readonly note: string | null };
  readonly totalCents: number;
  readonly taxCents: number;
  /** Already paid by card / SEPA through Stripe: the invoice is issued as collected. */
  readonly payment: { readonly method: "card_or_sepa"; readonly reference: string; readonly paidAt: string };
  readonly reference: { readonly stripeInvoiceNumber: string | null; readonly companyId: string };
}

export interface IssuedInvoice {
  readonly status: "issued" | "dry_run";
  /** The provider's own id of the invoice (to ask for its e-Factura state and PDF). */
  readonly ref: string | null;
  readonly series: string | null;
  readonly number: string | null;
  readonly pdfUrl: string | null;
  /** e-Factura (SPV) state as the provider reports it: pending | uploaded | in_processing | accepted | rejected. */
  readonly efacturaStatus: string | null;
}

export interface InvoicingProvider {
  readonly name: string;
  readonly dryRun: boolean;
  issue(invoice: FiscalInvoice): Promise<IssuedInvoice>;
  /** The e-Factura state and PDF of an issued invoice, asked again until it is final. */
  status?(issued: { ref: string | null }): Promise<Pick<IssuedInvoice, "efacturaStatus" | "pdfUrl">>;
  /** The invoice PDF, when the provider's link needs credentials the browser does not have. */
  pdf?(ref: string): Promise<Buffer>;
  /** Checks an invoice against the provider without issuing anything (no number used, nothing sent). */
  validate?(invoice: FiscalInvoice): Promise<{ ok: true; preview: unknown; warnings: ReadonlyArray<string> }>;
}

// ---- Building the invoice ---------------------------------------------------------------------

const MONTHS = ["ian.", "feb.", "mar.", "apr.", "mai", "iun.", "iul.", "aug.", "sept.", "oct.", "nov.", "dec."];
const periodText = (start: number | null | undefined, end: number | null | undefined) => {
  if (typeof start !== "number" || typeof end !== "number") return "";
  const day = (seconds: number) => {
    const date = new Date(seconds * 1000);
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  };
  return ` (${day(start)} – ${day(end)})`;
};

/** Romanian line names for the prices the hub knows; anything else keeps Stripe's description. */
export function lineName(line: any, prices: { seat: string | null; server: string | null; packages: Record<string, string | null> }): string {
  const priceId: string | null = line?.pricing?.price_details?.price ?? line?.price?.id ?? line?.plan?.id ?? null;
  const proration = line?.parent?.subscription_item_details?.proration === true || line?.proration === true;
  const period = periodText(line?.period?.start, line?.period?.end);
  const prefix = proration ? (Number(line?.amount) < 0 ? "Credit pentru timpul nefolosit: " : "Diferență pentru restul perioadei: ") : "";
  if (priceId !== null && priceId === prices.seat) return `${prefix}Zen Staff Găzduit (Echipă), utilizatori${period}`;
  if (priceId !== null && priceId === prices.server) return `${prefix}Zen Staff Server non-stop${period}`;
  for (const [id, price] of Object.entries(prices.packages)) {
    if (price !== null && priceId === price) return `Zen Staff „Făcut pentru tine”, pachet ${id[0]!.toUpperCase()}${id.slice(1)}`;
  }
  return `${prefix}${String(line?.description ?? "Zen Staff")}`.slice(0, 200);
}

/**
 * The fiscal invoice for a paid Stripe invoice. Amounts come from Stripe (what the customer paid);
 * the VAT treatment from the company's details. A line Stripe bills for N units at a price that is
 * not a whole number of cents per unit becomes one line of quantity 1 with the line total.
 */
export function buildFiscalInvoice(input: {
  readonly stripeInvoice: any;
  readonly companyId: string;
  readonly details: CompanyDetails;
  readonly country: string;
  readonly vat: VatTreatment;
  readonly seller: Seller;
  readonly prices: { seat: string | null; server: string | null; packages: Record<string, string | null> };
}): FiscalInvoice {
  const invoice = input.stripeInvoice;
  const lines: Array<FiscalLine> = (invoice?.lines?.data ?? []).map((line: any) => {
    const quantity = typeof line?.quantity === "number" && line.quantity > 0 ? line.quantity : 1;
    const total = Number(line?.amount ?? 0);
    const even = total % quantity === 0;
    return {
      name: lineName(line, input.prices),
      quantity: even ? quantity : 1,
      unitPriceCents: even ? total / quantity : total,
      totalCents: total,
      unit: even && quantity > 1 ? "buc" : "serv",
      vatRate: input.vat.rate,
    };
  });
  const paidAtSeconds: number = invoice?.status_transitions?.paid_at ?? invoice?.created ?? Math.floor(Date.now() / 1000);
  const taxCents = typeof invoice?.tax === "number" ? invoice.tax : (invoice?.total_taxes ?? []).reduce((sum: number, tax: any) => sum + Number(tax?.amount ?? 0), 0);
  return {
    idempotencyKey: String(invoice.id),
    issueDate: new Date(paidAtSeconds * 1000).toISOString().slice(0, 10),
    currency: "EUR",
    seller: input.seller,
    customer: {
      legalName: input.details.legalName ?? invoice?.customer_name ?? "",
      taxId: input.details.taxId,
      registryNo: input.details.registryNo,
      address: input.details.address,
      city: input.details.city,
      county: input.details.county,
      country: input.country,
      email: input.details.billingEmail ?? invoice?.customer_email ?? null,
    },
    lines,
    vat: { kind: input.vat.kind, rate: input.vat.rate, note: input.vat.note },
    totalCents: Number(invoice?.amount_paid ?? invoice?.total ?? 0),
    taxCents: Number(taxCents),
    payment: { method: "card_or_sepa", reference: String(invoice.id), paidAt: new Date(paidAtSeconds * 1000).toISOString() },
    reference: { stripeInvoiceNumber: typeof invoice?.number === "string" ? invoice.number : null, companyId: input.companyId },
  };
}

/** Problems that would make the fiscal invoice wrong; issuing waits until the details are fixed. */
export function fiscalProblems(invoice: FiscalInvoice): Array<string> {
  const problems: Array<string> = [];
  if (invoice.customer.legalName.trim() === "") problems.push("legal name missing");
  if (invoice.customer.country === "RO" && invoice.customer.taxId === null) problems.push("CUI missing");
  if (invoice.customer.address === null) problems.push("address missing");
  if (invoice.lines.length === 0) problems.push("no lines");
  const sum = invoice.lines.reduce((total, line) => total + line.totalCents, 0);
  if (sum + invoice.taxCents !== invoice.totalCents) problems.push(`lines (${sum}) + VAT (${invoice.taxCents}) do not add up to the total paid (${invoice.totalCents})`);
  return problems;
}

// ---- Providers --------------------------------------------------------------------------------

/** No invoicing configured: logs the invoice it would issue, numberless. */
export function dryRunInvoicing(log: (line: string) => void, name = "dry-run"): InvoicingProvider {
  return {
    name,
    dryRun: true,
    async issue(invoice) {
      log(`[billing] dry run, fiscal invoice not issued: ${JSON.stringify(invoice)}`);
      return { status: "dry_run", ref: null, series: null, number: null, pdfUrl: null, efacturaStatus: null };
    },
  };
}

export interface HoReCaOSConfig {
  /** https://app.horecaos.org (no trailing slash). */
  readonly baseUrl: string;
  /** A HoReCaOS API key (zzk_...) of the issuing tenant, scopes invoices:write + invoices:read. */
  readonly apiKey: string;
  /** The tenant's invoice series id for Zen Staff; null = the tenant's default series. */
  readonly seriesId: string | null;
  /** The location the key is bound to, when the key is not bound to one. */
  readonly locationId: string | null;
}

/** e-Factura states of HoReCaOS (`fin_invoices.efactura_status`) to the hub's words. */
export function efacturaWord(status: unknown): string | null {
  if (typeof status !== "string" || status === "") return null;
  if (status === "ok" || status === "accepted") return "accepted";
  if (status === "nok" || status === "rejected" || status === "error") return "rejected";
  if (status === "in_prelucrare") return "in_processing";
  if (status === "uploaded") return "uploaded";
  return "pending";
}

/**
 * HoReCaOS as the invoicing system, through its server-to-server endpoints (README.md, "HoReCaOS"):
 * POST /api/v1/invoices creates, issues and sends the invoice to e-Factura in one idempotent call;
 * GET /api/v1/invoices/{id}/efactura reports SPV. The PDF needs the key too, so the hub serves it
 * to the company's managers itself. `validate()` sends the same body with `validate_only: true`:
 * HoReCaOS checks and computes it (BNR rate, VAT, totals, series) without writing anything. No key: dry run.
 */
export function horecaosInvoicing(config: HoReCaOSConfig | null, log: (line: string) => void, fetchImpl: typeof fetch = fetch): InvoicingProvider {
  if (config === null) return dryRunInvoicing(log, "horecaos");
  const call = async (method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string) => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await response.json().catch(() => ({}))) as any;
    // 409 duplicate_external_id: issued before (a retry after a lost answer); the body names it.
    // 424 anaf_not_connected: issued, not sent to SPV yet; a later retry (same external_id) sends it.
    if ((response.status === 409 || response.status === 424) && json?.invoice !== undefined) return json;
    if (!response.ok) throw new Error(`HoReCaOS ${method} ${path}: ${response.status} ${json?.code ?? json?.error ?? ""} ${json?.message ?? ""}`.trim());
    return json;
  };
  return {
    name: "horecaos",
    dryRun: false,
    async issue(invoice) {
      const json = await call("POST", "/api/v1/invoices", horecaosBody(invoice, config), `zen-hub:${invoice.idempotencyKey}`);
      const issued = json?.invoice ?? {};
      return {
        status: "issued",
        ref: issued.id === undefined ? null : String(issued.id),
        series: issued.series ?? null,
        number: issued.number === undefined || issued.number === null ? null : String(issued.number),
        pdfUrl: null,
        efacturaStatus: efacturaWord(issued.efactura?.status),
      };
    },
    async status(issued) {
      if (issued.ref === null) return { efacturaStatus: null, pdfUrl: null };
      const json = await call("GET", `/api/v1/invoices/${encodeURIComponent(issued.ref)}/efactura`);
      return { efacturaStatus: efacturaWord(json?.status), pdfUrl: null };
    },
    async validate(invoice) {
      const json = await call("POST", "/api/v1/invoices", { ...horecaosBody(invoice, config), validate_only: true });
      return { ok: true as const, preview: json?.would_issue ?? null, warnings: Array.isArray(json?.warnings) ? json.warnings.map(String) : [] };
    },
    async pdf(ref) {
      const response = await fetchImpl(`${config.baseUrl}/api/v1/invoices/${encodeURIComponent(ref)}/pdf`, {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/pdf" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HoReCaOS PDF ${ref}: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/** e-Factura VAT category per treatment (UBL / EN 16931): S standard, AE reverse charge, O outside scope. */
const VAT_CATEGORY = { standard: "S", reverse_charge: "AE", outside_scope: "O", not_registered: "O" } as const;

/** The request body of the HoReCaOS endpoint to add (snake_case like its API v1). Money in euro. */
export function horecaosBody(invoice: FiscalInvoice, config: Pick<HoReCaOSConfig, "seriesId" | "locationId">) {
  return {
    external_id: `zen-hub:${invoice.idempotencyKey}`,
    ...(config.seriesId === null ? {} : { series_id: config.seriesId }),
    ...(config.locationId === null ? {} : { location_id: config.locationId }),
    issue_date: invoice.issueDate,
    currency: invoice.currency,
    customer: {
      name: invoice.customer.legalName,
      cif: invoice.customer.taxId,
      reg_com: invoice.customer.registryNo,
      address: invoice.customer.address,
      city: invoice.customer.city,
      county: invoice.customer.county,
      country: invoice.customer.country,
      email: invoice.customer.email,
      // A VAT id with a country prefix means VAT registered; otherwise unknown (HoReCaOS asks ANAF).
      is_vat_payer: invoice.customer.taxId !== null && /^[A-Z]{2}/.test(invoice.customer.taxId) ? true : null,
    },
    lines: invoice.lines.map((line) => ({
      description: line.name,
      quantity: line.quantity,
      unit: line.unit,
      unit_price: line.unitPriceCents / 100,
      vat_category: VAT_CATEGORY[invoice.vat.kind],
      vat_rate: line.vatRate,
    })),
    totals: { net: (invoice.totalCents - invoice.taxCents) / 100, vat: invoice.taxCents / 100, gross: invoice.totalCents / 100 },
    notes: [invoice.vat.note, invoice.reference.stripeInvoiceNumber === null ? null : `Plătit online (Stripe ${invoice.reference.stripeInvoiceNumber}).`].filter((text) => text !== null).join(" "),
    paid: { method: "card", reference: invoice.payment.reference, paid_at: invoice.payment.paidAt },
    issue: true,
    send_to_efactura: true,
    email_customer: invoice.customer.email !== null,
  };
}
