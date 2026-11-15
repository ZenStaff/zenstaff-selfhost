// Growth API (/v1/growth/*) for the growth team's agents and the partner links (/r/<code>).
// The API takes one bearer token, HUB_GROWTH_TOKEN, compared in constant time; without it the
// whole module is off (404). Wrong tokens are counted per address. Every write goes to the
// platform chain of the tamper-evident audit log, with e-mails masked there.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Kit } from "../app.ts";
import { PLATFORM_CHAIN } from "../auditChain.ts";
import { safeEqualHex, sha256 } from "../crypto.ts";
import * as growth from "../growth.ts";
import { bad, clientIp, HttpError, type Json, makeLimiter, notFound } from "../http.ts";

const MAX_BODY = 16 * 1024;

const LIMITS = {
  name: 120,
  company: 160,
  country: 60,
  source: 60,
  owner: 80,
  notes: 4000,
  consentBasis: 120,
  reason: 300,
  partnerName: 120,
  utm: 100,
} as const;

/** "ana@firma.example" -> "a***@firma.example": the audit log says which entry changed without the address. */
export const maskEmail = (value: string | null) => {
  if (value === null) return null;
  const at = value.lastIndexOf("@");
  return at === -1 ? value : `${value.slice(0, 1)}***${value.slice(at)}`;
};

