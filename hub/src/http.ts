// Small HTTP helpers shared by the route modules: errors, body field readers, rate limits.
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

import * as policy from "./policy.ts";
import type { SessionInfo } from "./storeSecurity.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message: string) => new HttpError(400, message);
export const forbidden = (message = "You do not have access to this.") => new HttpError(403, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);

export type Json = Record<string, unknown>;

export interface Ctx {
  readonly req: IncomingMessage;
  readonly params: Record<string, string>;
  readonly body: Json;
  readonly query: URLSearchParams;
  /** Set on authenticated routes. */
  readonly session: SessionInfo;
  /** Adds a Set-Cookie header to the answer (the web dashboard's session cookie). */
  readonly setCookie: (cookie: string) => void;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

/** A handler's answer that is not JSON: an archive, an image. */
export class RawBody {
  readonly bytes: Buffer;
  readonly type: string;
  readonly headers: Record<string, string>;
  constructor(bytes: Buffer, type: string, headers: Record<string, string> = {}) {
    this.bytes = bytes;
    this.type = type;
    this.headers = headers;
  }
}

export interface RouteOptions {
  /** Largest request body this route accepts (default 1 MB). */
  readonly maxBody?: number;
}

/**
 * `full`: a complete session (two-factor done where needed). `signin`: also allowed while the
 * session still has to set up or enter two-factor (sign-in, device and session routes).
 * `public`: no session.
 */
export type Access = "full" | "signin" | "public";

export function str(body: Json, key: string, max = 500): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw bad(`${key} is required.`);
  if (value.length > max) throw bad(`${key} is too long.`);
  return value.trim();
}

export function optStr(body: Json, key: string, max = 500): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw bad(`${key} must be text.`);
  if (value.length > max) throw bad(`${key} is too long.`);
  return value.trim();
}

export function obj(body: Json, key: string): Json {
  const value = body[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw bad(`${key} must be an object.`);
  return value as Json;
}

export function role(value: unknown): policy.Role {
  if (typeof value === "string" && (policy.ROLES as ReadonlyArray<string>).includes(value)) {
    return value as policy.Role;
  }
  throw bad("role must be owner, admin, member or guest.");
}

const forwardedIps = new WeakMap<IncomingMessage, string>();

/**
 * Behind a reverse proxy every request comes from the proxy's address, so per-address limits would
 * count all users together. With `HUB_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`, set by Cloudflare)
 * the hub takes the address from that header instead. Only set it when every request reaches the hub
 * through that proxy (the header is otherwise forgeable). Invalid or missing values are ignored.
 */
export function rememberClientIp(req: IncomingMessage, header: string | undefined): void {
  if (header === undefined || header === "") return;
  const raw = req.headers[header.toLowerCase()];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim() ?? "";
  if (isIP(value) !== 0) forwardedIps.set(req, value);
}

export function clientIp(req: IncomingMessage): string {
  return forwardedIps.get(req) ?? req.socket.remoteAddress ?? "unknown";
}

/** "ro" or "en" from a body field or a query parameter; anything else is null. */
export const asLanguage = (value: unknown): "ro" | "en" | null => (value === "ro" || value === "en" ? value : null);

/**
 * The browser's first language (Accept-Language): ro* is Romanian, any other language English.
 * No header, or only "*" (scripts, mail scanners), says nothing: null.
 */
export function acceptLanguage(req: IncomingMessage): "ro" | "en" | null {
  const first = String(req.headers["accept-language"] ?? "").split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (first === "" || first === "*") return null;
  return first.startsWith("ro") ? "ro" : "en";
}

/** The TCP peer, never a header: for loopback-only pages. */
export function socketIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Fixed-window limiter. Calling it counts one hit for the key and throws 429 over the limit;
 * `check` throws when the key is already over the limit without counting (for failures-only use).
 */
export function makeLimiter(limit: number, windowMs: number, message = "Too many attempts. Wait a few minutes.") {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const tooMany = (entry: { resetAt: number }, now: number) => {
    const error = new HttpError(429, message, "rate_limited");
    (error as HttpError & { retryAfter: number }).retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return error;
  };
  const hit = (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (hits.size > 20_000) {
        for (const [candidate, value] of hits) if (value.resetAt <= now) hits.delete(candidate);
        if (hits.size > 20_000) hits.clear();
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > limit) throw tooMany(entry, now);
  };
  return Object.assign(hit, {
    check(key: string) {
      const now = Date.now();
      const entry = hits.get(key);
      if (entry !== undefined && entry.resetAt > now && entry.count >= limit) throw tooMany(entry, now);
    },
  });
}
