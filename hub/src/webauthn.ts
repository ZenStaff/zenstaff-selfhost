// Passkeys (WebAuthn): relying-party settings, the hub's own ceremony pages (Romanian and English)
// and the vendored browser library they load. The ceremonies run on the hub's origin, so the hub
// is the relying party; the app only opens these pages and polls, as for Google / Microsoft.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PageLanguage } from "./storePasskeys.ts";

export interface WebauthnConfig {
  /** RP ID: a registrable domain suffix of the origin (default: the hostname of HUB_PUBLIC_URL). */
  readonly rpId: string;
  /** Shown by the browser and the authenticator (default "Zen Staff"). */
  readonly rpName: string;
  /** Expected origin of the ceremony pages (default: the origin of HUB_PUBLIC_URL). */
  readonly origin: string;
}

export function webauthnConfig(env: Record<string, string | undefined>, publicUrl: string): WebauthnConfig {
  const url = new URL(publicUrl);
  return {
    rpId: env.HUB_WEBAUTHN_RP_ID?.trim() || url.hostname,
    rpName: env.HUB_WEBAUTHN_RP_NAME?.trim() || "Zen Staff",
    origin: (env.HUB_WEBAUTHN_ORIGIN?.trim() || url.origin).replace(/\/$/, ""),
  };
}

// ---- Static files ----------------------------------------------------------------------------

/** @simplewebauthn/browser, vendored from the npm package (test/passkeys.test.ts checks it). */
export const BROWSER_LIB_VERSION = "14.0.0";
export const BROWSER_LIB_PATH = `/v1/assets/simplewebauthn-browser-${BROWSER_LIB_VERSION}.js`;
/** Subresource integrity of the vendored file; the browser refuses it if it ever changes. */
export const BROWSER_LIB_INTEGRITY = "sha384-06g944bCm8L/wG3i0Q8PdB8jccE4GdpHdNCa1tJY8eMqoP3GIHGJdL6B5lD5OMGD";
export const PAGE_SCRIPT_PATH = "/v1/assets/passkey-page.js";

const browserLib = readFileSync(new URL(`./assets/simplewebauthn-browser-${BROWSER_LIB_VERSION}.umd.min.js`, import.meta.url));
const pageScript = readFileSync(new URL("./assets/passkey-page.js", import.meta.url));

export function serveAsset(res: ServerResponse, which: "lib" | "page") {
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": which === "lib" ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(which === "lib" ? browserLib : pageScript);
}

// ---- Texts -----------------------------------------------------------------------------------

const TEXTS = {
  en: {
    registerTitle: "Add a passkey",
    registerText: "Zen Staff asked to add a passkey to {email}. Your device will ask for your fingerprint, face, PIN or screen lock.",
    registerButton: "Create passkey",
    registerDoneTitle: "Passkey added",
    registerDoneText: "Go back to Zen Staff; the passkey is listed under Team > Account.",
    loginTitle: "Sign in with a passkey",
    loginText: "Only continue if you just started signing in to Zen Staff yourself, on this computer.",
    loginButton: "Use a passkey",
    loginDoneTitle: "Signed in",
    loginDoneText: "Go back to Zen Staff; it finishes signing in by itself.",
    working: "Waiting for your device...",
    failed: "That did not work. Try again.",
    cancelled: "Cancelled or timed out. Try again.",
    refused: "This passkey was not accepted. It may have been removed; sign in another way.",
    duplicate: "This device already has a passkey for this account.",
    limited: "Too many attempts. Wait a few minutes.",
    unsupported: "This browser does not support passkeys. Open the link in a recent browser.",
    expiredTitle: "This link expired",
    expiredText: "Start again from Zen Staff.",
  },
  ro: {
    registerTitle: "Adaugă o cheie de acces",
    registerText: "Zen Staff a cerut adăugarea unei chei de acces (passkey) pentru {email}. Dispozitivul îți va cere amprenta, fața, PIN-ul sau blocarea ecranului.",
    registerButton: "Creează cheia de acces",
    registerDoneTitle: "Cheia de acces a fost adăugată",
    registerDoneText: "Întoarce-te în Zen Staff; cheia apare la Echipă > Cont.",
    loginTitle: "Autentificare cu cheie de acces",
    loginText: "Continuă doar dacă tu ai pornit chiar acum autentificarea în Zen Staff, pe acest calculator.",
    loginButton: "Folosește o cheie de acces",
    loginDoneTitle: "Te-ai autentificat",
    loginDoneText: "Întoarce-te în Zen Staff; autentificarea se încheie singură.",
    working: "Se așteaptă dispozitivul...",
    failed: "Nu a mers. Încearcă din nou.",
    cancelled: "Anulat sau expirat. Încearcă din nou.",
    refused: "Cheia de acces nu a fost acceptată. Poate a fost ștearsă; autentifică-te altfel.",
    duplicate: "Acest dispozitiv are deja o cheie de acces pentru acest cont.",
    limited: "Prea multe încercări. Așteaptă câteva minute.",
    unsupported: "Acest browser nu suportă chei de acces. Deschide linkul într-un browser recent.",
    expiredTitle: "Linkul a expirat",
    expiredText: "Începe din nou din Zen Staff.",
  },
} as const satisfies Record<PageLanguage, Record<string, string>>;

