// HTTP API. JSON in and out, bearer session tokens; every route that touches a company or a share
// asks policy.ts first. Runners use the WebSocket in relay.ts. Routes live in src/routes/*.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { anchorToday, attachAuditLog, AuditLog, openAuditDb, requestContext, type AuditDb, type RequestContext } from "./auditChain.ts";
import type { BillingConfig } from "./billing/config.ts";
import { noBilling } from "./billing/config.ts";
import { horecaosInvoicing, type InvoicingProvider } from "./billing/invoicing.ts";
import { type Billing, makeBilling } from "./billing/service.ts";
import { makeStripe, type StripeApi } from "./billing/stripe.ts";
import type { Db } from "./db.ts";
import { type Access, clientIp, RawBody, type RouteOptions, rememberClientIp, type Ctx, type Handler, HttpError, type Json, bad, makeLimiter, notFound } from "./http.ts";
import type { Mailer } from "./mail.ts";
import { makeNotifier, type Notifier } from "./notify.ts";
import type { OauthProvider } from "./oauth.ts";
import * as policy from "./policy.ts";
import * as rbac from "./rbac.ts";
import { Relay, RelayError } from "./relay.ts";
import { type ApprovalStorage, memoryStorage } from "./approvalFiles.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerBillingRoutes } from "./routes/billing.ts";
import { registerCompanyRoutes } from "./routes/companies.ts";
import { registerMemoryHostedRoutes } from "./routes/memoryHosted.ts";
import type { MemoryHostedConfig } from "./memoryHosted.ts";
import { registerCompanyObjectRoutes } from "./routes/companyObjects.ts";
import { registerPasskeyRoutes } from "./routes/passkeys.ts";
import { registerSecurityRoutes } from "./routes/security.ts";
import { registerRunnerAlertRoutes } from "./routes/runnerAlerts.ts";
import { registerShareRoutes } from "./routes/shares.ts";
import { registerTeamRoutes } from "./routes/team.ts";
import { registerToolchainRoutes } from "./routes/toolchains.ts";
import { registerLibraryRoutes } from "./routes/library.ts";
import { registerLibraryPages } from "./routes/libraryPages.ts";
import { registerDashboardRoutes } from "./routes/dashboard.ts";
import { registerStatsRoutes } from "./routes/stats.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerGrowthRoutes } from "./routes/growth.ts";
import type { GrowthConfig } from "./growth.ts";
import { registerWebRoutes } from "./routes/web.ts";
import { makeSecretBox, type SecretBox } from "./secretBox.ts";
import type { StatsConfig } from "./stats.ts";
import * as store from "./store.ts";
import { makeSiemStream } from "./siem.ts";
import * as roles from "./storeRbac.ts";
import * as security from "./storeSecurity.ts";
import * as team from "./storeTeam.ts";
import { webauthnConfig, type WebauthnConfig } from "./webauthn.ts";
import { webSessionToken } from "./webSession.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface HubConfig {
  /** Public base URL of the hub, used in e-mailed links and as the OAuth redirect base. */
  readonly publicUrl: string;
  /** Only for local development: lets loopback callers read the dev outbox. */
  readonly devOutbox: boolean;
  /** Mutating requests per signed-in person per minute (default 120). */
  readonly writeLimitPerMinute?: number;
  /** Sign-in e-mails / code checks per address and per e-mail per 10 minutes (default 10). */
  readonly loginLimitPer10Minutes?: number;
  /** Bearer token the night job uses to publish the toolchain advisories file; unset = no publishing. */
  readonly advisoriesToken?: string;
  /** Passkeys relying party; default: RP ID and origin from publicUrl, name "Zen Staff". */
  readonly webauthn?: WebauthnConfig;
  /** Header holding the real client address behind a trusted proxy (e.g. "cf-connecting-ip"); unset = TCP peer. */
  readonly clientIpHeader?: string;
  /** What the web dashboard shows as the plan: our hosted hub or a self-hosted one (default). */
  readonly plan?: "hosted" | "selfhost";
  /** E-mails of hub reviewers for the community library (also the hub_staff table). */
  readonly libraryReviewers?: ReadonlyArray<string>;
  /** SIEM webhooks may point at loopback / private addresses (self-host on a LAN, tests). */
  readonly siemAllowPrivate?: boolean;
  /** Where the daily audit anchor is also POSTed (e.g. a worker that writes it to R2); unset = log and hub DB only. */
  readonly auditAnchorUrl?: string;
  /** Hosted company memory (zen-memory, v13); unset = companies use their own memory server. */
  readonly memory?: MemoryHostedConfig;
  /** Bytes of client approval files one company may keep on the hub (default 1 GB). */
  readonly approvalCompanyBytes?: number;
  /** The operator's "Cifre" page (downloads, active installs, hub counts); its e-mails are operators too. */
  readonly stats?: StatsConfig;
  /** HUB_ADMIN_EMAILS: operators of the platform admin before anyone is in hub_staff (bootstrap). */
  readonly adminEmails?: ReadonlyArray<string>;
  /** Growth (v18): funnel, leads, partner links and opt-outs for our growth team; unset = off (404). */
  readonly growth?: GrowthConfig;
}

