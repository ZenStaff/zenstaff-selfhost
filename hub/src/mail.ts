// Login and invitation e-mails. Resend when RESEND_API_KEY is set; otherwise SMTP when HUB_SMTP_HOST
// is set (any mail server: the company's own, Microsoft 365, Google Workspace, SES, Mailgun...);
// otherwise the message is only logged (and, with HUB_DEV_OUTBOX=1, kept in memory for local
// tests).
import nodemailer from "nodemailer";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Optional HTML part (sign-in and invitation e-mails); the text part is always sent too. */
  readonly html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** Dev only: the last messages per address. */
  readonly outbox: Map<string, Array<MailMessage>> | null;
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS. */
  readonly secure: boolean;
  /** Refuse to send when the server does not offer STARTTLS (on unless HUB_SMTP_ALLOW_PLAIN=1). */
  readonly requireTls: boolean;
  readonly user: string;
  readonly password: string;
}

const flag = (value: string | undefined) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

/** SMTP settings from the environment, or null when HUB_SMTP_HOST is not set. */
export function smtpSettings(env: NodeJS.ProcessEnv): SmtpSettings | null {
  const host = (env.HUB_SMTP_HOST ?? "").trim();
  if (host === "") return null;
  const secure = flag(env.HUB_SMTP_SECURE);
  const rawPort = (env.HUB_SMTP_PORT ?? "").trim();
  const port = rawPort === "" ? (secure ? 465 : 587) : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`HUB_SMTP_PORT is not a port: ${rawPort}`);
  const user = env.HUB_SMTP_USER ?? "";
  const password = env.HUB_SMTP_PASSWORD ?? "";
  if ((user === "") !== (password === "")) throw new Error("Set both HUB_SMTP_USER and HUB_SMTP_PASSWORD, or neither.");
  return { host, port, secure, requireTls: !secure && !flag(env.HUB_SMTP_ALLOW_PLAIN), user, password };
}

export function makeMailer(env: NodeJS.ProcessEnv, log: (line: string) => void): Mailer {
  const apiKey = env.RESEND_API_KEY ?? "";
  const from = env.HUB_MAIL_FROM ?? "Zen Staff <no-reply@localhost>";
  const smtp = apiKey === "" ? smtpSettings(env) : null;
  const transport =
    smtp === null
      ? null
      : nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          requireTLS: smtp.requireTls,
          ...(smtp.user === "" ? {} : { auth: { user: smtp.user, pass: smtp.password } }),
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
          tls: { minVersion: "TLSv1.2" },
        });
  if (smtp !== null) log(`[mail] SMTP ${smtp.host}:${smtp.port} (${smtp.secure ? "TLS" : smtp.requireTls ? "STARTTLS required" : "plain allowed"})`);
  const outbox = env.HUB_DEV_OUTBOX === "1" ? new Map<string, Array<MailMessage>>() : null;
  return {
    outbox,
    async send(message) {
      if (outbox !== null) {
        const list = outbox.get(message.to) ?? [];
        list.push(message);
        outbox.set(message.to, list.slice(-10));
      }
      if (transport !== null) {
        await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        });
        return;
      }
      if (apiKey === "") {
        log(`[mail] to=${message.to} subject=${JSON.stringify(message.subject)} (not sent: no RESEND_API_KEY or HUB_SMTP_HOST)`);
        return;
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, ...(message.html === undefined ? {} : { html: message.html }) }),
      });
      if (!response.ok) throw new Error(`Mail provider answered ${response.status}`);
    },
  };
}
