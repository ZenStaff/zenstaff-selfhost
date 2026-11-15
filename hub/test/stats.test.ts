// The operator's "Cifre" page: who may see it, what it counts, and that Cloudflare data is only
// aggregated (the fake Cloudflare here answers like the Analytics Engine SQL and GraphQL APIs).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { lastDays, summarizeReleases, type ReleaseRow } from "../src/stats.ts";
import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

const NOW = Date.UTC(2026, 10, 8, 15);
const TODAY = "2026-11-08";

describe("stats summary", () => {
  it("counts site downloads, update checks and updates separately, and leaves bots out", () => {
    const row = (over: Partial<ReleaseRow>): ReleaseRow => ({ day: TODAY, kind: "download", os: "win", format: "exe", version: "latest", country: "RO", client: "browser", n: 1, ...over });
    const summary = summarizeReleases(
      [
        row({ n: 3 }),
        row({ os: "linux", format: "appimage", country: "DE" }),
        row({ client: "bot", n: 50 }),
        row({ kind: "check", format: "yml", version: "", client: "updater", n: 13 }),
        row({ kind: "check", os: "linux", format: "yml", version: "", client: "updater", n: 6 }),
        row({ kind: "check", format: "yml", version: "", client: "browser", n: 4 }),
        row({ kind: "blockmap", format: "blockmap", version: "0.2.2", client: "updater", n: 4 }),
        row({ kind: "download", os: "linux", format: "deb", version: "0.2.2", client: "updater", n: 1 }),
        row({ kind: "partial", version: "0.2.2", client: "updater", n: 40 }),
      ],
      NOW,
    );
    const today = summary.downloads.at(-1)!;
    assert.equal(summary.downloads.length, 30);
    assert.deepEqual([today.win, today.linux, today.total], [3, 1, 4]);
    assert.deepEqual(summary.downloadsByCountry, [{ country: "RO", n: 3 }, { country: "DE", n: 1 }]);
    assert.equal(summary.checks.at(-1)!.total, 19);
    assert.deepEqual([summary.active.at(-1)!.win, summary.active.at(-1)!.linux], [3, 1]);
    assert.deepEqual(summary.updatesByVersion, [{ version: "0.2.2", win: 2, linux: 1, mac: 0 }]);
  });

  it("lists the last 30 UTC days, oldest first", () => {
    const days = lastDays(30, NOW);
    assert.equal(days.length, 30);
    assert.equal(days.at(-1), TODAY);
    assert.equal(days[0], "2026-10-10");
  });
});

describe("GET /v1/stats", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  let alex: Person;
  let maria: Person;
  const seen: Array<{ url: string; auth: string | null }> = [];

  before(async () => {
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/analytics_engine/sql")) {
        return new Response(JSON.stringify({ data: [{ day: lastDays(1)[0], kind: "download", os: "win", format: "exe", version: "latest", country: "RO", client: "browser", n: "2" }] }));
      }
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count: 9, sum: { visits: 5 }, dimensions: { date: lastDays(1)[0] } }] }] } }, errors: null }));
    }) as typeof fetch;
    hub = await startHub({ config: { stats: { emails: ["alex@zed.test"], cloudflare: { accountId: "acc", token: "secret-token", siteTag: "tag" }, fetch: fakeFetch } } });
    client = makeClient(hub);
    alex = await client.signIn("alex@zed.test");
    maria = await client.signIn("maria@acme.test");
  });
  after(() => hub.close());

  it("is not there for people outside HUB_STATS_EMAILS", async () => {
    assert.equal((await client.call(maria.token, "GET", "/v1/me")).json.canSeeStats, false);
    assert.equal((await client.call(maria.token, "GET", "/v1/stats")).status, 404);
  });

  it("needs a two-factor session even for the operator", async () => {
    assert.equal((await client.call(alex.token, "GET", "/v1/me")).json.canSeeStats, true);
    // Staff without a two-factor session are told why (the platform admin's rule), not given a 404.
    const blocked = await client.call(alex.token, "GET", "/v1/stats");
    assert.deepEqual([blocked.status, blocked.json.code], [403, "admin_two_factor"]);
    await client.enableTotp(alex);
  });

  it("answers hub counts and the Cloudflare numbers, without passing the token on", async () => {
    await client.call(alex.token, "POST", "/v1/companies", { name: "ZED-ZEN" });
    const answer = await client.call(alex.token, "GET", "/v1/stats");
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    const data = answer.json;
    assert.equal(data.hub.accounts, 2);
    assert.equal(data.hub.companies, 1);
    assert.equal(data.hub.members, 1);
    assert.equal(data.hub.devices, 2);
    assert.equal(data.hub.newThisWeek.accounts, 2);
    assert.equal(data.releases.ok, true);
    assert.equal(data.releases.data.downloads.at(-1).total, 2);
    assert.equal(data.landing.data.days.at(-1).visits, 5);
    assert.ok(!JSON.stringify(data).includes("secret-token"));
    assert.ok(!JSON.stringify(data).includes("alex@zed.test"));
    assert.ok(seen.every((call) => call.auth === "Bearer secret-token" && call.url.startsWith("https://api.cloudflare.com/client/v4/")));
    // A reload within five minutes is served from the cache.
    const calls = seen.length;
    await client.call(alex.token, "GET", "/v1/stats");
    assert.equal(seen.length, calls);
  });

  it("serves the page shell at /app/cifre", async () => {
    const page = await fetch(`${hub.base}/app/cifre`);
    assert.equal(page.status, 200);
  });
});

describe("GET /v1/stats without configuration", () => {
  it("is off when HUB_STATS_EMAILS is empty", async () => {
    const hub = await startHub();
    const client = makeClient(hub);
    const person = await client.signIn("alex@zed.test");
    assert.equal((await client.call(person.token, "GET", "/v1/me")).json.canSeeStats, false);
    assert.equal((await client.call(person.token, "GET", "/v1/stats")).status, 404);
    await hub.close();
  });
});
