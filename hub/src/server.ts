// Entry point. Configuration comes from the environment; see README.md.
import { join, dirname } from "node:path";

import { createHub } from "./app.ts";
import { billingConfigFromEnv } from "./billing/config.ts";
import { diskStorage } from "./approvalFiles.ts";
import { defaultAuditPath, openAuditDb } from "./auditChain.ts";
import { openDb } from "./db.ts";
import { makeMailer } from "./mail.ts";
import { oauthProvidersFromEnv } from "./oauth.ts";
import { makeSecretBox } from "./secretBox.ts";
import { statsConfigFromEnv } from "./stats.ts";
import { growthConfigFromEnv } from "./growth.ts";
import { webauthnConfig } from "./webauthn.ts";
import { memoryHostedConfig } from "./memoryHosted.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";
const dbPath = env.HUB_DB_PATH ?? "./data/hub.sqlite";
const publicUrl = (env.HUB_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/$/, "");

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const db = openDb(dbPath);
// The tamper-evident audit log lives in its own file (back it up with the hub's).
const auditPath = env.HUB_AUDIT_DB_PATH ?? defaultAuditPath(dbPath);
const auditDb = openAuditDb(auditPath);
const mailer = makeMailer(env, log);
const box = makeSecretBox(env.HUB_SECRET_KEY);
const memoryHosted = memoryHostedConfig(env);
if (memoryHosted !== null) log(`hosted company memory: ${memoryHosted.publicUrl}`);
if (!box.encrypted) log("warning: HUB_SECRET_KEY is not set; two-factor secrets are stored unencrypted");
const oauth = oauthProvidersFromEnv(env);
const webauthn = webauthnConfig(env, publicUrl);
const billingConfig = billingConfigFromEnv(env, log);
const growth = growthConfigFromEnv(env, log);
const { server, billing } = createHub({
  db,
  billing: { config: billingConfig },
  mailer,
  box,
  oauth,
  auditDb,
  // Client approval files: next to the database on the data volume (or HUB_APPROVALS_DIR).
  approvalStorage: diskStorage(env.HUB_APPROVALS_DIR ?? join(dirname(dbPath), "approvals")),
  config: {
    publicUrl,
    devOutbox: env.HUB_DEV_OUTBOX === "1",
    // Empty counts as unset (a compose file passes `${VAR:-}`), never as a limit of 0.
    writeLimitPerMinute: env.HUB_WRITE_LIMIT_PER_MINUTE?.trim() ? Number(env.HUB_WRITE_LIMIT_PER_MINUTE) : 120,
    webauthn,
    ...(env.HUB_ADVISORIES_TOKEN ? { advisoriesToken: env.HUB_ADVISORIES_TOKEN } : {}),
    ...(env.HUB_CLIENT_IP_HEADER ? { clientIpHeader: env.HUB_CLIENT_IP_HEADER } : {}),
    plan: env.HUB_PLAN === "hosted" ? "hosted" : "selfhost",
    libraryReviewers: (env.HUB_LIBRARY_REVIEWERS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => email !== ""),
    siemAllowPrivate: env.HUB_SIEM_ALLOW_PRIVATE === "1",
    ...(env.HUB_AUDIT_ANCHOR_URL ? { auditAnchorUrl: env.HUB_AUDIT_ANCHOR_URL } : {}),
    ...(memoryHosted === null ? {} : { memory: memoryHosted }),
    ...(env.HUB_APPROVALS_COMPANY_MB ? { approvalCompanyBytes: Number(env.HUB_APPROVALS_COMPANY_MB) * 1024 * 1024 } : {}),
    stats: statsConfigFromEnv(env),
    ...(growth === undefined ? {} : { growth }),
    adminEmails: (env.HUB_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@")),
  },
  log,
});
log(`audit log: ${auditPath}`);
log(`sign-in methods: e-mail${oauth.map((provider) => `, ${provider.name}`).join("")}, passkeys (RP ID ${webauthn.rpId}, origin ${webauthn.origin})`);
log(
  `billing: ${billing.enabled ? `Stripe ${billingConfig.stripeSecretKey?.startsWith("sk_live_") ? "live" : "test"} mode` : "off"}, fiscal invoices: ${billingConfig.horecaos === null ? "dry run (HORECAOS_API_URL / HORECAOS_API_KEY not set)" : `HoReCaOS ${billingConfig.horecaos.baseUrl}`}, seller ${billingConfig.seller.vatRegistered ? "VAT registered" : "not VAT registered"}`,
);
billing.start();
server.listen(port, host, () => log(`zen-hub listening on http://${host}:${port} (public ${publicUrl})`));

const stop = () => {
  log("zen-hub stopping");
  server.close(() => {
    db.close();
    auditDb.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
