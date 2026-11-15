// "Cifre": how many people download and use Zen Staff. Only for the hub operator's people (the
// e-mails in HUB_STATS_EMAILS), never for customers. Everything here is an aggregate:
// - hub counts (accounts, companies, members, linked devices) straight from SQLite;
// - downloads and update checks from the `zen-releases-counter` Worker in front of
//   releases.zed-zen.com (Workers Analytics Engine, dataset `zen_releases`; no IP, no raw
//   User-Agent, no ids are stored there, see the zen-stats Worker);
// - landing visits from Cloudflare Web Analytics (cookie-less).
// The Cloudflare token is read-only ("Account Analytics: Read") and never leaves the server.
import type { Db } from "./db.ts";

export interface StatsCloudflare {
  readonly accountId: string;
  readonly token: string;
  /** Analytics Engine dataset written by the Worker (default zen_releases). */
  readonly dataset?: string;
  /** Web Analytics site tag of the landing; unset = no landing card. */
  readonly siteTag?: string;
}

export interface StatsConfig {
  /** Who may open the page (lower-case e-mails). Empty = the page is off. */
  readonly emails: ReadonlyArray<string>;
  readonly cloudflare?: StatsCloudflare;
  /** Tests replace the network. */
  readonly fetch?: typeof fetch;
}

