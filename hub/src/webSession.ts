// The web dashboard's session: the same hub session as the app's bearer token, kept in an
// httpOnly, SameSite=Strict cookie (`__Host-` and Secure on https) so page scripts never see it.
//
// Cross-site request forgery: the cookie is only honoured on requests that carry the header
// `x-zen-web: 1`. A page on another site cannot add a custom header to a request to the hub without
// a CORS preflight, and the hub never answers one, so only the hub's own pages can use the cookie.
// The hub also refuses the cookie when the browser says the request came from another origin
// (`Origin`, `Sec-Fetch-Site`). Bearer tokens (the app) are unchanged and take precedence.
import type { IncomingMessage } from "node:http";

/** Web sessions last 14 days (the app's last 90): a browser is more often shared or left open. */
export const WEB_SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
export const WEB_HEADER = "x-zen-web";

export const webCookieName = (publicUrl: string) => (publicUrl.startsWith("https://") ? "__Host-zen_web" : "zen_web");

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{10,200}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** A request from the hub's own web pages (custom header, same origin as far as the browser tells). */
export function isWebRequest(req: IncomingMessage, publicUrl: string): boolean {
  if (req.headers[WEB_HEADER] !== "1") return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== new URL(publicUrl).origin) return false;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  return true;
}

/** The session token from the cookie, only for requests made by the hub's own pages. */
export function webSessionToken(req: IncomingMessage, publicUrl: string): string | null {
  if (!isWebRequest(req, publicUrl)) return null;
  return readCookie(req, webCookieName(publicUrl));
}

export function sessionCookie(publicUrl: string, token: string): string {
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${webCookieName(publicUrl)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}${secure}`;
}

export function clearSessionCookie(publicUrl: string): string {
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${webCookieName(publicUrl)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** "Browser (Chrome, Windows)" for the sessions list; the full user agent is not kept. */
export function browserLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const parts = [browser, os].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Browser" : `Browser (${parts.join(", ")})`;
}
