// SMTP as the alternative to Resend (self-hosted hubs): settings from the environment, and a real
// send to a minimal SMTP server on loopback (plain allowed, AUTH PLAIN, a multipart message).
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { after, before, describe, it } from "node:test";

import { makeMailer, smtpSettings } from "../src/mail.ts";

interface Received {
  readonly from: string;
  readonly to: Array<string>;
  readonly auth: string | null;
  readonly data: string;
}

/** Just enough of RFC 5321 for one client: EHLO with AUTH, MAIL, RCPT, DATA, QUIT. */
function fakeSmtpServer(offerStartTls: boolean) {
  const received: Array<Received> = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let from = "";
    let to: Array<string> = [];
    let auth: string | null = null;
    let inData = false;
    let data = "";
    let buffer = "";
    socket.write("220 fake.smtp.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ from, to, auth, data });
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          socket.write(`250-fake.smtp.test\r\n${offerStartTls ? "250-STARTTLS\r\n" : ""}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
        } else if (verb === "AUTH") {
          auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          socket.write("235 2.7.0 ok\r\n");
        } else if (verb === "MAIL") {
          from = line.slice(line.indexOf("<") + 1, line.indexOf(">"));
          to = [];
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          to.push(line.slice(line.indexOf("<") + 1, line.indexOf(">")));
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          data = "";
          socket.write("354 go on\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else if (verb === "STARTTLS") {
          socket.write("454 TLS not available in this test\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return { server, received };
}

describe("SMTP settings", () => {
  it("is off without HUB_SMTP_HOST", () => {
    assert.equal(smtpSettings({}), null);
    assert.equal(smtpSettings({ HUB_SMTP_HOST: "  " }), null);
  });

  it("defaults to port 587 with STARTTLS required, or 465 with implicit TLS", () => {
    assert.deepEqual(smtpSettings({ HUB_SMTP_HOST: "smtp.example.com" }), {
      host: "smtp.example.com", port: 587, secure: false, requireTls: true, user: "", password: "",
    });
    const tls = smtpSettings({ HUB_SMTP_HOST: "smtp.example.com", HUB_SMTP_SECURE: "1", HUB_SMTP_USER: "u", HUB_SMTP_PASSWORD: "p" });
    assert.equal(tls?.port, 465);
    assert.equal(tls?.secure, true);
    assert.equal(tls?.requireTls, false, "implicit TLS needs no STARTTLS");
    assert.equal(smtpSettings({ HUB_SMTP_HOST: "relay.lan", HUB_SMTP_PORT: "25", HUB_SMTP_ALLOW_PLAIN: "1" })?.requireTls, false);
  });

  it("refuses a bad port and a user without a password", () => {
    assert.throws(() => smtpSettings({ HUB_SMTP_HOST: "h", HUB_SMTP_PORT: "70000" }), /not a port/);
    assert.throws(() => smtpSettings({ HUB_SMTP_HOST: "h", HUB_SMTP_USER: "u" }), /both/);
  });

  it("Resend wins when both are configured", () => {
    const lines: Array<string> = [];
    makeMailer({ RESEND_API_KEY: "re_test", HUB_SMTP_HOST: "smtp.example.com" }, (l) => lines.push(l));
    assert.ok(!lines.some((l) => l.includes("SMTP")), "no SMTP transport when Resend is set");
  });
});

describe("SMTP sending", () => {
  const plain = fakeSmtpServer(false);
  const tlsOnly = fakeSmtpServer(true);
  let port = 0;
  let tlsPort = 0;

  before(async () => {
    plain.server.listen(0, "127.0.0.1");
    tlsOnly.server.listen(0, "127.0.0.1");
    await Promise.all([once(plain.server, "listening"), once(tlsOnly.server, "listening")]);
    port = (plain.server.address() as net.AddressInfo).port;
    tlsPort = (tlsOnly.server.address() as net.AddressInfo).port;
  });
  after(() => {
    plain.server.close();
    tlsOnly.server.close();
  });

  it("sends the text and HTML parts with AUTH to the configured server", async () => {
    const lines: Array<string> = [];
    const mailer = makeMailer(
      {
        HUB_SMTP_HOST: "127.0.0.1",
        HUB_SMTP_PORT: String(port),
        HUB_SMTP_ALLOW_PLAIN: "1",
        HUB_SMTP_USER: "hub@firma.example",
        HUB_SMTP_PASSWORD: "parola-de-test",
        HUB_MAIL_FROM: "Zen Staff <hub@firma.example>",
      },
      (l) => lines.push(l),
    );
    assert.ok(lines.some((l) => l.includes(`SMTP 127.0.0.1:${port} (plain allowed)`)));
    await mailer.send({ to: "ana@firma.example", subject: "Codul tău: 123456", text: "Codul este 123456.", html: "<p>Codul este <b>123456</b></p>" });
    assert.equal(plain.received.length, 1);
    const got = plain.received[0]!;
    assert.equal(got.from, "hub@firma.example");
    assert.deepEqual(got.to, ["ana@firma.example"]);
    assert.equal(got.auth, "\0hub@firma.example\0parola-de-test", "AUTH PLAIN with the configured user");
    assert.match(got.data, /^Subject: =\?UTF-8\?Q\?Codul_t=C4=83u=3A_123456\?=\r?$/m);
    assert.match(got.data, /Content-Type: multipart\/alternative/);
    assert.match(got.data, /Codul este 123456\./);
    assert.match(got.data, /<b>123456<\/b>/);
    assert.ok(!lines.some((l) => l.includes("not sent")), "nothing falls back to the log");
  });

  it("refuses to send in clear text when STARTTLS is required and fails", async () => {
    const mailer = makeMailer({ HUB_SMTP_HOST: "127.0.0.1", HUB_SMTP_PORT: String(tlsPort) }, () => undefined);
    await assert.rejects(mailer.send({ to: "ana@firma.example", subject: "s", text: "t" }));
    assert.equal(tlsOnly.received.length, 0, "no message went out unencrypted");
  });
});
