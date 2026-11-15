// The sign-in and invitation e-mails: Romanian by default, English for accounts set to en, an HTML
// part with the logo and one button, and names escaped (people type them).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ZEN_DOWNLOADS, inviterLabel } from "../src/downloads.ts";
import { escapeHtml, inviteMail, mailLogoUrl, signInMail } from "../src/mailTemplates.ts";
import * as team from "../src/storeTeam.ts";
import { type Hub, makeClient, startHub } from "./harness.ts";

const PUB = "https://hub.example";

describe("e-mail templates", () => {
  it("the sign-in e-mail is Romanian unless the account chose English", () => {
    const ro = signInMail(null, { code: "123456", link: `${PUB}/v1/auth/link?l=x`, publicUrl: PUB });
    assert.match(ro.subject, /^Codul tău de intrare în Zen Staff: 123456$/);
    assert.match(ro.text, /Codul tău de intrare este 123456/);
    assert.match(ro.html, /<html lang="ro">/);
    assert.match(ro.html, /Aprobă intrarea/);
    assert.match(ro.html, /background:#E2401E/, "the vermilion button");
    assert.ok(ro.html.includes(mailLogoUrl(PUB)));
    assert.equal(signInMail("ro", { code: "1", link: "l", publicUrl: PUB }).subject.startsWith("Codul"), true);
    const en = signInMail("en", { code: "654321", link: `${PUB}/l`, publicUrl: PUB });
    assert.match(en.subject, /^Your Zen Staff sign-in code: 654321$/);
    assert.match(en.html, /<html lang="en">/);
    assert.match(en.html, /Approve the sign-in/);
  });

  it("the invitation names who invites, the company and the role, escaped", () => {
    const input = { inviterName: "Ana <b>", companyName: `Casa "Verde" & Co`, role: "member", email: "m@x.example", link: `${PUB}/invite#t`, publicUrl: PUB };
    const ro = inviteMail(null, input);
    assert.match(ro.subject, /te-a invitat în Casa "Verde" & Co pe Zen Staff/);
    assert.match(ro.text, /ca Membru/);
    // Someone without the app: the download links and the three steps, never the word "hub".
    assert.ok(ro.html.includes(ZEN_DOWNLOADS.windows));
    assert.ok(ro.html.includes(ZEN_DOWNLOADS.linuxAppImage));
    assert.ok(ro.html.includes(ZEN_DOWNLOADS.linuxDeb));
    assert.ok(ro.text.includes(ZEN_DOWNLOADS.windows));
    assert.match(ro.text, /Am primit o invitație/);
    assert.match(ro.html, /Deschide invitația/);
    assert.doesNotMatch(`${ro.text}${ro.html}`.replaceAll(PUB, "").replaceAll(PUB.replace(/^https?:\/\//, ""), ""), /\bhub\b/i);
    assert.ok(ro.html.includes("Ana &lt;b&gt;"));
    assert.ok(ro.html.includes("Casa &quot;Verde&quot; &amp; Co"));
    assert.ok(!ro.html.includes("<b>Ana <b>"), "names never become markup");
    assert.ok(ro.html.includes(`href="${PUB}/invite#t"`));
    const en = inviteMail("en", { ...input, role: "guest" });
    assert.match(en.subject, /invited you to/);
    assert.match(en.text, /as Guest/);
    assert.match(en.text, /I was invited/);
    assert.doesNotMatch(`${en.text}${en.html}`.replaceAll(PUB, "").replaceAll(PUB.replace(/^https?:\/\//, ""), ""), /\bhub\b/i);
    // An account without a name: the address, not "ion.popa".
    const unnamed = inviteMail(null, { ...input, inviterName: "ion.popa", inviterEmail: "ion.popa@firma.example" });
    assert.match(unnamed.subject, /^ion\.popa@firma\.example te-a invitat/);
    assert.equal(inviterLabel("Ion Popa", "ion.popa@firma.example"), "Ion Popa");
    assert.equal(escapeHtml(`<'&">`), "&lt;&#39;&amp;&quot;&gt;");
  });
});

describe("e-mails sent by the hub", () => {
  let hub: Hub;
  let client: ReturnType<typeof makeClient>;
  before(async () => {
    hub = await startHub();
    client = makeClient(hub);
  });
  after(() => hub.close());

  it("sign-in and invitation e-mails follow the recipient's account language, with an HTML part", async () => {
    const owner = await client.signIn("owner@lang.test");
    const ro = client.lastMail("owner@lang.test")!;
    assert.match(ro.subject, /^Codul tău de intrare/);
    assert.match(ro.html ?? "", /Aprobă intrarea/);
    team.setPreferences(hub.db, owner.userId, { language: "en" });
    await client.call(null, "POST", "/v1/auth/start", { email: "owner@lang.test" });
    assert.match(client.lastMail("owner@lang.test")!.subject, /^Your Zen Staff sign-in code/);

    const company = (await client.call(owner.token, "POST", "/v1/companies", { name: "Lang" })).json.id;
    await client.enableTotp(owner);
    await client.call(owner.token, "POST", `/v1/companies/${company}/invites`, { email: "new@lang.test", role: "member" });
    const invite = client.lastMail("new@lang.test")!;
    assert.match(invite.subject, /te-a invitat în Lang pe Zen Staff/, "no account yet: Romanian");
    assert.match(invite.html ?? "", /Deschide invitația/);
    assert.match(invite.html ?? "", /http:\/\/hub\.test\/invite#/);
  });

  it("without an account language, the page's language decides: the dashboard's lang, else the browser's", async () => {
    await client.call(null, "POST", "/v1/auth/start", { email: "fresh@lang.test", lang: "en" });
    assert.match(client.lastMail("fresh@lang.test")!.subject, /^Your Zen Staff sign-in code/);
    const byHeader = await fetch(`${hub.base}/v1/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB,en;q=0.8" },
      body: JSON.stringify({ email: "header@lang.test" }),
    });
    assert.equal(byHeader.status, 200);
    assert.match(client.lastMail("header@lang.test")!.subject, /^Your Zen Staff sign-in code/);
    await fetch(`${hub.base}/v1/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "ro-RO,ro;q=0.9,en;q=0.5" },
      body: JSON.stringify({ email: "ro@lang.test" }),
    });
    assert.match(client.lastMail("ro@lang.test")!.subject, /^Codul tău de intrare/);

    const owner = await client.signIn("owner2@lang.test");
    const company = (await client.call(owner.token, "POST", "/v1/companies", { name: "Lang Two" })).json.id;
    await client.enableTotp(owner);
    await client.call(owner.token, "POST", `/v1/companies/${company}/invites`, { email: "new2@lang.test", role: "member", lang: "en" });
    const invite = client.lastMail("new2@lang.test")!;
    assert.match(invite.subject, /invited you to Lang Two on Zen Staff/);
    assert.match(invite.html ?? "", /http:\/\/hub\.test\/invite\?lang=en#/, "the link opens the English invitation page");
  });
});