/** What every route module gets. */
export interface Kit {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly config: HubConfig;
  readonly log: (line: string) => void;
  readonly relay: Relay;
  readonly notifier: Notifier;
  readonly box: SecretBox;
  readonly oauth: ReadonlyArray<OauthProvider>;
  readonly route: (method: string, path: string, handler: Handler, access?: Access, options?: RouteOptions) => void;
  /** The caller's role; not a member and no such company look the same (404). */
  readonly requireRole: (companyId: string, userId: string) => policy.Role;
  /**
   * The caller's role and access, after checking one permission (v9); 403 `permission_denied`
   * names the permission. Not a member looks like no such company (404).
   */
  readonly requirePermission: (
    companyId: string,
    userId: string,
    permission: rbac.Permission,
    scope?: rbac.ScopeContext,
  ) => { readonly role: policy.Role; readonly access: rbac.Access };
  /** The tamper-evident audit log (its own database). */
  readonly auditLog: AuditLog;
  /** SIEM stream: events of companies with a webhook are sent on. */
  readonly siem: ReturnType<typeof makeSiemStream>;
  /** Sign-in e-mails / code checks per address and per e-mail; shared by the app and web sign-in routes. */
  readonly loginLimiter: ReturnType<typeof makeLimiter>;
  /** Payments for the hosted plan (src/billing/service.ts). */
  readonly billing: Billing;
  /**
   * A route that writes its own answer and gets the exact request bytes (the Stripe webhook, whose
   * signature covers them; a PDF download). `session` is null on public routes.
   */
  readonly raw: (
    method: string,
    path: string,
    handler: (input: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; session: security.SessionInfo | null; rawBody: string }) => Promise<void> | void,
    access?: Access,
  ) => void;
  /** Raw HTML pages (sign-in link, OAuth callback, invitation). */
  readonly page: (path: string, handler: (req: IncomingMessage, url: URL, res: ServerResponse) => Promise<void> | void) => void;
  /** Raw HTML pages under a prefix (the public library pages /p/<slug> and /a/<slug>). */
  readonly pagePrefix: (prefix: string, handler: (req: IncomingMessage, url: URL, res: ServerResponse) => Promise<void> | void) => void;
  /**
   * Plain HTML form posts under a prefix (the client approval page, which has no script): the
   * handler reads its own body and applies its own rate limits.
   */
  readonly formPrefix: (prefix: string, handler: (req: IncomingMessage, url: URL, res: ServerResponse) => Promise<void> | void) => void;
}