export function statsConfigFromEnv(env: Record<string, string | undefined>): StatsConfig {
  const emails = (env.HUB_STATS_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
  const accountId = env.HUB_STATS_CF_ACCOUNT_ID ?? "";
  const token = env.HUB_STATS_CF_TOKEN ?? "";
  const cloudflare =
    accountId !== "" && token !== ""
      ? {
          accountId,
          token,
          ...(env.HUB_STATS_CF_DATASET ? { dataset: env.HUB_STATS_CF_DATASET } : {}),
          ...(env.HUB_STATS_CF_SITE_TAG ? { siteTag: env.HUB_STATS_CF_SITE_TAG } : {}),
        }
      : undefined;
  return { emails, ...(cloudflare ? { cloudflare } : {}) };
}

export const canSeeStats = (config: StatsConfig | undefined, email: string) =>
  config !== undefined && config.emails.includes(email.toLowerCase());

export const STATS_DAYS = 30;

/** The last `count` UTC days, oldest first, as YYYY-MM-DD. */
export function lastDays(count: number, now = Date.now()): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

// ---- Hub ---------------------------------------------------------------------------------------

export interface HubCounts {
  readonly accounts: number;
  readonly companies: number;
  readonly members: number;
  readonly devices: number;
  readonly newThisWeek: { readonly accounts: number; readonly companies: number; readonly members: number; readonly devices: number };
  /** New accounts per UTC day, last 30 days. */
  readonly accountsByDay: ReadonlyArray<{ readonly day: string; readonly n: number }>;
}

export function hubCounts(db: Db, now = Date.now()): HubCounts {
  const weekAgoIso = new Date(now - 7 * 86_400_000).toISOString();
  const weekAgoMs = now - 7 * 86_400_000;
  const one = (sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const days = lastDays(STATS_DAYS, now);
  const byDay = new Map(
    (db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day").all(days[0]!) as Array<{ day: string; n: number }>).map(
      (row) => [row.day, Number(row.n)],
    ),
  );
  return {
    accounts: one("SELECT COUNT(*) AS n FROM users"),
    companies: one("SELECT COUNT(*) AS n FROM companies"),
    members: one("SELECT COUNT(*) AS n FROM memberships"),
    devices: one("SELECT COUNT(*) AS n FROM device_keys WHERE revoked_at IS NULL"),
    newThisWeek: {
      accounts: one("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", weekAgoIso),
      companies: one("SELECT COUNT(*) AS n FROM companies WHERE created_at >= ?", weekAgoIso),
      members: one("SELECT COUNT(*) AS n FROM memberships WHERE created_at >= ?", weekAgoIso),
      devices: one("SELECT COUNT(*) AS n FROM device_keys WHERE revoked_at IS NULL AND created_at >= ?", weekAgoMs),
    },
    accountsByDay: days.map((day) => ({ day, n: byDay.get(day) ?? 0 })),
  };
}

// ---- Releases (Worker data) ----------------------------------------------------------------------

export interface ReleaseRow {
  readonly day: string;
  readonly kind: string;
  readonly os: string;
  readonly format: string;
  readonly version: string;
  readonly country: string;
  readonly client: string;
  readonly n: number;
}

export interface DayCount {
  readonly day: string;
  readonly win: number;
  readonly linux: number;
  readonly mac: number;
  readonly total: number;
}

export interface ReleaseStats {
  /** Installers downloaded from the site (browsers and scripts; bots and the app's own updates left out). */
  readonly downloads: ReadonlyArray<DayCount>;
  readonly downloadsByFormat: ReadonlyArray<{ readonly format: string; readonly n: number }>;
  /** Update checks from installed apps (latest*.yml, User-Agent electron-builder). */
  readonly checks: ReadonlyArray<DayCount>;
  /** Estimated installs running that day: checks / CHECKS_PER_DAY, rounded up. */
  readonly active: ReadonlyArray<DayCount>;
  /** Updates the apps downloaded, per version: full installers plus differential ones (blockmap / 2). */
  readonly updatesByVersion: ReadonlyArray<{ readonly version: string; readonly win: number; readonly linux: number; readonly mac: number }>;
  readonly downloadsByCountry: ReadonlyArray<{ readonly country: string; readonly n: number }>;
  readonly checksPerDay: number;
}

/** The app checks the feed every ~4 hours while it runs. */
export const CHECKS_PER_DAY = 6;

const osKey = (os: string): "win" | "linux" | "mac" | null => (os === "win" || os === "linux" || os === "mac" ? os : null);

export function summarizeReleases(rows: ReadonlyArray<ReleaseRow>, now = Date.now()): ReleaseStats {
  const days = lastDays(STATS_DAYS, now);
  const blank = () => new Map(days.map((day) => [day, { win: 0, linux: 0, mac: 0 }]));
  const downloads = blank();
  const checks = blank();
  const formats = new Map<string, number>();
  const countries = new Map<string, number>();
  const updates = new Map<string, { win: number; linux: number; mac: number }>();
  for (const row of rows) {
    const os = osKey(row.os);
    if (row.client === "bot") continue;
    if (row.kind === "download" && row.client !== "updater") {
      const day = downloads.get(row.day);
      if (day && os) day[os] += row.n;
      formats.set(row.format, (formats.get(row.format) ?? 0) + row.n);
      countries.set(row.country, (countries.get(row.country) ?? 0) + row.n);
    } else if (row.kind === "check" && row.client === "updater") {
      const day = checks.get(row.day);
      if (day && os) day[os] += row.n;
    } else if (row.client === "updater" && os && (row.kind === "download" || row.kind === "blockmap")) {
      const version = row.version === "" ? "?" : row.version;
      const entry = updates.get(version) ?? { win: 0, linux: 0, mac: 0 };
      entry[os] += row.kind === "blockmap" ? row.n / 2 : row.n;
      updates.set(version, entry);
    }
  }
  const series = (map: Map<string, { win: number; linux: number; mac: number }>, fn = (n: number) => n) =>
    days.map((day) => {
      const value = map.get(day)!;
      const win = fn(value.win);
      const linux = fn(value.linux);
      const mac = fn(value.mac);
      return { day, win, linux, mac, total: win + linux + mac };
    });
  const desc = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const compareVersions = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true });
  return {
    downloads: series(downloads),
    downloadsByFormat: desc(formats).map(([format, n]) => ({ format, n })),
    checks: series(checks),
    active: series(checks, (n) => Math.ceil(n / CHECKS_PER_DAY)),
    updatesByVersion: [...updates.entries()]
      .sort((a, b) => compareVersions(a[0], b[0]))
      .map(([version, value]) => ({ version, win: Math.ceil(value.win), linux: Math.ceil(value.linux), mac: Math.ceil(value.mac) })),
    downloadsByCountry: desc(countries).map(([country, n]) => ({ country, n })),
    checksPerDay: CHECKS_PER_DAY,
  };
}

const API = "https://api.cloudflare.com/client/v4";
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;

