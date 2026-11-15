// The tamper-evident audit log (v9), in its own SQLite file, apart from the hub's data.
//
// - Append-only: triggers refuse UPDATE and DELETE on `audit_events`.
// - Hash-chained per chain (one chain per company, plus "hub" for events of nobody's company):
//   hash = sha256(prev_hash + canonical row). Changing, removing or reordering a row breaks every
//   hash after it; `verifyChain` finds the first broken row.
// - Anchored: once a day the head hash of every chain is written to the hub's main database
//   (`audit_anchors`, append-only too), to the hub log and, when configured, to an outside address
//   (HUB_AUDIT_ANCHOR_URL, e.g. a worker that writes to R2). Rewriting the whole chain consistently
//   then still disagrees with the anchors kept elsewhere.
// - Every event carries the address, device id and user agent of the request that caused it
//   (AsyncLocalStorage set by app.ts), plus who acted.
// - Metadata only: ids, actions, short descriptions. Never chat text, prompts or file contents.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { newId } from "./crypto.ts";
import type { Db } from "./db.ts";
import { canonicalJson } from "./signing.ts";

export const GENESIS = "0".repeat(64);
export const HUB_CHAIN = "hub";
/** The platform admin's own chain (/app/admin): what hub staff did, apart from every company's chain. */
export const PLATFORM_CHAIN = "platform";
const DETAIL_MAX = 2000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY,
    chain TEXT NOT NULL,
    chain_seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    ts TEXT NOT NULL,
    company_id TEXT,
    actor_user_id TEXT,
    actor_email TEXT,
    actor_name TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL,
    ip TEXT,
    device_id TEXT,
    user_agent TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    UNIQUE (chain, chain_seq)
  );
  CREATE INDEX IF NOT EXISTS audit_events_company ON audit_events(company_id, ts);
  CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events(company_id, actor_user_id);
  CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