export function pageLanguage(req: IncomingMessage, url: URL): PageLanguage {
  const asked = url.searchParams.get("lang");
  if (asked === "ro" || asked === "en") return asked;
  const header = String(req.headers["accept-language"] ?? "").toLowerCase();
  return header.startsWith("ro") ? "ro" : "en";
}

export function parseLanguage(value: unknown): PageLanguage {
  return value === "ro" ? "ro" : "en";
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Scripts only from the hub itself (the vendored library carries an integrity hash too).
  "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const BODY_STYLE = "font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem";

/** The page when the link is unknown, used or expired; same look as the other hub pages. */
export function expiredPage(res: ServerResponse, lang: PageLanguage) {
  const t = TEXTS[lang];
  res.writeHead(400, PAGE_HEADERS);
  res.end(
    `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zen Staff</title><body style="${BODY_STYLE}"><h1>${escape(t.expiredTitle)}</h1><p>${escape(t.expiredText)}</p></body></html>`,
  );
}

/** The ceremony page: a button (browsers want a user gesture) that runs create() or get(). */
export function ceremonyPage(res: ServerResponse, input: { mode: "register" | "login"; token: string; lang: PageLanguage; email?: string }) {
  const t = TEXTS[input.lang];
  const register = input.mode === "register";
  const data: Record<string, string> = {
    mode: input.mode,
    token: input.token,
    "done-title": register ? t.registerDoneTitle : t.loginDoneTitle,
    "done-text": register ? t.registerDoneText : t.loginDoneText,
    working: t.working,
    failed: t.failed,
    cancelled: t.cancelled,
    refused: t.refused,
    duplicate: t.duplicate,
    limited: t.limited,
    unsupported: t.unsupported,
    expired: `${t.expiredTitle}. ${t.expiredText}`,
  };
  const attributes = Object.entries(data)
    .map(([key, value]) => `data-${key}="${escape(value)}"`)
    .join(" ");
  const heading = register ? t.registerTitle : t.loginTitle;
  const text = register ? t.registerText.replace("{email}", input.email ?? "") : t.loginText;
  const button = register ? t.registerButton : t.loginButton;
  res.writeHead(200, PAGE_HEADERS);
  // Relative addresses, so a hub behind a path prefix works too.
  res.end(
    `<!doctype html><html lang="${input.lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zen Staff</title>` +
      `<script src="..${BROWSER_LIB_PATH.slice(3)}" integrity="${BROWSER_LIB_INTEGRITY}" defer></script>` +
      `<script src="..${PAGE_SCRIPT_PATH.slice(3)}" defer></script>` +
      `<body style="${BODY_STYLE}" ${attributes}><h1 id="title">${escape(heading)}</h1><p id="text">${escape(text)}</p>` +
      `<p><button id="go" type="button" style="font:inherit;padding:.5rem 1rem;cursor:pointer">${escape(button)}</button></p>` +
      `<p id="status" role="status" aria-live="polite"></p></body></html>`,
  );
}