async function cfJson(cf: StatsCloudflare, doFetch: typeof fetch, path: string, init: RequestInit): Promise<unknown> {
  const response = await doFetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cf.token}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cloudflare answered ${response.status}.`);
  return JSON.parse(text) as unknown;
}

export async function fetchReleaseRows(cf: StatsCloudflare, doFetch: typeof fetch): Promise<ReleaseRow[]> {
  const dataset = cf.dataset ?? "zen_releases";
  if (!SAFE_NAME.test(dataset)) throw new Error("Invalid dataset name.");
  const sql =
    `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, blob1 AS kind, blob2 AS os, blob3 AS format, blob4 AS version, ` +
    `blob5 AS country, blob6 AS client, SUM(_sample_interval) AS n FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '${STATS_DAYS}' DAY GROUP BY day, kind, os, format, version, country, client LIMIT 20000 FORMAT JSON`;
  const body = (await cfJson(cf, doFetch, `/accounts/${encodeURIComponent(cf.accountId)}/analytics_engine/sql`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: sql,
  })) as { data?: Array<Record<string, unknown>> };
  return (body.data ?? []).map((row) => ({
    day: String(row.day ?? ""),
    kind: String(row.kind ?? ""),
    os: String(row.os ?? ""),
    format: String(row.format ?? ""),
    version: String(row.version ?? ""),
    country: String(row.country ?? ""),
    client: String(row.client ?? ""),
    n: Number(row.n ?? 0),
  }));
}

export interface LandingStats {
  readonly days: ReadonlyArray<{ readonly day: string; readonly visits: number; readonly views: number }>;
}

export async function fetchLanding(cf: StatsCloudflare, doFetch: typeof fetch, now = Date.now()): Promise<LandingStats> {
  const days = lastDays(STATS_DAYS, now);
  const query = `query($a: String!, $t: String!, $s: Date!) { viewer { accounts(filter: { accountTag: $a }) {
    rumPageloadEventsAdaptiveGroups(limit: 1000, filter: { siteTag: $t, date_geq: $s }, orderBy: [date_ASC]) { count sum { visits } dimensions { date } } } } }`;
  const body = (await cfJson(cf, doFetch, "/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { a: cf.accountId, t: cf.siteTag, s: days[0] } }),
  })) as {
    data?: { viewer?: { accounts?: Array<{ rumPageloadEventsAdaptiveGroups?: Array<{ count: number; sum: { visits: number }; dimensions: { date: string } }> }> } };
    errors?: unknown[] | null;
  };
  if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error("Cloudflare Web Analytics refused the query.");
  const groups = body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? [];
  const byDay = new Map(groups.map((group) => [group.dimensions.date, group]));
  return { days: days.map((day) => ({ day, visits: Number(byDay.get(day)?.sum.visits ?? 0), views: Number(byDay.get(day)?.count ?? 0) })) };
}

// ---- The page's answer, with a short cache so reloading the page does not hit Cloudflare -------

type Part<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: "not_configured" | "unavailable" };

export interface StatsAnswer {
  readonly generatedAt: string;
  readonly days: number;
  readonly hub: HubCounts;
  readonly releases: Part<ReleaseStats>;
  readonly landing: Part<LandingStats>;
}

const CACHE_MS = 5 * 60_000;

export function makeStats(config: StatsConfig | undefined, db: Db, log: (line: string) => void) {
  let cached: { at: number; releases: Part<ReleaseStats>; landing: Part<LandingStats> } | null = null;
  const doFetch = config?.fetch ?? fetch;
  const remote = async (now: number) => {
    if (cached !== null && now - cached.at < CACHE_MS) return cached;
    const cf = config?.cloudflare;
    const releases: Part<ReleaseStats> = cf
      ? await fetchReleaseRows(cf, doFetch)
          .then((rows) => ({ ok: true as const, data: summarizeReleases(rows, now) }))
          .catch((error: unknown) => {
            log(`stats: releases unavailable (${error instanceof Error ? error.message : "error"})`);
            return { ok: false as const, reason: "unavailable" as const };
          })
      : { ok: false, reason: "not_configured" };
    const landing: Part<LandingStats> =
      cf && cf.siteTag
        ? await fetchLanding(cf, doFetch, now)
            .then((data) => ({ ok: true as const, data }))
            .catch((error: unknown) => {
              log(`stats: landing unavailable (${error instanceof Error ? error.message : "error"})`);
              return { ok: false as const, reason: "unavailable" as const };
            })
        : { ok: false, reason: "not_configured" };
    // Failures are not cached, so the next reload tries again.
    if (releases.ok || landing.ok || !cf) cached = { at: now, releases, landing };
    return { releases, landing };
  };
  return async (now = Date.now()): Promise<StatsAnswer> => {
    const { releases, landing } = await remote(now);
    return { generatedAt: new Date(now).toISOString(), days: STATS_DAYS, hub: hubCounts(db, now), releases, landing };
  };
}
