// The web dashboard at /app: its pages and static files, and the sign-in routes that put the hub
// session in an httpOnly cookie instead of handing the token to page scripts (webSession.ts).
// The dashboard itself is a small vanilla script (src/assets/web/app.js) that calls the same JSON
// API as the app; every authorization rule stays in the routes it calls.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Kit } from "../app.ts";
import { acceptLanguage, asLanguage, bad, clientIp, HttpError, str } from "../http.ts";
import * as policy from "../policy.ts";
import * as store from "../store.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";
import { BROWSER_LIB_INTEGRITY, BROWSER_LIB_PATH } from "../webauthn.ts";
import { browserLabel, clearSessionCookie, isWebRequest, sessionCookie, WEB_SESSION_TTL_MS } from "../webSession.ts";

/** Client-side pages; each serves the same shell, the script draws the page. */
export const WEB_PAGES = [
  "intra",
  "acasa",
  "firma",
  "echipa",
  "roluri",
  "dispozitive",
  "angajati",
  "pachete",
  "securitate",
  "jurnal",
  "plan",
  "biblioteca",
  "verificare",
  "cifre",
  "admin",
  "invitatie",
] as const;

/** The platform admin's tabs: /app/admin/<tab> serves the same shell. */
export const ADMIN_TABS = ["cifre", "firme", "conturi", "abonamente", "suport", "biblioteca", "jurnal"] as const;

const ASSET_DIR = new URL("../assets/web/", import.meta.url);

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
};

/** Folders under src/assets/web/ served as they are: fonts, the painted backdrops, e-mail images. */
const ASSET_SUBDIRS = ["fonts", "art", "mail"] as const;

interface Asset {
  readonly body: Buffer;
  readonly type: string;
  readonly etag: string;
}

