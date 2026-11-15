// Client approval links (v14): upload by a member with chats:trimite, the public page without an
// account (no script, noindex, only that deliverable), files with safe headers and Range, answers
// (approve / request changes) back to the sender with an in-app notice, an e-mail and the audit log,
// expiry, revocation, caps and rate limits.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { checkFile, imageSize, sniff } from "../src/approvalFiles.ts";
import { MIGRATIONS } from "../src/db.ts";
import { cleanupApprovals, isPreviewAgent } from "../src/routes/approvals.ts";
import * as approvals from "../src/storeApprovals.ts";
import { type Hub, makeClient, type Person, startHub } from "./harness.ts";

// 2x3 PNG (IHDR only is enough for sniffing and size).
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]),
  Buffer.alloc(40, 1),
]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(2000, 7)]);
const PDF = Buffer.from("%PDF-1.7\n%test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString("base64");
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

let hub: Hub;
let client: ReturnType<typeof makeClient>;

before(async () => {
  hub = await startHub();
  client = makeClient(hub);
});
after(() => hub.close());

describe("approval files", () => {
  it("decide the type by the bytes and refuse SVG, HTML and unknown binaries", () => {
    assert.deepEqual(sniff(PNG), { kind: "image", mime: "image/png" });
    assert.deepEqual(sniff(MP4), { kind: "video", mime: "video/mp4" });
    assert.deepEqual(sniff(PDF), { kind: "pdf", mime: "application/pdf" });
    assert.deepEqual(imageSize(PNG, "image/png"), { width: 2, height: 3 });
    assert.equal(checkFile({ name: "postare.md", data: b64("# Titlu\nTextul postării, cu ș și ț.") }, "file").kind, "text");
    assert.throws(() => checkFile({ name: "x.svg", data: b64('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, "file"), /only images/);
    assert.throws(() => checkFile({ name: "x.html", data: b64("<!doctype html><script>alert(1)</script>") }, "file"), /only images/);
    assert.throws(() => checkFile({ name: "x.bin", data: b64(Buffer.from([0, 1, 2, 3, 0xff])) }, "file"), /only images/);
    assert.throws(() => checkFile({ name: "logo.pdf", data: b64(PDF) }, "logo"), /logo must be/);
    // A renamed PNG is still a PNG; the name never decides the type.
    assert.equal(checkFile({ name: "../../etc/passwd.txt", data: b64(PNG) }, "file").mime, "image/png");
    assert.equal(checkFile({ name: "../../etc/passwd.txt", data: b64(PNG) }, "file").name, "passwd.txt");
  });
  it("link previews do not count as the client seeing it", () => {
    assert.equal(isPreviewAgent("WhatsApp/2.23.20.0"), true);
    assert.equal(isPreviewAgent("facebookexternalhit/1.1"), true);
    assert.equal(isPreviewAgent(undefined), true);
    assert.equal(isPreviewAgent(BROWSER), false);
  });
  it("is migration v14, between hosted memory (v13) and the platform admin (v15)", () => {
    assert.equal(MIGRATIONS.length, 18);
    for (const index of [9, 10, 15]) assert.equal(MIGRATIONS[index], null);
    assert.match(MIGRATIONS[11]!, /CREATE TABLE billing_accounts/);
    assert.match(MIGRATIONS[12]!, /CREATE TABLE company_memory/);
    assert.match(MIGRATIONS[13]!, /CREATE TABLE client_approvals/);
    assert.match(MIGRATIONS[14]!, /CREATE TABLE hub_staff_v15/);
    assert.match(MIGRATIONS[16]!, /CREATE TABLE user_memory/);
  });
});

describe("approval links over HTTP", () => {
  let alex: Person;
  let maria: Person;
  let gina: Person;
  let outsider: Person;
  let companyId = "";
  let link = "";
  let approvalId = "";
  const call = (...args: Parameters<typeof client.call>) => client.call(...args);
  const page = (path: string, init: RequestInit = {}) =>
    fetch(`${hub.base}${path}`, { redirect: "manual", ...init, headers: { "user-agent": BROWSER, ...(init.headers as Record<string, string> | undefined) } });
  const pathOf = (url: string) => new URL(url).pathname;
  const decide = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    page(`${path}/decizie`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
  const upload = (person: Person, body: Record<string, unknown>) => call(person.token, "POST", `/v1/companies/${companyId}/approvals`, body);

  it("sets up a freelancer's company: owner, a member and a guest", async () => {
    alex = await client.signIn("alex@studio.test");
    maria = await client.signIn("maria@studio.test");
    gina = await client.signIn("gina@studio.test");
    outsider = await client.signIn("ion@other.test");
    companyId = (await call(alex.token, "POST", "/v1/companies", { name: "Studio Alex" })).json.id;
    await client.enableTotp(alex);
    const invite = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { role: "member" });
    await call(maria.token, "POST", "/v1/invites/accept", { token: invite.json.link });
    const guest = await call(alex.token, "POST", `/v1/companies/${companyId}/invites`, { role: "guest" });
    await call(gina.token, "POST", "/v1/invites/accept", { token: guest.json.link });
  });

  it("a member uploads a poster, a video, a PDF and a post text with the client's logo; the link is 256-bit", async () => {
    const created = await upload(maria, {
      title: "Campania de Crăciun",
      note: "Am pus logo-ul sus, cum ai cerut.",
      language: "ro",
      client: { name: "Brutăria Bunicii", color: "#7C3AED", logo: { name: "logo.png", data: b64(PNG) } },
      files: [
        { name: "afis.png", data: b64(PNG) },
        { name: "reel.mp4", data: b64(MP4) },
        { name: "oferta.pdf", data: b64(PDF) },
        { name: "postare.md", data: b64("Crăciunul vine cu cozonac.\n<script>alert(1)</script>") },
      ],
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    link = created.json.url;
    approvalId = created.json.approval.id;
    assert.match(link, /^http:\/\/hub\.test\/aprobare\/[A-Za-z0-9_-]{43}$/);
    assert.equal(created.json.approval.status, "sent");
    assert.equal(created.json.approval.files.length, 4);
    assert.equal(created.json.token, undefined);
    // Only the token's hash is stored.
    const token = link.split("/").pop()!;
    const raw = JSON.stringify(hub.db.prepare("SELECT * FROM client_approvals").all());
    assert.ok(!raw.includes(token));
    const days = (Date.parse(created.json.approval.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14);
    const audit = hub.auditLog.actions(companyId);
    assert.ok(audit.includes("approval.create"));
  });

  it("refuses guests, outsiders, other file types, bad expiry and too many files", async () => {
    const file = [{ name: "a.png", data: b64(PNG) }];
    assert.equal((await upload(gina, { title: "x", client: { name: "C" }, files: file })).json.code, "permission_denied");
    assert.equal((await upload(outsider, { title: "x", client: { name: "C" }, files: file })).status, 404);
    const svg = await upload(maria, { title: "x", client: { name: "C" }, files: [{ name: "a.svg", data: b64("<svg></svg>") }] });
    assert.equal(svg.status, 415);
    assert.equal((await upload(maria, { title: "x", client: { name: "C" }, files: file, expiresInDays: 365 })).status, 400);
    assert.equal((await upload(maria, { title: "x", client: { name: "C" }, files: Array.from({ length: 11 }, () => file[0]) })).status, 400);
    assert.equal((await upload(maria, { title: "x", client: { name: "C", color: "red" }, files: file })).status, 400);
  });

  it("the client's page: no script, noindex, no referrer, only this deliverable, Romanian", async () => {
    const response = await page(pathOf(link));
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    assert.match(csp, /form-action 'self'/);
    assert.match(response.headers.get("x-robots-tag")!, /noindex/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const html = await response.text();
    assert.ok(!/<script/i.test(html.replace("&#60;script&#62;", "")));
    assert.ok(html.includes("&#60;script&#62;alert(1)"), "the post text is escaped");
    assert.match(html, /<meta name="robots" content="noindex/);
    assert.match(html, /Campania de Crăciun/);
    assert.match(html, /Pentru Brutăria Bunicii/);
    assert.match(html, /Am pus logo-ul sus/);
    assert.match(html, /Aprobă/);
    assert.match(html, /Cere modificări/);
    assert.match(html, /1 din 4/);
    // The client's color reaches the page only through a nonce'd style element.
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1];
    assert.match(html, new RegExp(`<style nonce="${nonce}">:root\\{--accent:#7C3AED\\}</style>`));
    const english = await (await page(`${pathOf(link)}?lang=en`)).text();
    assert.match(english, /For Brutăria Bunicii/);
    assert.match(english, /Request changes/);
  });

  it("the first real view marks it Văzut and notifies the sender once; link previews do not", async () => {
    const before = approvals.getApproval(hub.db, approvalId)!;
    assert.equal(before.status, "viewed");
    assert.equal(before.viewCount, 2);
    await fetch(`${hub.base}${pathOf(link)}`, { headers: { "user-agent": "WhatsApp/2.24" } });
    assert.equal(approvals.getApproval(hub.db, approvalId)!.viewCount, 2);
    const notices = (await call(maria.token, "GET", "/v1/notifications")).json.notifications.filter((item: { kind: string }) => item.kind === "approval.viewed");
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /Brutăria Bunicii a deschis „Campania de Crăciun”/);
  });

  it("files: checked type, nosniff, sandbox CSP, PDF and text download, Range for video", async () => {
    const image = await page(`${pathOf(link)}/f/0`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("content-security-policy")!, /sandbox/);
    assert.match(image.headers.get("content-disposition")!, /^inline; filename="afis.png"/);
    const pdf = await page(`${pathOf(link)}/f/2`);
    assert.match(pdf.headers.get("content-disposition")!, /^attachment; filename="oferta.pdf"/);
    const text = await page(`${pathOf(link)}/f/3`);
    assert.match(text.headers.get("content-type")!, /^text\/plain/);
    assert.match(text.headers.get("content-disposition")!, /^attachment/);
    const part = await page(`${pathOf(link)}/f/1`, { headers: { range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-99/${MP4.length}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await page(`${pathOf(link)}/f/9`)).status, 404);
  });

  it("asking for changes needs a comment; another site's form is refused", async () => {
    const empty = await decide(pathOf(link), { decision: "changes", comment: "  " });
    assert.equal(empty.status, 303);
    assert.match(empty.headers.get("location")!, /r=comment-required/);
    const forged = await decide(pathOf(link), { decision: "approved" }, { origin: "https://evil.test" });
    assert.equal(forged.status, 403);
    assert.equal(approvals.getApproval(hub.db, approvalId)!.decidedAt, null);
  });

  it("the client asks for changes: status, comment, in-app notice, e-mail and audit; the link answers once", async () => {
    const answered = await decide(pathOf(link), { decision: "changes", comment: "Logo-ul mai mare, data e 14 decembrie.", name: "Ana" }, { origin: "http://hub.test" });
    assert.equal(answered.status, 303);
    assert.match(answered.headers.get("location")!, /r=changes/);
    const viewed = await call(maria.token, "GET", `/v1/approvals?ids=${approvalId}`);
    assert.equal(viewed.json.approvals[0].status, "changes");
    assert.equal(viewed.json.approvals[0].comment, "Logo-ul mai mare, data e 14 decembrie.");
    assert.equal(viewed.json.approvals[0].decidedByName, "Ana");
    const mail = client.lastMail("maria@studio.test")!;
    assert.match(mail.subject, /Brutăria Bunicii a cerut modificări la „Campania de Crăciun”/);
    assert.match(mail.text, /Logo-ul mai mare/);
    assert.match(mail.html!, /Logo-ul mai mare/);
    const notices = (await call(maria.token, "GET", "/v1/notifications")).json.notifications.map((item: { kind: string }) => item.kind);
    assert.ok(notices.includes("approval.changes"));
    const actions = hub.auditLog.actions(companyId);
    assert.ok(actions.includes("approval.view"));
    assert.ok(actions.includes("approval.changes"));
    const again = await decide(pathOf(link), { decision: "approved" });
    assert.match(again.headers.get("location")!, /r=already/);
    const html = await (await page(`${pathOf(link)}?r=changes`)).text();
    assert.match(html, /Modificări cerute/);
    assert.match(html, /Logo-ul mai mare/);
    assert.doesNotMatch(html, /name="decision"/);
  });

  it("who sees a link: its sender and the company's admins, nobody else", async () => {
    assert.equal((await call(alex.token, "GET", `/v1/approvals?ids=${approvalId}`)).json.approvals.length, 1);
    assert.equal((await call(gina.token, "GET", `/v1/approvals?ids=${approvalId}`)).json.approvals.length, 0);
    assert.equal((await call(outsider.token, "GET", `/v1/approvals?ids=${approvalId}`)).json.approvals.length, 0);
    assert.equal((await call(outsider.token, "POST", `/v1/approvals/${approvalId}/revoke`)).status, 404);
    const listed = await call(alex.token, "GET", `/v1/companies/${companyId}/approvals`);
    assert.equal(listed.json.approvals.length, 1);
    assert.ok(listed.json.storedBytes > 0);
  });

  it("approve, then revoke: the page and files close with the same answer as an unknown link", async () => {
    const second = await upload(maria, { title: "Postare luni", client: { name: "Brutăria Bunicii" }, files: [{ name: "p.png", data: b64(PNG) }] });
    const path = pathOf(second.json.url);
    const approved = await decide(path, { decision: "approved" });
    assert.match(approved.headers.get("location")!, /r=approved/);
    assert.equal((await call(maria.token, "GET", `/v1/approvals?ids=${second.json.approval.id}`)).json.approvals[0].status, "approved");
    assert.match(client.lastMail("maria@studio.test")!.subject, /a aprobat „Postare luni”/);
    const revoked = await call(maria.token, "POST", `/v1/approvals/${second.json.approval.id}/revoke`);
    assert.equal(revoked.json.approval.active, false);
    const closed = await page(path);
    const unknown = await page(`/aprobare/${"A".repeat(43)}`);
    assert.equal(closed.status, 404);
    assert.equal(unknown.status, 404);
    const closedHtml = await closed.text();
    assert.match(closedHtml, /Linkul nu mai e activ/);
    assert.doesNotMatch(closedHtml, /Postare luni/);
    assert.equal((await page(`${path}/f/0`)).status, 404);
  });

  it("expired links lose their files at cleanup and look like unknown ones", async () => {
    const third = await upload(maria, { title: "Expiră", client: { name: "C" }, files: [{ name: "p.png", data: b64(PNG) }], expiresInDays: 1 });
    const id = third.json.approval.id;
    cleanupApprovals({ db: hub.db, log: () => undefined }, { write() {}, read: () => null, remove() {} }, new Date(Date.now() + 2 * 86_400_000));
    assert.notEqual(approvals.getApproval(hub.db, id)!.filesDeletedAt, null);
    assert.equal((await page(pathOf(third.json.url))).status, 404);
  });

  it("caps the space per company", async () => {
    const small = await startHub({ config: { approvalCompanyBytes: 100 } });
    const smallClient = makeClient(small);
    const owner = await smallClient.signIn("owner@small.test");
    const id = (await smallClient.call(owner.token, "POST", "/v1/companies", { name: "Small" })).json.id;
    await smallClient.enableTotp(owner);
    const first = await smallClient.call(owner.token, "POST", `/v1/companies/${id}/approvals`, { title: "a", client: { name: "C" }, files: [{ name: "a.png", data: b64(PNG) }] });
    assert.equal(first.status, 200);
    const full = await smallClient.call(owner.token, "POST", `/v1/companies/${id}/approvals`, { title: "b", client: { name: "C" }, files: [{ name: "a.png", data: b64(PNG) }] });
    assert.equal(full.status, 413);
    assert.equal(full.json.code, "storage_full");
    await small.close();
  });

  it("limits answers per link", async () => {
    const fourth = await upload(maria, { title: "Limită", client: { name: "C" }, files: [{ name: "p.png", data: b64(PNG) }] });
    const path = pathOf(fourth.json.url);
    let last = 0;
    for (let index = 0; index < 12; index += 1) last = (await decide(path, { decision: "changes", comment: "" })).status;
    assert.equal(last, 429);
  });
});
