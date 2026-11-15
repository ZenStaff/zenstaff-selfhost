// The toolchain advisories file (blocked tool versions), produced nightly by the scanner in the
// app repo (`osvScanner.ts`: OSV.dev + NVD) and published here by the night job with
// `PUT /v1/toolchains/advisories` (bearer HUB_ADVISORIES_TOKEN). Apps read it without signing in
// (`GET`, ZEN_TOOLCHAIN_ADVISORIES_URL) and never accept a file older than the one they cached.
import { createHash } from "node:crypto";

import type { Kit } from "../app.ts";
import { safeEqualHex, sha256 } from "../crypto.ts";
import { bad, HttpError, type Json } from "../http.ts";

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^v?\d+(\.\d+)*([-+][0-9A-Za-z.+-]*)?$/;
const RANGE = /^[0-9A-Za-z.*x^~<>=| +-]{1,120}$/;
const ADVISORY_ID = /^[A-Za-z0-9._:-]{1,80}$/;

/** Checks the file's shape strictly; returns it re-serialized (only known fields survive). */
export function validateAdvisoryFile(body: Json): Json {
  if (body.version !== 1) throw bad("version must be 1.");
  const generatedAt = typeof body.generatedAt === "string" ? body.generatedAt : "";
  if (Number.isNaN(Date.parse(generatedAt))) throw bad("generatedAt must be an ISO date.");
  if (typeof body.source !== "string" || body.source.length === 0 || body.source.length > 80) throw bad("source is required.");
  if (typeof body.tools !== "object" || body.tools === null || Array.isArray(body.tools)) throw bad("tools must be an object.");
  const tools: Record<string, Json> = {};
  for (const [id, raw] of Object.entries(body.tools as Record<string, unknown>)) {
    if (!TOOL_ID.test(id)) throw bad(`Bad tool id ${id.slice(0, 40)}.`);
    const tool = raw as { minSafeVersion?: unknown; blockedVersions?: unknown };
    if (typeof tool !== "object" || tool === null) throw bad(`${id}: not an object.`);
    if (tool.minSafeVersion !== undefined && (typeof tool.minSafeVersion !== "string" || !VERSION.test(tool.minSafeVersion))) {
      throw bad(`${id}: minSafeVersion is not a version.`);
    }
    if (!Array.isArray(tool.blockedVersions)) throw bad(`${id}: blockedVersions must be a list.`);
    const blockedVersions = tool.blockedVersions.map((item: unknown) => {
      const entry = item as { version?: unknown; reason?: unknown; advisories?: unknown };
      if (typeof entry?.version !== "string" || !RANGE.test(entry.version)) throw bad(`${id}: bad blocked version.`);
      if (typeof entry.reason !== "string" || entry.reason.length > 500) throw bad(`${id}: bad reason.`);
      const advisories = entry.advisories === undefined ? undefined : entry.advisories;
      if (advisories !== undefined && (!Array.isArray(advisories) || !advisories.every((a) => typeof a === "string" && ADVISORY_ID.test(a)))) {
        throw bad(`${id}: bad advisory ids.`);
      }
      return { version: entry.version, reason: entry.reason, ...(advisories === undefined ? {} : { advisories }) };
    });
    tools[id] = { ...(tool.minSafeVersion === undefined ? {} : { minSafeVersion: tool.minSafeVersion }), blockedVersions };
  }
  return { version: 1, generatedAt: new Date(generatedAt).toISOString(), source: body.source, tools };
}

export function registerToolchainRoutes(kit: Kit) {
  const { db, config, route, log } = kit;

  route(
    "GET",
    "/v1/toolchains/advisories",
    () => {
      const row = db.prepare("SELECT body FROM toolchain_advisories WHERE id = 1").get() as { body: string } | undefined;
      if (row === undefined) throw new HttpError(404, "No advisories have been published yet.");
      return JSON.parse(row.body) as unknown;
    },
    "public",
  );

  route(
    "PUT",
    "/v1/toolchains/advisories",
    ({ req, body }) => {
      const expected = config.advisoriesToken;
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      // Compare digests so the check takes the same time whatever the token length.
      if (expected === undefined || expected === "" || given === "" || !safeEqualHex(sha256(given), sha256(expected))) {
        throw new HttpError(401, "Publishing advisories needs the hub's advisories token.");
      }
      const file = validateAdvisoryFile(body);
      const current = db.prepare("SELECT generated_at FROM toolchain_advisories WHERE id = 1").get() as
        | { generated_at: string }
        | undefined;
      if (current !== undefined && Date.parse(current.generated_at) > Date.parse(file.generatedAt as string)) {
        throw new HttpError(409, "A newer advisories file is already published.");
      }
      const text = JSON.stringify(file);
      const digest = createHash("sha256").update(text).digest("hex");
      db.prepare(
        `INSERT INTO toolchain_advisories (id, body, sha256, generated_at, published_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, sha256 = excluded.sha256,
           generated_at = excluded.generated_at, published_at = excluded.published_at`,
      ).run(text, digest, file.generatedAt as string, new Date().toISOString());
      const tools = Object.keys(file.tools as Json).length;
      log(`[advisories] published ${file.generatedAt as string} (${tools} tools with blocked versions)`);
      return { ok: true, sha256: digest, tools };
    },
    "public",
  );
}