`;

export type AuditDb = DatabaseSync;

export function openAuditDb(path: string): AuditDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(SCHEMA);
  return db;
}

/** Where the audit file goes by default: next to the hub's database. */
export function defaultAuditPath(hubDbPath: string): string {
  return hubDbPath === ":memory:" ? ":memory:" : `${dirname(hubDbPath)}/audit.sqlite`;
}

// ---- Request context ---------------------------------------------------------------------------

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  userId: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// ---- Events ------------------------------------------------------------------------------------

export interface AuditInput {
  readonly companyId: string | null;
  /** Another chain than the company's (only PLATFORM_CHAIN, with companyId null). */
  readonly chain?: typeof PLATFORM_CHAIN;
  readonly actorUserId: string | null;
  readonly actorEmail?: string | null;
  readonly actorName?: string | null;
  readonly action: string;
  readonly target?: string | null;
  /** A short summary and/or structured metadata (ids, roles, decisions). */
  readonly detail: string | Record<string, unknown>;
  /** Overrides the request's context (runner events: the runner's machine id). */
  readonly ip?: string | null;
  readonly deviceId?: string | null;
  readonly userAgent?: string | null;
}

export interface AuditEvent {
  readonly seq: number;
  readonly chain: string;
  readonly chainSeq: number;
  readonly id: string;
  readonly ts: string;
  readonly companyId: string | null;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly detail: Record<string, unknown>;
  readonly ip: string | null;
  readonly deviceId: string | null;
  readonly userAgent: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

/** The bytes a row's hash covers (everything but seq, which is the file's own row id). */
export function canonicalRow(event: Omit<AuditEvent, "seq" | "hash" | "prevHash">): string {
  return canonicalJson({
    chain: event.chain,
    chainSeq: event.chainSeq,
    id: event.id,
    ts: event.ts,
    companyId: event.companyId,
    actorUserId: event.actorUserId,
    actorEmail: event.actorEmail,
    actorName: event.actorName,
    action: event.action,
    target: event.target,
    detail: event.detail,
    ip: event.ip,
    deviceId: event.deviceId,
    userAgent: event.userAgent,
  });
}

export function hashRow(prevHash: string, event: Omit<AuditEvent, "seq" | "hash" | "prevHash">): string {
  return createHash("sha256").update(prevHash).update(canonicalRow(event)).digest("hex");
}

interface Row {
  seq: number;
  chain: string;
  chain_seq: number;
  id: string;
  ts: string;
  company_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  detail: string;
  ip: string | null;
  device_id: string | null;
  user_agent: string | null;
  prev_hash: string;
  hash: string;
}

const toEvent = (row: Row): AuditEvent => ({
  seq: row.seq,
  chain: row.chain,
  chainSeq: row.chain_seq,
  id: row.id,
  ts: row.ts,
  companyId: row.company_id,
  actorUserId: row.actor_user_id,
  actorEmail: row.actor_email,
  actorName: row.actor_name,
  action: row.action,
  target: row.target,
  detail: parseDetail(row.detail),
  ip: row.ip,
  deviceId: row.device_id,
  userAgent: row.user_agent,
  prevHash: row.prev_hash,
  hash: row.hash,
});

function parseDetail(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { text: String(value) };
  } catch {
    return { text };
  }
}

const clip = (value: string | null | undefined, max: number) => (value === null || value === undefined || value === "" ? null : value.slice(0, max));

export type AuditListener = (event: AuditEvent) => void;

export class AuditLog {
  readonly db: AuditDb;
  readonly #listeners: Array<AuditListener> = [];
  #actorOf: (userId: string) => { email: string; name: string } | null = () => null;

  constructor(db: AuditDb) {
    this.db = db;
  }

  /** Fills who acted (e-mail, name) when an event only names the person's id. */
  resolveActorsWith(lookup: (userId: string) => { email: string; name: string } | null) {
    this.#actorOf = lookup;
  }

  onAppend(listener: AuditListener) {
    this.#listeners.push(listener);
  }

  append(input: AuditInput): AuditEvent {
    const context = requestContext.getStore();
    const known = input.actorUserId !== null && (input.actorEmail === undefined || input.actorName === undefined) ? this.#actorOf(input.actorUserId) : null;
    const chain = input.chain !== undefined && input.companyId === null ? input.chain : (input.companyId ?? HUB_CHAIN);
    const detail = typeof input.detail === "string" ? { summary: input.detail.slice(0, DETAIL_MAX) } : input.detail;
    const detailText = canonicalJson(detail);
    const safeDetail = detailText.length > DETAIL_MAX * 2 ? { summary: detailText.slice(0, DETAIL_MAX), truncated: true } : detail;
    let event: AuditEvent;
    // One writer at a time per file: the head read and the insert happen in one transaction.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const head = this.db.prepare("SELECT chain_seq, hash FROM audit_events WHERE chain = ? ORDER BY chain_seq DESC LIMIT 1").get(chain) as
        | { chain_seq: number; hash: string }
        | undefined;
      const body = {
        chain,
        chainSeq: (head?.chain_seq ?? 0) + 1,
        id: newId("ev"),
        ts: new Date().toISOString(),
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        actorEmail: clip(input.actorEmail ?? known?.email, 254),
        actorName: clip(input.actorName ?? known?.name, 120),
        action: input.action.slice(0, 80),
        target: clip(input.target, 200),
        detail: safeDetail,
        ip: clip(input.ip === undefined ? context?.ip : input.ip, 64),
        deviceId: clip(input.deviceId === undefined ? context?.deviceId : input.deviceId, 80),
        userAgent: clip(input.userAgent === undefined ? context?.userAgent : input.userAgent, 300),
      };
      const prevHash = head?.hash ?? GENESIS;
      const hash = hashRow(prevHash, body);
      const result = this.db
        .prepare(
          `INSERT INTO audit_events (chain, chain_seq, id, ts, company_id, actor_user_id, actor_email, actor_name, action, target, detail, ip, device_id, user_agent, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.chain,
          body.chainSeq,
          body.id,
          body.ts,
          body.companyId,
          body.actorUserId,
          body.actorEmail,
          body.actorName,
          body.action,
          body.target,
          canonicalJson(body.detail),
          body.ip,
          body.deviceId,
          body.userAgent,
          prevHash,
          hash,
        );
      this.db.exec("COMMIT");
      event = { ...body, seq: Number(result.lastInsertRowid), prevHash, hash };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener (the SIEM stream) never blocks or undoes the write.
      }
    }
    return event;
  }

  search(input: {
    readonly companyId: string;
    readonly actor?: string | null;
    readonly action?: string | null;
    readonly from?: string | null;
    readonly to?: string | null;
    readonly before?: number | null;
    readonly limit?: number;
  }): Array<AuditEvent> {
    const where = ["chain = ?"];
    const args: Array<string | number> = [input.companyId];
    if (input.actor) {
      where.push("(actor_user_id = ? OR lower(actor_email) LIKE ? OR lower(actor_name) LIKE ?)");
      const like = `%${input.actor.toLowerCase().replace(/[%_]/g, "")}%`;
      args.push(input.actor, like, like);
    }
    if (input.action) {
      where.push("(action = ? OR action LIKE ?)");
      args.push(input.action, `${input.action.replace(/[%_]/g, "")}.%`);
    }
    if (input.from) {
      where.push("ts >= ?");
      args.push(input.from);
    }
    if (input.to) {
      where.push("ts < ?");
      args.push(input.to);
    }
    if (input.before) {
      where.push("seq < ?");
      args.push(input.before);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
    return (this.db.prepare(`SELECT * FROM audit_events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ${limit}`).all(...args) as unknown as Array<Row>).map(toEvent);
  }

  /** The events with these row numbers, in the order given (the platform admin's pages). */
  eventsBySeq(seqs: ReadonlyArray<number>): Array<AuditEvent> {
    if (seqs.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM audit_events WHERE seq IN (${seqs.map(() => "?").join(",")})`).all(...seqs) as unknown as Array<Row>;
    const bySeq = new Map(rows.map((row) => [row.seq, toEvent(row)]));
    return seqs.flatMap((seq) => bySeq.get(seq) ?? []);
  }

  actions(companyId: string): Array<string> {
    return (this.db.prepare("SELECT DISTINCT action FROM audit_events WHERE chain = ? ORDER BY action").all(companyId) as Array<{ action: string }>).map(
      (row) => row.action,
    );
  }

  chains(): Array<string> {
    return (this.db.prepare("SELECT DISTINCT chain FROM audit_events ORDER BY chain").all() as Array<{ chain: string }>).map((row) => row.chain);
  }

  head(chain: string): { chainSeq: number; hash: string } | null {
    const row = this.db.prepare("SELECT chain_seq, hash FROM audit_events WHERE chain = ? ORDER BY chain_seq DESC LIMIT 1").get(chain) as
      | { chain_seq: number; hash: string }
      | undefined;
    return row === undefined ? null : { chainSeq: row.chain_seq, hash: row.hash };
  }
}

// ---- Verification --------------------------------------------------------------------------------

export interface VerifyResult {
  readonly ok: boolean;
  readonly chain: string;
  readonly checked: number;
  readonly head: string | null;
  readonly brokenAt?: number;
  readonly reason?: string;
}

/** Walks one chain from its first row: sequence without gaps, each prev_hash, each hash. */
export function verifyChain(db: AuditDb, chain: string, anchors: ReadonlyArray<Anchor> = []): VerifyResult {
  let prev = GENESIS;
  let expected = 1;
  let checked = 0;
  const byHeadSeq = new Map(anchors.filter((anchor) => anchor.chain === chain).map((anchor) => [anchor.headSeq, anchor]));
  for (const raw of db.prepare("SELECT * FROM audit_events WHERE chain = ? ORDER BY chain_seq").iterate(chain) as Iterable<Row>) {
    const event = toEvent(raw);
    const fail = (reason: string): VerifyResult => ({ ok: false, chain, checked, head: prev, brokenAt: event.chainSeq, reason });
    if (event.chainSeq !== expected) return { ok: false, chain, checked, head: prev, brokenAt: expected, reason: "a row is missing" };
    if (event.prevHash !== prev) return fail("the link to the previous row does not match");
    // The detail is hashed in the canonical form it was written in.
    const { seq: _seq, hash: _hash, prevHash: _prev, ...body } = event;
    if (hashRow(prev, { ...body, detail: JSON.parse(raw.detail) as Record<string, unknown> }) !== event.hash) return fail("the row was changed");
    const anchor = byHeadSeq.get(event.chainSeq);
    if (anchor !== undefined && anchor.headHash !== event.hash) return fail(`the row does not match the anchor of ${anchor.day}`);
    byHeadSeq.delete(event.chainSeq);
    prev = event.hash;
    expected += 1;
    checked += 1;
  }
  const missing = [...byHeadSeq.values()][0];
  if (missing !== undefined) {
    return { ok: false, chain, checked, head: prev, brokenAt: missing.headSeq, reason: `rows anchored on ${missing.day} are missing` };
  }
  return { ok: true, chain, checked, head: checked === 0 ? null : prev };
}

// ---- Anchors -------------------------------------------------------------------------------------

export interface Anchor {
  readonly chain: string;
  readonly day: string;
  readonly headSeq: number;
  readonly headHash: string;
  readonly createdAt: string;
}

export function anchorsOf(hubDb: Db, chain?: string): Array<Anchor> {
  const rows = (chain === undefined
    ? hubDb.prepare("SELECT * FROM audit_anchors ORDER BY chain, day").all()
    : hubDb.prepare("SELECT * FROM audit_anchors WHERE chain = ? ORDER BY day").all(chain)) as Array<{
    chain: string;
    day: string;
    head_seq: number;
    head_hash: string;
    created_at: string;
  }>;
  return rows.map((row) => ({ chain: row.chain, day: row.day, headSeq: row.head_seq, headHash: row.head_hash, createdAt: row.created_at }));
}

/**
 * Writes today's anchor of every chain that has none yet (idempotent; run hourly and at start).
 * Returns the anchors written, so the caller can log them and send them out.
 */
export function anchorToday(log: AuditLog, hubDb: Db, now = new Date()): Array<Anchor> {
  const day = now.toISOString().slice(0, 10);
  const written: Array<Anchor> = [];
  for (const chain of log.chains()) {
    const head = log.head(chain);
    if (head === null) continue;
    const exists = hubDb.prepare("SELECT 1 FROM audit_anchors WHERE chain = ? AND day = ?").get(chain, day);
    if (exists !== undefined) continue;
    const anchor = { chain, day, headSeq: head.chainSeq, headHash: head.hash, createdAt: now.toISOString() };
    hubDb
      .prepare("INSERT INTO audit_anchors (chain, day, head_seq, head_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(anchor.chain, anchor.day, anchor.headSeq, anchor.headHash, anchor.createdAt);
    written.push(anchor);
  }
  return written;
}

// ---- Wiring --------------------------------------------------------------------------------------

/** The audit log of a hub database (team.audit and createSession find it through the db). */
const logs = new WeakMap<Db, AuditLog>();

export function attachAuditLog(hubDb: Db, log: AuditLog) {
  logs.set(hubDb, log);
}

export function auditLogOf(hubDb: Db): AuditLog | null {
  return logs.get(hubDb) ?? null;
}

/** CSV with every column, hashes included, so a customer can verify an export on their own. */
export function toCsv(events: ReadonlyArray<AuditEvent>): string {
  const columns = ["seq", "chainSeq", "ts", "action", "actorUserId", "actorEmail", "actorName", "target", "detail", "ip", "deviceId", "userAgent", "prevHash", "hash", "id"] as const;
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? canonicalJson(value) : String(value);
    // Formula injection: a cell that a spreadsheet would run starts with a quote instead.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(","), ...events.map((event) => columns.map((column) => cell(event[column])).join(","))].join("\r\n") + "\r\n";
}