function loadAssets(): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const add = (relative: string) => {
    const body = readFileSync(new URL(relative, ASSET_DIR));
    const ext = relative.slice(relative.lastIndexOf("."));
    const type = TYPES[ext];
    if (type === undefined) return;
    assets.set(`/app/assets/${relative}`, { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` });
  };
  for (const name of readdirSync(ASSET_DIR)) if (name.includes(".")) add(name);
  for (const dir of ASSET_SUBDIRS) for (const name of readdirSync(new URL(`${dir}/`, ASSET_DIR))) add(`${dir}/${name}`);
  return assets;
}

/**
 * Only the hub's own files: scripts, styles, fonts and images from this origin, requests only to
 * this origin, no framing, no forms posting elsewhere, no inline script.
 */
export const WEB_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "content-security-policy": WEB_CSP,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
} as const;

/** Images in e-mails are loaded by mail clients from other origins; everything else stays same-origin. */
export const crossOriginAsset = (path: string) => path.startsWith("/app/assets/mail/");

function serveAsset(req: IncomingMessage, res: ServerResponse, path: string, asset: Asset) {
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, { etag: asset.etag, "cache-control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": asset.type,
    // Fonts never change under the same name; images are kept a day; script and styles are checked on each load.
    "cache-control": asset.type === "font/woff2" ? "public, max-age=31536000, immutable" : asset.type.startsWith("image/") ? "public, max-age=86400" : "no-cache",
    etag: asset.etag,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": crossOriginAsset(path) ? "cross-origin" : "same-origin",
  });
  res.end(asset.body);
}

/**
 * The page shell: the shape of the dashboard (skeleton) until the script fills it. Its language is a
 * first guess (?lang, else the browser's); the script settles it (its saved choice, the account's).
 */
function shell(version: string, lang: "ro" | "en"): string {
  const bones = (count: number, cls: string) => Array.from({ length: count }, () => `<span class="bone ${cls}"></span>`).join("");
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow">` +
    `<meta name="theme-color" content="#F7F6F2"><title>Zen Staff</title><link rel="icon" href="/app/assets/favicon.svg" type="image/svg+xml">` +
    `<link rel="preload" href="/app/assets/fonts/hanken-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>` +
    `<link rel="preload" href="/app/assets/fonts/young-serif-latin.woff2" as="font" type="font/woff2" crossorigin>` +
    `<link rel="stylesheet" href="/app/assets/app.css?v=${version}">` +
    `<script src="${BROWSER_LIB_PATH}" integrity="${BROWSER_LIB_INTEGRITY}" defer></script>` +
    `<script src="/app/assets/app.js?v=${version}" type="module"></script></head>` +
    `<body><div id="root" aria-busy="true"><div class="app"><aside class="side"><span class="bone b-logo"></span><span class="bone b-switch"></span>${bones(8, "b-nav")}</aside>` +
    `<main class="main"><section class="home-art art dawn"><div class="page-head"><div><span class="bone b-title"></span><span class="bone b-sub"></span></div></div>` +
    `<div class="kpis">${bones(4, "b-kpi")}</div></section><div class="bento">${bones(6, "card b-card")}</div></main></div></div></body></html>`
  );
}

export function registerWebRoutes(kit: Kit) {
  const { db, config, route, loginLimiter } = kit;
  const assets = loadAssets();
  const version = createHash("sha256")
    .update(assets.get("/app/assets/app.js")?.etag ?? "")
    .update(assets.get("/app/assets/app.css")?.etag ?? "")
    .digest("base64url")
    .slice(0, 10);
  const html = { ro: shell(version, "ro"), en: shell(version, "en") };

  const page = (req: IncomingMessage, url: URL, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
    res.end(html[asLanguage(url.searchParams.get("lang")) ?? acceptLanguage(req) ?? "ro"]);
  };
  kit.page("/app", page);
  kit.page("/app/", page);
  for (const name of WEB_PAGES) kit.page(`/app/${name}`, page);
  for (const tab of ADMIN_TABS) kit.page(`/app/admin/${tab}`, page);
  for (const [path, asset] of assets) kit.page(path, (req, _url, res) => serveAsset(req, res, path, asset));

  // ---- Sign-in for the web pages -------------------------------------------------------------

  const requireWeb = (req: IncomingMessage) => {
    if (!isWebRequest(req, config.publicUrl)) throw new HttpError(403, "Use the hub's own pages.", "web_only");
  };

  /** A browser session: the cookie carries the token; the answer says what the page shows next. */
  const startWebSession = (email: string, req: IncomingMessage, method: string, setCookie: (cookie: string) => void) => {
    const user = store.upsertUser(db, email);
    const mfa = method === "passkey";
    const token = security.createSession(db, {
      userId: user.id,
      label: browserLabel(req.headers["user-agent"]),
      ip: clientIp(req),
      method,
      mfa,
      ttlMs: WEB_SESSION_TTL_MS,
    });
    setCookie(sessionCookie(config.publicUrl, token));
    const twoFactor = policy.twoFactorGate({
      roles: team.rolesOfUser(db, user.id),
      totpEnabled: security.totpState(db, user.id).enabled,
      sessionVerified: mfa,
    });
    return { user, twoFactor };
  };

  // The code comes from /v1/auth/start (the same e-mail as for the app).
  route(
    "POST",
    "/v1/web/auth/verify",
    ({ body, req, setCookie }) => {
      requireWeb(req);
      const email = store.normalizeEmail(str(body, "email", 254));
      if (email === null) throw bad("Enter a valid e-mail address.");
      loginLimiter(`verify:${clientIp(req)}`);
      const verified = store.verifyLoginCode(db, email, str(body, "code", 12));
      if (verified === null) throw new HttpError(401, "That code is wrong or expired.");
      return startWebSession(verified, req, "email", setCookie);
    },
    "public",
  );

  // The e-mail link or a passkey approved a pending sign-in (/v1/auth/start, /v1/auth/passkey/start).
  route(
    "POST",
    "/v1/web/auth/poll",
    ({ body, req, setCookie }) => {
      requireWeb(req);
      const requestId = str(body, "requestId", 80);
      const email = store.pollLogin(db, requestId, str(body, "pollSecret", 200));
      if (email === null) return { pending: true };
      return { pending: false, ...startWebSession(email, req, security.loginMethod(db, requestId), setCookie) };
    },
    "public",
  );

  route(
    "POST",
    "/v1/web/auth/logout",
    ({ req, session, setCookie }) => {
      requireWeb(req);
      security.endSession(db, session.hash);
      setCookie(clearSessionCookie(config.publicUrl));
      return { ok: true };
    },
    "signin",
  );

  // Clears a cookie the hub no longer knows (expired or signed out elsewhere); no session needed.
  route(
    "POST",
    "/v1/web/auth/forget",
    ({ req, setCookie }) => {
      requireWeb(req);
      setCookie(clearSessionCookie(config.publicUrl));
      return { ok: true };
    },
    "public",
  );
}
