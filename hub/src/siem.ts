// Optional SIEM stream (v9): every audit event of a company is POSTed as JSON to the address its
// owners/admins configured, signed with HMAC-SHA256 over the body (`x-zen-signature: sha256=<hex>`,
// `x-zen-timestamp`). Delivery is best effort, in order per company, three tries with back-off; the
// last result is shown in the dashboard. The address must be https on a public host (no loopback,
// no private ranges, no redirects followed), unless HUB_SIEM_ALLOW_PRIVATE=1 (self-host, tests).
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { AuditEvent } from "./auditChain.ts";
import type { Db } from "./db.ts";
import type { SecretBox } from "./secretBox.ts";

const TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
const MAX_QUEUE = 1_000;

export interface SiemConfig {
  readonly url: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly lastAt: string | null;
}

export function siemOf(db: Db, companyId: string): (SiemConfig & { readonly secret: string }) | null {
  const row = db.prepare("SELECT * FROM company_siem WHERE company_id = ?").get(companyId) as
    | { url: string; secret: string; enabled: number; updated_at: string; last_status: string | null; last_error: string | null; last_at: string | null }
    | undefined;
  if (row === undefined) return null;
  return {
    url: row.url,
    secret: row.secret,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastAt: row.last_at,
  };
}

export function setSiem(db: Db, input: { companyId: string; url: string; secretSealed: string; enabled: boolean; by: string }) {
  db.prepare(
    `INSERT INTO company_siem (company_id, url, secret, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, enabled = excluded.enabled,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at, last_status = NULL, last_error = NULL, last_at = NULL`,
  ).run(input.companyId, input.url, input.secretSealed, input.enabled ? 1 : 0, input.by, new Date().toISOString());
}

export function removeSiem(db: Db, companyId: string): boolean {
  return Number(db.prepare("DELETE FROM company_siem WHERE company_id = ?").run(companyId).changes) > 0;
}

function recordResult(db: Db, companyId: string, status: string, error: string | null) {
  db.prepare("UPDATE company_siem SET last_status = ?, last_error = ?, last_at = ? WHERE company_id = ?").run(
    status,
    error === null ? null : error.slice(0, 300),
    new Date().toISOString(),
    companyId,
  );
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return PRIVATE_V4.some((pattern) => pattern.test(address));
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Checks the address before saving it and before every delivery (DNS can change). */
export async function checkSiemUrl(raw: string, allowPrivate: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The address is not valid.";
  }
  if (url.username !== "" || url.password !== "") return "Put the credentials in the secret, not in the address.";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return "The address must start with https://.";
  if (allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "The address must be public.";
  try {
    const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) return "The address must be public.";
  } catch {
    return "The address does not resolve.";
  }
  return null;
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** What goes to the SIEM: the event as stored, with its hashes (they can verify the chain too). */
export function siemPayload(event: AuditEvent) {
  return { type: "zen.audit", version: 1, event };
}

export function makeSiemStream(input: {
  readonly db: Db;
  readonly box: SecretBox;
  readonly log: (line: string) => void;
  readonly allowPrivate: boolean;
  readonly fetchImpl?: typeof fetch;
}) {
  const { db, box, log, allowPrivate } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const queues = new Map<string, Array<AuditEvent>>();
  const busy = new Set<string>();

  const deliverOne = async (companyId: string, event: AuditEvent): Promise<void> => {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const config = siemOf(db, companyId);
      if (config === null || !config.enabled) return;
      const problem = await checkSiemUrl(config.url, allowPrivate);
      if (problem !== null) {
        recordResult(db, companyId, "refused", problem);
        return;
      }
      const body = JSON.stringify(siemPayload(event));
      const timestamp = String(Date.now());
      try {
        const response = await doFetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "zen-hub-siem/1",
            "x-zen-timestamp": timestamp,
            "x-zen-signature": signBody(box.open(config.secret), timestamp, body),
            "x-zen-event-id": event.id,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.status >= 200 && response.status < 300) {
          recordResult(db, companyId, String(response.status), null);
          return;
        }
        recordResult(db, companyId, String(response.status), `The SIEM answered ${response.status}.`);
        if (response.status < 500 && response.status !== 429) return;
      } catch (error) {
        recordResult(db, companyId, "error", String(error instanceof Error ? error.message : error));
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
    }
    log(`[siem] company ${companyId}: event ${event.id} not delivered`);
  };

  const drain = async (companyId: string) => {
    if (busy.has(companyId)) return;
    busy.add(companyId);
    try {
      const queue = queues.get(companyId) ?? [];
      while (queue.length > 0) await deliverOne(companyId, queue.shift()!);
    } finally {
      busy.delete(companyId);
    }
  };

  const enqueue = (event: AuditEvent) => {
    const companyId = event.companyId;
    if (companyId === null) return;
    const config = siemOf(db, companyId);
    if (config === null || !config.enabled) return;
    const queue = queues.get(companyId) ?? [];
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(event);
    queues.set(companyId, queue);
    void drain(companyId);
  };

  /** For tests and the dashboard's "Trimite un test": resolves when the queue is empty. */
  const idle = async () => {
    while (busy.size > 0 || [...queues.values()].some((queue) => queue.length > 0)) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  return { enqueue, idle };
}