function text(body: Json, key: string, max: number): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw bad(`${key} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw bad(`${key} is too long (at most ${max} characters).`);
  return trimmed === "" ? null : trimmed;
}

function email(body: Json, key: string): string | null | undefined {
  const value = text(body, key, 254);
  if (value === undefined || value === null) return value;
  const lower = value.toLowerCase();
  if (!growth.EMAIL.test(lower)) throw bad(`${key} is not an e-mail address.`);
  return lower;
}

function isoDate(body: Json, key: string): string | null | undefined {
  const value = text(body, key, 40);
  if (value === undefined || value === null) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw bad(`${key} must be a date (ISO 8601).`);
  return new Date(ms).toISOString();
}

function integer(body: Json, key: string, min: number, max: number): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw bad(`${key} must be a whole number from ${min} to ${max}.`);
  return value;
}

function stage(body: Json): growth.LeadStage | undefined {
  if (!("stage" in body)) return undefined;
  const value = body.stage;
  if (typeof value !== "string" || !(growth.LEAD_STAGES as ReadonlyArray<string>).includes(value)) throw bad(`stage must be one of ${growth.LEAD_STAGES.join(", ")}.`);
  return value as growth.LeadStage;
}

const LEAD_KEYS = ["email", "name", "company", "country", "source", "stage", "seats", "owner", "notes", "nextStepAt", "consentBasis", "lastContactAt"] as const;

/** The lead fields present in the body, validated; unknown fields are refused. */
export function leadPatch(body: Json): Partial<growth.LeadFields> {
  for (const key of Object.keys(body)) if (!(LEAD_KEYS as ReadonlyArray<string>).includes(key)) throw bad(`Unknown field: ${key.slice(0, 40)}.`);
  const patch: Partial<growth.LeadFields> = {};
  const put = <K extends keyof growth.LeadFields>(key: K, value: growth.LeadFields[K] | undefined) => {
    if (value !== undefined) patch[key] = value;
  };
  put("email", email(body, "email"));
  put("name", text(body, "name", LIMITS.name));
  put("company", text(body, "company", LIMITS.company));
  put("country", text(body, "country", LIMITS.country));
  put("source", text(body, "source", LIMITS.source));
  put("stage", stage(body));
  put("seats", integer(body, "seats", 0, 1_000_000));
  put("owner", text(body, "owner", LIMITS.owner));
  put("notes", text(body, "notes", LIMITS.notes));
  put("nextStepAt", isoDate(body, "nextStepAt"));
  put("consentBasis", text(body, "consentBasis", LIMITS.consentBasis));
  put("lastContactAt", isoDate(body, "lastContactAt"));
  return patch;
}

const intParam = (value: string | null, fallback: number, min: number, max: number, name: string) => {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
};

export function registerGrowthRoutes(kit: Kit) {
  const { db, config, route, auditLog, log } = kit;
  const settings = config.growth;
  // Wrong tokens per address: 20 in 10 minutes, then 429 until the window ends.
  const failLimiter = makeLimiter(20, 10 * 60_000, "Too many wrong growth tokens. Wait a few minutes.");
  const expected = settings === undefined ? "" : sha256(settings.token);

  const authorize = (req: IncomingMessage) => {
    if (settings === undefined) throw notFound();
    const key = `growth:${clientIp(req)}`;
    failLimiter.check(key);
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    // Compare digests so the check takes the same time whatever the token length.
    if (given === "" || !safeEqualHex(sha256(given), expected)) {
      failLimiter(key);
      throw new HttpError(401, "The growth API needs the hub's growth token.", "growth_token");
    }
  };

  const audit = (action: string, target: string | null, detail: Record<string, unknown>) =>
    auditLog.append({ companyId: null, chain: PLATFORM_CHAIN, actorUserId: null, actorEmail: null, actorName: "growth API", action: `growth.${action}`, target, detail });

  const options = { maxBody: MAX_BODY };

  // ---- Summary and events ----------------------------------------------------------------------

  route(
    "GET",
    "/v1/growth/summary",
    ({ req, query }) => {
      authorize(req);
      return growth.summary(db, intParam(query.get("days"), 30, 1, 365, "days"));
    },
    "public",
  );

  /** Events the hub can not see itself (download, first_task, payment) come from the night jobs. */
  route(
    "POST",
    "/v1/growth/events",
    ({ req, body }) => {
      authorize(req);
      const event = body.event;
      if (typeof event !== "string" || !(growth.GROWTH_EVENTS as ReadonlyArray<string>).includes(event)) throw bad(`event must be one of ${growth.GROWTH_EVENTS.join(", ")}.`);
      const meta = body.meta ?? null;
      if (meta !== null) {
        if (typeof meta !== "object" || Array.isArray(meta)) throw bad("meta must be an object.");
        for (const value of Object.values(meta as Json)) {
          if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw bad("meta values must be text, numbers or true/false.");
        }
        if (JSON.stringify(meta).length > growth.META_MAX) throw bad(`meta is too large (at most ${growth.META_MAX} bytes).`);
        if (/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i.test(JSON.stringify(meta))) throw bad("meta must not hold e-mail addresses.");
      }
      const id = (key: string, table: "users" | "companies") => {
        const value = text(body, key, 64);
        if (value === undefined || value === null) return null;
        if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(value) === undefined) throw bad(`${key} is not known here.`);
        return value;
      };
      const partnerCode = text(body, "partnerCode", 40);
      if (partnerCode !== undefined && partnerCode !== null && !growth.PARTNER_CODE.test(partnerCode)) throw bad("partnerCode is not a valid code.");
      const eventId = growth.insertEvent(db, event as growth.GrowthEvent, {
        companyId: id("companyId", "companies"),
        userId: id("userId", "users"),
        partnerCode: partnerCode ?? null,
        utmSource: text(body, "utmSource", LIMITS.utm) ?? null,
        utmMedium: text(body, "utmMedium", LIMITS.utm) ?? null,
        utmCampaign: text(body, "utmCampaign", LIMITS.utm) ?? null,
        ...(meta === null ? {} : { meta: meta as Record<string, string | number | boolean | null> }),
      });
      audit("event.record", eventId, { event });
      return { id: eventId, event };
    },
    "public",
    options,
  );

  // ---- Leads -----------------------------------------------------------------------------------

  route(
    "GET",
    "/v1/growth/leads",
    ({ req, query }) => {
      authorize(req);
      const stageValue = query.get("stage");
      if (stageValue !== null && !(growth.LEAD_STAGES as ReadonlyArray<string>).includes(stageValue)) throw bad(`stage must be one of ${growth.LEAD_STAGES.join(", ")}.`);
      const owner = query.get("owner");
      if (owner !== null && owner.length > LIMITS.owner) throw bad("owner is too long.");
      const limit = intParam(query.get("limit"), 50, 1, 200, "limit");
      const offset = intParam(query.get("offset"), 0, 0, 1_000_000, "offset");
      const result = growth.listLeads(db, {
        ...(stageValue === null ? {} : { stage: stageValue as growth.LeadStage }),
        ...(owner === null || owner === "" ? {} : { owner }),
        due: query.get("due") === "1" || query.get("due") === "true",
        limit,
        offset,
      });
      return { ...result, limit, offset };
    },
    "public",
  );

  route(
    "GET",
    "/v1/growth/leads/:id",
    ({ req, params }) => {
      authorize(req);
      const lead = growth.getLead(db, params.id!);
      if (lead === null) throw notFound("No such lead.");
      return lead;
    },
    "public",
  );

  route(
    "POST",
    "/v1/growth/leads",
    ({ req, body }) => {
      authorize(req);
      const patch = leadPatch(body);
      if ((patch.email ?? null) === null && (patch.company ?? null) === null && (patch.name ?? null) === null) throw bad("A lead needs at least an e-mail, a name or a company.");
      if (patch.email != null) {
        const existing = growth.leadByEmail(db, patch.email);
        if (existing !== null) throw Object.assign(new HttpError(409, "A lead with this e-mail already exists.", "lead_exists"), { extra: { id: existing.id } });
      }
      // Someone on the opt-out list stays a lead only as opted out.
      const optedOut = patch.email != null && growth.excludedBy(db, patch.email) !== null;
      const lead = growth.createLead(db, {
        email: null,
        name: null,
        company: null,
        country: null,
        source: null,
        seats: null,
        owner: null,
        notes: null,
        nextStepAt: null,
        consentBasis: null,
        lastContactAt: null,
        ...patch,
        stage: optedOut ? "opted_out" : (patch.stage ?? "new"),
      });
      audit("lead.create", lead.id, { email: maskEmail(lead.email), stage: lead.stage, source: lead.source, owner: lead.owner });
      return { lead, optedOut };
    },
    "public",
    options,
  );

  route(
    "PATCH",
    "/v1/growth/leads/:id",
    ({ req, params, body }) => {
      authorize(req);
      const before = growth.getLead(db, params.id!);
      if (before === null) throw notFound("No such lead.");
      const patch = leadPatch(body);
      if (Object.keys(patch).length === 0) throw bad("Send at least one field to change.");
      if (patch.email != null && patch.email !== before.email) {
        const other = growth.leadByEmail(db, patch.email);
        if (other !== null) throw Object.assign(new HttpError(409, "A lead with this e-mail already exists.", "lead_exists"), { extra: { id: other.id } });
      }
      const emailAfter = patch.email === undefined ? before.email : patch.email;
      const stageAfter = patch.stage ?? before.stage;
      if (emailAfter !== null && stageAfter !== "opted_out" && growth.excludedBy(db, emailAfter) !== null) {
        throw new HttpError(409, "This address is on the opt-out list; the lead stays opted out.", "opted_out");
      }
      const lead = growth.updateLead(db, before.id, patch)!;
      audit("lead.update", lead.id, {
        fields: Object.keys(patch),
        ...(patch.stage !== undefined && patch.stage !== before.stage ? { stage: { from: before.stage, to: patch.stage } } : {}),
        ...(patch.email !== undefined ? { email: maskEmail(lead.email) } : {}),
      });
      return lead;
    },
    "public",
    options,
  );

  // ---- Partner codes ---------------------------------------------------------------------------

  route(
    "GET",
    "/v1/growth/partners",
    ({ req }) => {
      authorize(req);
      return { partners: growth.listPartners(db) };
    },
    "public",
  );

  route(
    "POST",
    "/v1/growth/partners",
    ({ req, body }) => {
      authorize(req);
      const rawCode = text(body, "code", 40);
      const code = rawCode?.toLowerCase() ?? "";
      if (!growth.PARTNER_CODE.test(code)) throw bad("code must be 2-40 characters: lower-case letters, digits and dashes, starting with a letter or digit.");
      const partnerName = text(body, "partnerName", LIMITS.partnerName);
      const partnerEmail = email(body, "partnerEmail");
      const commissionPct = integer(body, "commissionPct", 0, 100);
      if (commissionPct === null) throw bad("commissionPct must be a whole number from 0 to 100.");
      const active = body.active;
      if (active !== undefined && typeof active !== "boolean") throw bad("active must be true or false.");
      if (partnerName === null) throw bad("partnerName can not be empty.");
      if (partnerName === undefined && growth.getPartner(db, code) === null) throw bad("partnerName is required for a new code.");
      const { partner, created } = growth.savePartner(db, {
        code,
        ...(partnerName === undefined ? {} : { partnerName }),
        ...(partnerEmail === undefined ? {} : { partnerEmail }),
        ...(commissionPct === undefined ? {} : { commissionPct }),
        ...(active === undefined ? {} : { active: active as boolean }),
      });
      audit(created ? "partner.create" : "partner.update", partner.code, {
        partnerName: partner.partnerName,
        partnerEmail: maskEmail(partner.partnerEmail),
        commissionPct: partner.commissionPct,
        active: partner.active,
      });
      return { partner, created, link: `${config.publicUrl}/r/${partner.code}` };
    },
    "public",
    options,
  );

  // ---- Opt-outs --------------------------------------------------------------------------------

  route(
    "GET",
    "/v1/growth/optouts",
    ({ req, query }) => {
      authorize(req);
      const limit = intParam(query.get("limit"), 100, 1, 500, "limit");
      const offset = intParam(query.get("offset"), 0, 0, 10_000_000, "offset");
      return { ...growth.listOptouts(db, limit, offset), limit, offset };
    },
    "public",
  );

  route(
    "GET",
    "/v1/growth/optouts/check",
    ({ req, query }) => {
      authorize(req);
      const raw = query.get("email") ?? query.get("domain") ?? "";
      const parsed = growth.exclusionOf(raw);
      if (parsed === null) throw bad("Send ?email= with an e-mail address (or a domain).");
      const match = growth.excludedBy(db, parsed.value);
      return { value: parsed.value, excluded: match !== null, ...(match === null ? {} : { match: { value: match.value, kind: match.kind, createdAt: match.createdAt } }) };
    },
    "public",
  );

  route(
    "POST",
    "/v1/growth/optouts",
    ({ req, body }) => {
      authorize(req);
      const raw = text(body, "email", 254) ?? text(body, "domain", 254) ?? text(body, "value", 254) ?? null;
      const parsed = raw === null ? null : growth.exclusionOf(raw);
      if (parsed === null) throw bad("Send email (an address) or domain.");
      const result = growth.addOptout(db, {
        ...parsed,
        reason: text(body, "reason", LIMITS.reason) ?? null,
        source: text(body, "source", LIMITS.source) ?? null,
      });
      audit("optout.add", parsed.kind === "email" ? maskEmail(parsed.value) : parsed.value, {
        kind: parsed.kind,
        created: result.created,
        leadsMoved: result.leadsMoved,
        source: result.optout.source,
      });
      return result;
    },
    "public",
    options,
  );

  // ---- Partner links: /r/<code> ----------------------------------------------------------------

  if (settings === undefined) return;
  const landing = settings.landingUrl;
  // Like the other public pages: per address, then one counted click per address and code per 30 minutes.
  const pageLimiter = makeLimiter(60, 60_000);
  const clickOnce = makeLimiter(1, 30 * 60_000);
  const redirect = (res: ServerResponse, location: string) => {
    res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end();
  };
  kit.pagePrefix("/r/", (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const ip = clientIp(req);
    pageLimiter(`r:${ip}`);
    let code = "";
    try {
      code = decodeURIComponent(url.pathname.slice(3)).replace(/\/$/, "").toLowerCase();
    } catch {
      code = "";
    }
    const partner = growth.PARTNER_CODE.test(code) ? growth.activePartner(db, code) : null;
    if (partner === null) return redirect(res, landing);
    const target = new URL(landing);
    target.searchParams.set("utm_source", "partner");
    target.searchParams.set("utm_medium", "referral");
    target.searchParams.set("utm_campaign", partner.code);
    let counted = true;
    try {
      clickOnce(`click:${ip}:${partner.code}`);
    } catch {
      counted = false;
    }
    if (counted) {
      growth.recordEvent(db, "partner_click", { partnerCode: partner.code, utmSource: "partner", utmMedium: "referral", utmCampaign: partner.code });
    }
    return redirect(res, target.toString());
  });
  log(`growth: on (API /v1/growth, partner links ${config.publicUrl}/r/<code> -> ${landing})`);
}