export function htmlPage(res: ServerResponse, status: number, title: string, text: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zen Staff</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escape(title)}</h1><p>${escape(text)}</p></body>`,
  );
}

export function createHub(input: {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly config: HubConfig;
  readonly log: (line: string) => void;
  readonly box?: SecretBox;
  readonly oauth?: ReadonlyArray<OauthProvider>;
  /** The audit log's own database (default: in memory, for tests). */
  readonly auditDb?: AuditDb;
  /** Where client approval files are kept (default: in memory, for tests). */
  readonly approvalStorage?: ApprovalStorage;
  /** Payments; default: nothing configured. Tests pass a fake Stripe and invoicing provider. */
  readonly billing?: {
    readonly config?: BillingConfig;
    readonly stripe?: StripeApi | null;
    readonly invoicing?: InvoicingProvider;
    readonly now?: () => number;
    readonly viesFetch?: typeof fetch;
  };
}): { server: Server; relay: Relay; auditLog: AuditLog; siem: ReturnType<typeof makeSiemStream>; billing: Billing } {
  const { db, mailer, config, log } = input;
  const relay = new Relay(db, log);
  const box = input.box ?? makeSecretBox(undefined);
  const auditLog = new AuditLog(input.auditDb ?? openAuditDb(":memory:"));
  attachAuditLog(db, auditLog);
  auditLog.resolveActorsWith((userId) => {
    const user = store.getUser(db, userId);
    return user === null ? null : { email: user.email, name: user.name };
  });
  const siem = makeSiemStream({ db, box, log, allowPrivate: config.siemAllowPrivate === true });
  auditLog.onAppend((event) => siem.enqueue(event));
  // The daily anchor: the head hash of every chain, kept in the hub DB, the log and (optionally) outside.
  const anchor = () => {
    try {
      for (const written of anchorToday(auditLog, db)) {
        log(`[audit-anchor] ${written.day} chain=${written.chain} seq=${written.headSeq} sha256=${written.headHash}`);
        if (config.auditAnchorUrl !== undefined) {
          fetch(config.auditAnchorUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(written), signal: AbortSignal.timeout(10_000) }).catch(
            (error: unknown) => log(`[audit-anchor] sending failed: ${String(error)}`),
          );
        }
      }
    } catch (error) {
      log(`[audit-anchor] failed: ${String(error)}`);
    }
  };
  const anchorTimer = setInterval(anchor, 60 * 60_000);
  anchorTimer.unref();
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler; access: Access; maxBody: number }> = [];
  const pages = new Map<string, Parameters<Kit["page"]>[1]>();
  const prefixPages: Array<[string, Parameters<Kit["page"]>[1]]> = [];
  const formPages: Array<[string, Parameters<Kit["page"]>[1]]> = [];
  const rawRoutes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Parameters<Kit["raw"]>[2]; access: Access }> = [];
  const billingConfig = input.billing?.config ?? noBilling();
  const billing = makeBilling({
    db,
    config: billingConfig,
    hosted: config.plan === "hosted",
    publicUrl: config.publicUrl,
    stripe: input.billing?.stripe !== undefined ? input.billing.stripe : billingConfig.stripeSecretKey === null ? null : makeStripe(billingConfig.stripeSecretKey),
    invoicing: input.billing?.invoicing ?? horecaosInvoicing(billingConfig.horecaos, log),
    log,
    ...(input.billing?.now === undefined ? {} : { now: input.billing.now }),
  });
  // Every mutating route: per person (or per address when signed out) and per address.
  const writeLimiter = makeLimiter(config.writeLimitPerMinute ?? 120, 60_000, "Too many requests. Wait a minute.");
  const ipWriteLimiter = makeLimiter((config.writeLimitPerMinute ?? 120) * 5, 60_000, "Too many requests. Wait a minute.");

  const compile = (path: string) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    return { keys, pattern };
  };
  const route: Kit["route"] = (method, path, handler, access = "full", options = {}) => {
    routes.push({ method, ...compile(path), handler, access, maxBody: options.maxBody ?? MAX_BODY_BYTES });
  };

  const requireRole: Kit["requireRole"] = (companyId, userId) => {
    const current = store.roleOf(db, companyId, userId);
    if (current === null) throw notFound("No such company.");
    return current;
  };

  const requirePermission: Kit["requirePermission"] = (companyId, userId, permission, scope = {}) => {
    const role = requireRole(companyId, userId);
    const access = roles.accessOf(db, companyId, userId)!;
    if (!rbac.can(access, permission, scope)) {
      throw new HttpError(403, `Your role does not allow this (${rbac.describePermission(permission)}).`, "permission_denied");
    }
    return { role, access };
  };

  const kit: Kit = {
    db,
    mailer,
    config,
    log,
    relay,
    notifier: makeNotifier({ db, mailer, publicUrl: config.publicUrl, log }),
    box,
    requirePermission,
    auditLog,
    siem,
    oauth: input.oauth ?? [],
    route,
    requireRole,
    loginLimiter: makeLimiter(config.loginLimitPer10Minutes ?? 10, 10 * 60_000),
    billing,
    raw: (method, path, handler, access = "full") => void rawRoutes.push({ method, ...compile(path), handler, access }),
    page: (path, handler) => pages.set(path, handler),
    pagePrefix: (prefix, handler) => void prefixPages.push([prefix, handler]),
    formPrefix: (prefix, handler) => void formPages.push([prefix, handler]),
  };

  const sessionOf = (req: IncomingMessage, access: Access): security.SessionInfo => {
    const header = req.headers.authorization ?? "";
    // The app sends a bearer token; the hub's web pages send the session cookie (webSession.ts).
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer !== "" ? bearer : (webSessionToken(req, config.publicUrl) ?? "");
    const session = token === "" ? null : security.sessionForToken(db, token);
    if (session === null) throw new HttpError(401, "Sign in to the hub again.", "signed_out");
    if (access === "full") {
      const gate = policy.twoFactorGate({
        roles: team.rolesOfUser(db, session.user.id),
        totpEnabled: security.totpState(db, session.user.id).enabled,
        sessionVerified: session.mfaAt !== null,
      });
      if (gate === "enroll") {
        throw new HttpError(403, "Owners and admins must set up two-factor authentication first.", "two_factor_setup_required");
      }
      if (gate === "verify") {
        throw new HttpError(403, "Enter the code from your authenticator app.", "two_factor_required");
      }
    }
    return session;
  };

  route("GET", "/health", () => ({ ok: true, service: "zen-hub" }), "public");
  registerAuthRoutes(kit);
  registerCompanyRoutes(kit);
  registerMemoryHostedRoutes(kit);
  registerCompanyObjectRoutes(kit);
  registerShareRoutes(kit);
  registerTeamRoutes(kit);
  registerPasskeyRoutes(kit, config.webauthn ?? webauthnConfig({}, config.publicUrl));
  registerToolchainRoutes(kit);
  registerRunnerAlertRoutes(kit);
  registerDashboardRoutes(kit);
  registerStatsRoutes(kit);
  registerAdminRoutes(kit);
  registerGrowthRoutes(kit);
  registerWebRoutes(kit);
  registerLibraryRoutes(kit);
  registerLibraryPages(kit);
  registerSecurityRoutes(kit);
  registerApprovalRoutes(kit, input.approvalStorage ?? memoryStorage());
  registerBillingRoutes(kit, input.billing?.viesFetch === undefined ? {} : { viesFetch: input.billing.viesFetch });

  const readRaw = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      if (req.method === "GET" || req.method === "HEAD") return resolve("");
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, "Request too large."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  /** Seats follow the paying members: after these succeed, the subscription quantity is synced. */
  const membersChangedBy = (method: string, pathname: string, result: unknown): string | null => {
    if (method === "POST" && pathname === "/v1/invites/accept") {
      const companyId = (result as { companyId?: unknown } | null)?.companyId;
      return typeof companyId === "string" ? companyId : null;
    }
    const match = /^\/v1\/companies\/([^/]+)\/members\/[^/]+$/.exec(pathname);
    return match !== null && (method === "PATCH" || method === "DELETE") ? decodeURIComponent(match[1]!) : null;
  };

  const readBody = (req: IncomingMessage, maxBody: number): Promise<Json> =>
    new Promise((resolve, reject) => {
      if (req.method === "GET" || req.method === "HEAD") return resolve({});
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBody) {
          reject(new HttpError(413, "Request too large."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(bad("Send a JSON object."));
          } else resolve(parsed as Json);
        } catch {
          reject(bad("Send valid JSON."));
        }
      });
      req.on("error", reject);
    });

  const send = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}, cookies: ReadonlyArray<string> = []) => {
    if (cookies.length > 0) res.setHeader("set-cookie", [...cookies]);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(JSON.stringify(value));
  };

  const server = createServer((req, res) => {
    rememberClientIp(req, config.clientIpHeader);
    const ua = req.headers["user-agent"];
    const context: RequestContext = { ip: clientIp(req), userAgent: typeof ua === "string" ? ua : null, deviceId: null, userId: null };
    void requestContext.run(context, () => handle(req, res, context));
  });

  const handle = async (req: IncomingMessage, res: ServerResponse, context: RequestContext) => {
    // Served over https (public address): browsers keep to https for this host for a year.
    if (config.publicUrl.startsWith("https://")) res.setHeader("strict-transport-security", "max-age=31536000");
    const url = new URL(req.url ?? "/", "http://hub.local");
    const cookies: Array<string> = [];
    try {
      const page = req.method === "GET" ? pages.get(url.pathname) : undefined;
      if (page !== undefined) return await page(req, url, res);
      const prefixed = req.method === "GET" ? prefixPages.find(([prefix]) => url.pathname.startsWith(prefix)) : undefined;
      if (prefixed !== undefined) return await prefixed[1](req, url, res);
      const form = req.method === "POST" ? formPages.find(([prefix]) => url.pathname.startsWith(prefix)) : undefined;
      if (form !== undefined) return await form[1](req, url, res);
      const rawMatch = rawRoutes
        .map((candidate) => ({ candidate, found: candidate.pattern.exec(url.pathname) }))
        .find(({ candidate, found }) => found !== null && candidate.method === req.method);
      if (rawMatch !== undefined && rawMatch.found !== null) {
        const rawParams: Record<string, string> = {};
        rawMatch.candidate.keys.forEach((key, index) => {
          rawParams[key] = decodeURIComponent(rawMatch.found![index + 1] ?? "");
        });
        if (req.method !== "GET" && req.method !== "HEAD") ipWriteLimiter(`ip:${clientIp(req)}`);
        const rawSession = rawMatch.candidate.access === "public" ? null : sessionOf(req, rawMatch.candidate.access);
        if (rawSession !== null) {
          context.userId = rawSession.user.id;
          context.deviceId = security.deviceKeyOfSession(db, rawSession.hash)?.keyId ?? `session:${rawSession.id}`;
        }
        const rawBody = await readRaw(req);
        return await rawMatch.candidate.handler({ req, res, params: rawParams, session: rawSession, rawBody });
      }
      const match = routes
        .map((candidate) => ({ candidate, found: candidate.pattern.exec(url.pathname) }))
        .find(({ candidate, found }) => found !== null && candidate.method === req.method);
      if (match === undefined || match.found === null) throw notFound();
      const params: Record<string, string> = {};
      match.candidate.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match.found![index + 1] ?? "");
      });
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (mutating) ipWriteLimiter(`ip:${clientIp(req)}`);
      const session =
        match.candidate.access === "public" ? null : sessionOf(req, match.candidate.access);
      if (session !== null) {
        // Audit events name the device: its key when the app signed in, the session otherwise (web).
        context.userId = session.user.id;
        context.deviceId = security.deviceKeyOfSession(db, session.hash)?.keyId ?? `session:${session.id}`;
      }
      if (mutating) writeLimiter(session === null ? `anon:${clientIp(req)}` : `user:${session.user.id}`);
      // Hosted plan not paid past the grace period: team changes are refused (402), reads go on.
      if (mutating && session !== null) billing.gate(req.method!, url.pathname);
      const body = await readBody(req, match.candidate.maxBody);
      const setCookie = (cookie: string) => void cookies.push(cookie);
      const ctx = { req, params, body, query: url.searchParams, session: session!, setCookie } satisfies Ctx;
      const result = await match.candidate.handler(ctx);
      if (mutating) {
        const changed = membersChangedBy(req.method!, url.pathname, result);
        if (changed !== null) billing.membersChanged(changed);
      }
      if (result instanceof RawBody) {
        res.writeHead(200, { "content-type": result.type, "content-length": String(result.bytes.length), "x-content-type-options": "nosniff", "cache-control": "no-store", ...result.headers });
        res.end(result.bytes);
        return;
      }
      send(res, 200, result ?? { ok: true }, {}, cookies);
    } catch (error) {
      if (error instanceof HttpError) {
        const retryAfter = (error as HttpError & { retryAfter?: number }).retryAfter;
        send(
          res,
          error.status,
          { error: error.message, ...(error.code === null ? {} : { code: error.code }), ...(error as HttpError & { extra?: Json }).extra },
          retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
          cookies,
        );
        return;
      }
      if (error instanceof RelayError) {
        send(res, error.status, { error: error.message });
        return;
      }
      log(`[http] ${req.method} ${url.pathname} failed: ${String(error)}`);
      send(res, 500, { error: "The hub could not do that." });
    }
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://hub.local");
    if (url.pathname === "/v1/runner") relay.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  server.on("close", () => {
    relay.close();
    clearInterval(anchorTimer);
    billing.stop();
  });
  anchor();
  // Long-polls hold a request open for up to 35 s.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return { server, relay, auditLog, siem, billing };
}
