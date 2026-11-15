// The community library end to end: a signed submission, the automatic checks, the reviewer queue
// (role and two-factor), decisions with notes, the public catalog in the registry format, archives,
// installs, share and author pages, reports, unpublishing, updates going through review again and
// the audit log.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { submissionDigest, submissionStatement } from "../src/routes/library.ts";
import * as lib from "../src/storeLibrary.ts";
import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

let hub: Hub;
let client: ReturnType<typeof makeClient>;
let ana: Person;
let reviewer: Person;
let other: Person;

const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex").toString("base64");

const files = (prompt = "Scrie oferta zilei pentru {{restaurant}}.", extra: Record<string, unknown> = {}) => ({
  "workflow.json": Buffer.from(
    JSON.stringify({
      id: "oferta-zilei",
      name: "Oferta zilei",
      description: "Scrie oferta zilei pentru restaurant.",
      category: "social",
      icon: "utensils",
      version: "1.0.0",
      author: "Ana Pop",
      output: "Textul postării.",
      inputs: [{ id: "restaurant", label: "Restaurant", type: "text", required: true }],
      ...extra,
    }),
  ).toString("base64"),
  "prompt.md": Buffer.from(prompt).toString("base64"),
});

const meta = (extra: Record<string, unknown> = {}) => ({
  title: "Oferta zilei",
  description: "Postarea cu oferta zilei, gata de pus pe Facebook.",
  category: "social",
  icon: "utensils",
  licence: "MIT",
  language: "ro",
  changelog: "Prima versiune.",
  sampleOutput: "Un text de postare și trei variante de titlu.",
  ...extra,
});

/** A submission body signed by the person's device, as the app sends it. */
const submission = (person: Person, input: { packId?: string; version?: string; files?: Record<string, string>; meta?: Record<string, unknown>; screenshots?: Array<unknown>; ts?: number }) => {
  const packId = input.packId ?? "oferta-zilei";
  const version = input.version ?? "1.0.0";
  const body = { packId, version, meta: input.meta ?? meta(), files: input.files ?? files(), screenshots: input.screenshots ?? [{ name: "postare.png", mime: "image/png", data: PNG }] };
  const ts = input.ts ?? Date.now();
  const statement = submissionStatement({ packId, version, digest: submissionDigest(body), by: person.userId, ts });
  return { ...body, ts, signature: client.signStatement(person, statement) };
};

before(async () => {
  hub = await startHub({ config: { libraryReviewers: ["rev@zen.test"] } });
  client = makeClient(hub);
  ana = await client.signIn("ana@example.test");
  other = await client.signIn("ion@example.test");
  reviewer = await client.signIn("rev@zen.test");
});
after(() => hub.close());

