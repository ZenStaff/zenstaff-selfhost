// SQL for passkeys (WebAuthn): credentials, the per-person user handle, and the ceremony links.
// A ceremony link is a bearer secret (only its SHA-256 is stored), short-lived and single-use;
// its challenge is stored hashed too and replaced each time the page asks for new options.
import { randomBytes } from "node:crypto";

import { newId, newSecret, sha256 } from "./crypto.ts";
import type { Db } from "./db.ts";

export const CEREMONY_TTL_MS = 10 * 60_000;

export type PageLanguage = "en" | "ro";

export interface Passkey {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly counter: number;
  readonly transports: Array<string>;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

const toPasskey = (row: PasskeyRow): Passkey => ({
  id: row.id,
  userId: row.user_id,
  credentialId: row.credential_id,
  publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
  counter: row.counter,
  transports: parseTransports(row.transports),
  deviceType: row.device_type,
  backedUp: row.backed_up === 1,
  label: row.label,
  createdAt: new Date(row.created_at).toISOString(),
  lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
});

function parseTransports(raw: string): Array<string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The WebAuthn user handle: random, stable per person, never the e-mail or the user id. */
export function userHandleOf(db: Db, userId: string): string {
  const row = db.prepare("SELECT handle FROM passkey_users WHERE user_id = ?").get(userId) as { handle: string } | undefined;
  if (row !== undefined) return row.handle;
  const handle = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO passkey_users (user_id, handle) VALUES (?, ?)").run(userId, handle);
  return handle;
}

export function userIdOfHandle(db: Db, handle: string): string | null {
  const row = db.prepare("SELECT user_id FROM passkey_users WHERE handle = ?").get(handle) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function passkeysOf(db: Db, userId: string): Array<Passkey> {
  return (db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as Array<PasskeyRow>).map(toPasskey);
}

export function passkeyByCredentialId(db: Db, credentialId: string): Passkey | null {
  const row = db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as PasskeyRow | undefined;
  return row === undefined ? null : toPasskey(row);
}

export function addPasskey(
  db: Db,
  input: {
    userId: string;
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: ReadonlyArray<string>;
    deviceType: string;
    backedUp: boolean;
    aaguid: string;
    label: string;
  },
): Passkey | { error: string } {
  if (passkeyByCredentialId(db, input.credentialId) !== null) return { error: "This passkey is already registered." };
  const id = newId("pk");
  db.prepare(
    "INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.userId,
    input.credentialId,
    Buffer.from(input.publicKey).toString("base64url"),
    input.counter,
    JSON.stringify(input.transports.slice(0, 10)),
    input.deviceType,
    input.backedUp ? 1 : 0,
    input.aaguid,
    input.label.slice(0, 120),
    Date.now(),
  );
  return toPasskey(db.prepare("SELECT * FROM passkeys WHERE id = ?").get(id) as unknown as PasskeyRow);
}

/** After a verified sign-in: the new signature counter and the last use. */
export function touchPasskey(db: Db, id: string, counter: number, backedUp: boolean) {
  db.prepare("UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?").run(counter, backedUp ? 1 : 0, Date.now(), id);
}

export function deletePasskey(db: Db, userId: string, id: string): Passkey | null {
  const row = db.prepare("SELECT * FROM passkeys WHERE id = ? AND user_id = ?").get(id, userId) as PasskeyRow | undefined;
  if (row === undefined) return null;
  db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
  return toPasskey(row);
}

// ---- Ceremony links ------------------------------------------------------------------------

export interface Ceremony {
  readonly id: string;
  readonly kind: "register" | "login";
  readonly challengeHash: string | null;
  readonly userId: string | null;
  readonly sessionHash: string | null;
  readonly loginId: string | null;
  readonly label: string | null;
  readonly lang: PageLanguage;
  readonly expiresAt: number;
}

interface CeremonyRow {
  id: string;
  kind: "register" | "login";
  challenge_hash: string | null;
  user_id: string | null;
  session_hash: string | null;
  login_id: string | null;
  label: string | null;
  lang: string;
  expires_at: number;
}

/** A registration link for this session's person (the session must still exist when it finishes). */
export function startRegistration(
  db: Db,
  input: { userId: string; sessionHash: string; label: string; lang: PageLanguage },
): { token: string; expiresAt: number } {
  const token = newSecret("pkr");
  const expiresAt = Date.now() + CEREMONY_TTL_MS;
  db.prepare(
    "INSERT INTO passkey_ceremonies (id, kind, token_hash, user_id, session_hash, label, lang, expires_at) VALUES (?, 'register', ?, ?, ?, ?, ?, ?)",
  ).run(newId("pc"), sha256(token), input.userId, input.sessionHash, input.label.slice(0, 120), input.lang, expiresAt);
  return { token, expiresAt };
}

/**
 * A pending login (like OAuth: a login_codes row without an e-mail yet) and the sign-in link that
 * approves it. The app polls /v1/auth/poll with the poll secret.
 */
export function startLogin(db: Db, lang: PageLanguage): { requestId: string; pollSecret: string; token: string; expiresAt: number } {
  const requestId = newId("lc");
  const pollSecret = newSecret("mp");
  const token = newSecret("pkl");
  const expiresAt = Date.now() + CEREMONY_TTL_MS;
  db.prepare(
    "INSERT INTO login_codes (id, email, code_hash, link_hash, poll_hash, expires_at, provider) VALUES (?, '', ?, ?, ?, ?, 'passkey')",
  ).run(requestId, sha256(newSecret("x")), sha256(newSecret("x")), sha256(pollSecret), expiresAt);
  db.prepare(
    "INSERT INTO passkey_ceremonies (id, kind, token_hash, login_id, lang, expires_at) VALUES (?, 'login', ?, ?, ?, ?)",
  ).run(newId("pc"), sha256(token), requestId, lang, expiresAt);
  return { requestId, pollSecret, token, expiresAt };
}

/** A live (unused, unexpired) ceremony for this link, or null. */
export function ceremonyForToken(db: Db, token: string, kind: "register" | "login"): Ceremony | null {
  if (token.length > 200) return null;
  const row = db
    .prepare(
      "SELECT id, kind, challenge_hash, user_id, session_hash, login_id, label, lang, expires_at FROM passkey_ceremonies WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(sha256(token), kind, Date.now()) as CeremonyRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind,
    challengeHash: row.challenge_hash,
    userId: row.user_id,
    sessionHash: row.session_hash,
    loginId: row.login_id,
    label: row.label,
    lang: row.lang === "ro" ? "ro" : "en",
    expiresAt: row.expires_at,
  };
}

/** Each options request gets a fresh challenge; only the newest one can finish the ceremony. */
export function setChallenge(db: Db, ceremonyId: string, challenge: string) {
  db.prepare("UPDATE passkey_ceremonies SET challenge_hash = ? WHERE id = ?").run(sha256(challenge), ceremonyId);
}

/**
 * Uses the ceremony up. Returns false when it was already used (two finishes racing), so exactly
 * one of them goes on. The challenge is cleared with it.
 */
export function consumeCeremony(db: Db, ceremonyId: string): boolean {
  const result = db
    .prepare("UPDATE passkey_ceremonies SET used_at = ?, challenge_hash = NULL WHERE id = ? AND used_at IS NULL")
    .run(Date.now(), ceremonyId);
  return Number(result.changes) === 1;
}

/** Old ceremonies are of no use once expired; dropped whenever a new one starts. */
export function pruneCeremonies(db: Db) {
  db.prepare("DELETE FROM passkey_ceremonies WHERE expires_at < ?").run(Date.now() - CEREMONY_TTL_MS);
}

export function approvePasskeyLogin(db: Db, loginId: string, email: string) {
  db.prepare("UPDATE login_codes SET email = ?, approved_at = ? WHERE id = ? AND used_at IS NULL AND provider = 'passkey'").run(email, Date.now(), loginId);
}

export function sessionExists(db: Db, sessionHash: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sessionHash, Date.now()) !== undefined;
}
