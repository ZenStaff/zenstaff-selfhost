// Tax identifiers of the companies we invoice: the Romanian CUI / CIF (with its check digit), EU VAT
// numbers (format per country) and the VIES check of an EU VAT number. Pure functions except
// `checkVies`, which takes its fetch so tests never touch the network.

/** Weights of the CUI check digit (ANAF), applied to the first digits padded left to 9. */
const CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];

/**
 * A Romanian CUI / CIF: 2 to 10 digits, the last one a check digit, optionally prefixed by "RO"
 * (the company is registered for VAT). Spaces are ignored. Returns null when it is not valid.
 */
export function parseRoCui(input: string): { digits: string; vatPrefixed: boolean } | null {
  const value = input.replace(/\s+/g, "").toUpperCase();
  const match = /^(RO)?([0-9]{2,10})$/.exec(value);
  if (match === null) return null;
  const digits = match[2]!;
  if (digits.startsWith("0")) return null;
  const body = digits.slice(0, -1).padStart(9, "0");
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(body[index]) * CUI_KEY[index]!;
  const control = ((sum * 10) % 11) % 10;
  if (control !== Number(digits.at(-1))) return null;
  return { digits, vatPrefixed: match[1] === "RO" };
}

export const isValidRoCui = (input: string) => parseRoCui(input) !== null;

/** The EU member states, by the code used in addresses (ISO 3166-1); Greece's VAT prefix is EL. */
export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

export const isEuCountry = (code: string) => (EU_COUNTRIES as ReadonlyArray<string>).includes(code);

/** Shapes of the national part of an EU VAT number (Commission VIES formats, simplified). */
const VAT_FORMATS: Record<string, RegExp> = {
  AT: /^U[0-9]{8}$/,
  BE: /^[01][0-9]{9}$/,
  BG: /^[0-9]{9,10}$/,
  CY: /^[0-9]{8}[A-Z]$/,
  CZ: /^[0-9]{8,10}$/,
  DE: /^[0-9]{9}$/,
  DK: /^[0-9]{8}$/,
  EE: /^[0-9]{9}$/,
  EL: /^[0-9]{9}$/,
  ES: /^[0-9A-Z][0-9]{7}[0-9A-Z]$/,
  FI: /^[0-9]{8}$/,
  FR: /^[0-9A-Z]{2}[0-9]{9}$/,
  HR: /^[0-9]{11}$/,
  HU: /^[0-9]{8}$/,
  IE: /^[0-9][0-9A-Z+*][0-9]{5}[A-Z]{1,2}$/,
  IT: /^[0-9]{11}$/,
  LT: /^([0-9]{9}|[0-9]{12})$/,
  LU: /^[0-9]{8}$/,
  LV: /^[0-9]{11}$/,
  MT: /^[0-9]{8}$/,
  NL: /^[0-9]{9}B[0-9]{2}$/,
  PL: /^[0-9]{10}$/,
  PT: /^[0-9]{9}$/,
  RO: /^[1-9][0-9]{1,9}$/,
  SE: /^[0-9]{12}$/,
  SI: /^[0-9]{8}$/,
  SK: /^[0-9]{10}$/,
};

/** The VAT prefix of a country (EL for Greece). */
export const vatPrefixOf = (country: string) => (country === "GR" ? "EL" : country);

/**
 * An EU VAT number for a company in `country` (ISO code): "DE123456789", "EL123456789", or the
 * national part alone ("123456789"). Romanian numbers must also pass the CUI check digit.
 */
export function parseEuVat(input: string, country: string): { prefix: string; number: string; full: string } | null {
  if (!isEuCountry(country)) return null;
  const prefix = vatPrefixOf(country);
  let value = input.replace(/[\s.-]+/g, "").toUpperCase();
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  const format = VAT_FORMATS[prefix];
  if (format === undefined || !format.test(value)) return null;
  if (prefix === "RO" && !isValidRoCui(value)) return null;
  return { prefix, number: value, full: `${prefix}${value}` };
}

/** Country names people type in the company form, to ISO codes (Romanian and English). */
const COUNTRY_NAMES: Record<string, string> = {
  romania: "RO", "românia": "RO", germania: "DE", germany: "DE", deutschland: "DE", austria: "AT", "österreich": "AT", italia: "IT", italy: "IT",
  franta: "FR", "franța": "FR", france: "FR", spania: "ES", spain: "ES", ungaria: "HU", hungary: "HU", bulgaria: "BG", olanda: "NL", netherlands: "NL",
  belgia: "BE", belgium: "BE", polonia: "PL", poland: "PL", moldova: "MD", "republica moldova": "MD", "marea britanie": "GB", "united kingdom": "GB",
};

/** "RO", "ro", "România" and "Romania" all give "RO"; null when it is not recognised. */
export function countryCode(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = input.trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return COUNTRY_NAMES[value.toLowerCase()] ?? null;
}

export type ViesResult = "valid" | "invalid" | "unavailable";

/**
 * Asks VIES (the Commission's REST service) whether an EU VAT number is active. Never throws:
 * a timeout or an error answer is "unavailable" (VIES is often down per member state).
 */
export async function checkVies(
  vat: { prefix: string; number: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<{ result: ViesResult; name: string | null }> {
  try {
    const response = await fetchImpl(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${encodeURIComponent(vat.prefix)}/vat/${encodeURIComponent(vat.number)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) return { result: "unavailable", name: null };
    const body = (await response.json()) as { isValid?: unknown; name?: unknown; userError?: unknown };
    if (typeof body.isValid !== "boolean") return { result: "unavailable", name: null };
    if (!body.isValid && typeof body.userError === "string" && body.userError !== "VALID" && body.userError !== "INVALID") {
      return { result: "unavailable", name: null };
    }
    const name = typeof body.name === "string" && body.name !== "---" ? body.name : null;
    return { result: body.isValid ? "valid" : "invalid", name };
  } catch {
    return { result: "unavailable", name: null };
  }
}