describe("community library", () => {
  let versionId = "";
  let slug = "";

  it("refuses an unsigned or tampered submission", async () => {
    const signed = submission(ana, {});
    const tampered = { ...signed, files: files("Altceva.") };
    assert.equal((await client.call(ana.token, "POST", "/v1/library/submissions", tampered)).status, 400);
    assert.equal((await client.call(ana.token, "POST", "/v1/library/submissions", { ...signed, signature: "x" })).status, 400);
    const stale = submission(ana, { ts: Date.now() - 10 * 60_000 });
    assert.equal((await client.call(ana.token, "POST", "/v1/library/submissions", stale)).status, 400);
  });

  it("refuses a pack that fails the automatic checks, with the reasons", async () => {
    const leaky = submission(ana, { files: { ...files(), "notes.md": Buffer.from("key AKIAABCDEFGHIJKLMNOP").toString("base64") } });
    const refused = await client.call(ana.token, "POST", "/v1/library/submissions", leaky);
    assert.equal(refused.status, 422);
    assert.equal(refused.json.code, "checks_failed");
    assert.equal(refused.json.checks.find((check: { id: string }) => check.id === "secrets").level, "fail");
    const unattended = submission(ana, { files: files(undefined, { unattended: { commands: ["curl"] } }) });
    assert.equal((await client.call(ana.token, "POST", "/v1/library/submissions", unattended)).status, 422);
    const escape = await client.call(ana.token, "POST", "/v1/library/submissions", submission(ana, { files: { ...files(), "../x.md": "eA==" } }));
    assert.equal(escape.status, 400);
  });

  it("accepts a clean signed submission as pending, not yet public", async () => {
    const sent = await client.call(ana.token, "POST", "/v1/library/submissions", submission(ana, {}));
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.status, "pending");
    versionId = sent.json.id;
    slug = sent.json.slug;
    assert.equal(slug, "oferta-zilei");
    const catalog = await client.call(null, "GET", "/v1/library/catalog");
    assert.deepEqual(catalog.json.entries, []);
    assert.equal((await fetch(`${hub.base}/p/${slug}`)).status, 404);
    const mine = await client.call(ana.token, "GET", "/v1/library/me");
    assert.equal(mine.json.reviewer, false);
    assert.equal(mine.json.packs[0].versions[0].status, "pending");
  });

  it("keeps the queue to reviewers with two-factor on", async () => {
    assert.equal((await client.call(ana.token, "GET", "/v1/library/review/queue")).status, 403);
    const noTotp = await client.call(reviewer.token, "GET", "/v1/library/review/queue");
    assert.equal(noTotp.status, 403);
    assert.equal(noTotp.json.code, "two_factor_setup_required");
    await client.enableTotp(reviewer);
    const queue = await client.call(reviewer.token, "GET", "/v1/library/review/queue");
    assert.equal(queue.status, 200, JSON.stringify(queue.json));
    assert.equal(queue.json.items.length, 1);
    assert.equal(queue.json.items[0].author.name.length > 0, true);
    assert.equal((await client.call(reviewer.token, "GET", "/v1/library/me")).json.reviewer, true);
  });

  it("shows the reviewer the checks, the files, the images and a sandbox test link", async () => {
    const detail = await client.call(reviewer.token, "GET", `/v1/library/review/versions/${versionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.checks.length, 6);
    assert.equal(detail.json.diffAgainst, null);
    assert.deepEqual(detail.json.diff.map((file: { change: string }) => file.change), ["added", "added"]);
    assert.match(detail.json.screenshots[0].src, /^data:image\/png;base64,/);
    const preview = await client.call(reviewer.token, "POST", `/v1/library/review/versions/${versionId}/preview`);
    assert.equal(preview.status, 200);
    assert.ok(preview.json.steps.some((step: string) => step.includes(preview.json.url)));
    const path = new URL(preview.json.url).pathname;
    const index = await client.call(null, "GET", path);
    assert.equal(index.json.entries[0].id, "oferta-zilei");
    const archive = Buffer.from(await (await fetch(`${hub.base}${path.replace("catalog.json", "pack.tar.gz")}`)).arrayBuffer());
    assert.equal(createHash("sha256").update(archive).digest("hex"), index.json.entries[0].download.sha256);
    assert.equal((await client.call(null, "GET", "/v1/library/preview/nope/catalog.json")).status, 404);
  });

  it("asks for changes with a note the author sees", async () => {
    assert.equal((await client.call(reviewer.token, "POST", `/v1/library/review/versions/${versionId}/decision`, { decision: "changes" })).status, 400);
    const decided = await client.call(reviewer.token, "POST", `/v1/library/review/versions/${versionId}/decision`, { decision: "changes", note: "Adaugă un exemplu de răspuns." });
    assert.equal(decided.json.status, "changes_requested");
    const mine = await client.call(ana.token, "GET", "/v1/library/me");
    assert.equal(mine.json.packs[0].versions[0].status, "changes_requested");
    assert.equal(mine.json.packs[0].versions[0].reviewNote, "Adaugă un exemplu de răspuns.");
    const notes = await client.call(ana.token, "GET", "/v1/notifications");
    assert.ok(JSON.stringify(notes.json).includes("modificări"));
  });

  it("publishes the fixed version: catalog, archive, share and author pages", async () => {
    const sent = await client.call(ana.token, "POST", "/v1/library/submissions", submission(ana, { files: files("Scrie oferta zilei pentru {{restaurant}}. Exemplu: Ciorbă de burtă 25 lei.") }));
    assert.equal(sent.status, 200);
    versionId = sent.json.id;
    const approved = await client.call(reviewer.token, "POST", `/v1/library/review/versions/${versionId}/decision`, { decision: "approve", note: "" });
    assert.equal(approved.json.status, "published");
    const catalog = await client.call(null, "GET", "/v1/library/catalog");
    const entry = catalog.json.entries[0];
    assert.equal(entry.id, "oferta-zilei");
    assert.equal(entry.kind, "pack");
    assert.deepEqual(entry.tags, ["community"]);
    assert.equal(entry.community.verified, true);
    assert.equal(entry.community.origin, "community");
    assert.equal(entry.community.shareUrl, `http://hub.test/p/${slug}`);
    const archive = Buffer.from(await (await fetch(new URL(entry.download.url, `${hub.base}/v1/library/catalog`))).arrayBuffer());
    assert.equal(createHash("sha256").update(archive).digest("hex"), entry.download.sha256);
    const image = await fetch(new URL(entry.community.screenshots[0], `${hub.base}/v1/library/catalog`));
    assert.equal(image.headers.get("content-type"), "image/png");
    const page = await fetch(`${hub.base}/p/${slug}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Oferta zilei/);
    assert.match(html, /Verificat de Zen/);
    assert.match(html, /zen:\/\/library\?install=oferta-zilei/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const author = entry.community.author.slug;
    assert.equal((await fetch(`${hub.base}/a/${author}`)).status, 200);
  });

  it("counts installs once per person and shows them as credit", async () => {
    for (const person of [ana, other, other]) await fetch(`${hub.base}/v1/library/packs/${slug}/install`, { method: "POST", headers: { authorization: `Bearer ${person.token}` } });
    const counted = await client.call(null, "POST", `/v1/library/packs/${slug}/install`);
    assert.equal(counted.json.installs, 3);
    const author = await client.call(null, "GET", `/v1/library/authors/${(await client.call(null, "GET", `/v1/library/packs/${slug}`)).json.community.author.slug}`);
    assert.equal(author.json.totalInstalls, 3);
  });

  it("lets the author name themselves and a reviewer feature the pack", async () => {
    const renamed = await client.call(ana.token, "PUT", "/v1/library/me/author", { displayName: "Ana Pop", company: "Bistro Ana" });
    assert.equal(renamed.json.author.name, "Ana Pop");
    await client.call(reviewer.token, "POST", `/v1/library/review/packs/${slug}/featured`, { featured: true });
    const html = await (await fetch(`${hub.base}/p/${slug}`)).text();
    assert.match(html, /de <a href="\/a\/[^"]+">Ana Pop<\/a> · Bistro Ana · 3 instalări/);
    assert.match(html, /Recomandat/);
    // English by ?lang or by the browser's language; caches keep one copy per Accept-Language.
    const en = await fetch(`${hub.base}/p/${slug}`, { headers: { "accept-language": "en-US,en;q=0.9" } });
    assert.equal(en.headers.get("vary"), "accept-language");
    const enHtml = await en.text();
    assert.match(enHtml, /<html lang="en">/);
    assert.match(enHtml, /by <a href="\/a\/[^"]+">Ana Pop<\/a> · Bistro Ana · 3 installs/);
    assert.match(enHtml, /Reviewed by Zen/);
    assert.match(enHtml, /href="\/p\/[^"?]+\?lang=ro"/, "a link to the Romanian page");
    assert.match(await (await fetch(`${hub.base}/p/${slug}?lang=ro`, { headers: { "accept-language": "en" } })).text(), /Verificat de Zen/);
  });

  it("sends an update through review again; the old version stays public meanwhile", async () => {
    const same = await client.call(ana.token, "POST", "/v1/library/submissions", submission(ana, {}));
    assert.equal(same.status, 409);
    const changedRequires = files(undefined, { requires: { tools: [{ id: "pandoc" }] } });
    const update = await client.call(ana.token, "POST", "/v1/library/submissions", submission(ana, { version: "1.1.0", files: changedRequires, meta: meta({ changelog: "Cu pandoc." }) }));
    assert.equal(update.status, 200);
    assert.equal((await client.call(null, "GET", "/v1/library/catalog")).json.entries[0].version, "1.0.0");
    const detail = await client.call(reviewer.token, "GET", `/v1/library/review/versions/${update.json.id}`);
    assert.equal(detail.json.diffAgainst, "1.0.0");
    assert.equal(detail.json.diff[0].change, "changed");
    await client.call(reviewer.token, "POST", `/v1/library/review/versions/${update.json.id}/decision`, { decision: "approve" });
    assert.equal((await client.call(null, "GET", "/v1/library/catalog")).json.entries[0].version, "1.1.0");
  });

  it("refuses another author's pack id and a reviewer's own pack", async () => {
    const taken = await client.call(other.token, "POST", "/v1/library/submissions", submission(other, { version: "9.0.0" }));
    assert.equal(taken.status, 409);
    const own = await client.call(reviewer.token, "POST", "/v1/library/submissions", submission(reviewer, { packId: "fluxul-meu", files: { ...files(), "workflow.json": Buffer.from(JSON.parse(Buffer.from(files()["workflow.json"], "base64").toString()) && JSON.stringify({ ...JSON.parse(Buffer.from(files()["workflow.json"], "base64").toString()), id: "fluxul-meu" })).toString("base64") } }));
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal((await client.call(reviewer.token, "POST", `/v1/library/review/versions/${own.json.id}/decision`, { decision: "approve" })).status, 403);
  });

  it("takes reports into the queue and unpublishes with a warning for installed copies", async () => {
    assert.equal((await client.call(null, "POST", `/v1/library/packs/${slug}/report`, { reason: "unsafe" })).status, 401);
    const report = await client.call(other.token, "POST", `/v1/library/packs/${slug}/report`, { reason: "unsafe", detail: "Cere parola de Facebook." });
    assert.equal(report.status, 200);
    const queue = await client.call(reviewer.token, "GET", "/v1/library/review/queue");
    assert.equal(queue.json.openReports, 1);
    const unpublished = await client.call(reviewer.token, "POST", `/v1/library/review/packs/${slug}/unpublish`, { reason: "Cere parole." });
    assert.equal(unpublished.json.state, "unpublished");
    const catalog = await client.call(null, "GET", "/v1/library/catalog");
    assert.deepEqual(catalog.json.entries, []);
    assert.deepEqual(catalog.json.withdrawn, [{ id: "oferta-zilei", slug, reason: "Cere parole." }]);
    assert.equal((await fetch(`${hub.base}/p/${slug}`)).status, 404);
    const reports = await client.call(reviewer.token, "GET", "/v1/library/review/reports?status=open");
    assert.equal((await client.call(reviewer.token, "POST", `/v1/library/review/reports/${reports.json.reports[0].id}/resolve`, { resolution: "Scos din bibliotecă." })).status, 200);
  });

  it("writes every step to the audit log", async () => {
    const auditLog = await client.call(reviewer.token, "GET", "/v1/library/review/audit");
    const actions = auditLog.json.entries.map((entry: { action: string }) => entry.action);
    for (const action of ["library.submission.create", "library.submission.refused", "library.review.changes", "library.review.approve", "library.review.preview", "library.pack.feature", "library.report.create", "library.pack.unpublish", "library.report.resolve", "library.author.update"]) {
      assert.ok(actions.includes(action), action);
    }
    assert.equal((await client.call(ana.token, "GET", "/v1/library/review/audit")).status, 403);
  });

  it("keeps reviewers in hub_staff too", () => {
    lib.addReviewer(hub.db, other.userId, null);
    assert.equal(lib.isReviewer(hub.db, { id: other.userId, email: other.email }, []), true);
    assert.equal(lib.isReviewer(hub.db, { id: ana.userId, email: ana.email }, []), false);
  });
});
