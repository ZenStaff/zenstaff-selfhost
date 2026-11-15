// SQL for sign-in security: sessions (list, revoke, two-factor state), TOTP, recovery codes,
// device keys and their cross-signatures, and OAuth sign-in state.
import { auditLogOf } from "./auditChain.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { newId, newSecret, safeEqualHex, sha256 } from "./crypto.ts";
import type { SecretBox } from "./secretBox.ts";
import { keyIdOf } from "./signing.ts";
import { normalizeRecoveryCode, newRecoveryCodes, newTotpSecret, verifyTotp } from "./totp.ts";
import type { User } from "./store.ts";

const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
const OAUTH_TTL_MS = 10 * 60_000;

// ---- Sessions --------------------------------------------------------------------------------

export interface SessionInfo {
  readonly hash: string;
  /** Public id: the first 16 hex characters of the token hash. */
  readonly id: string;
  readonly user: User;
  readonly mfaAt: number | null;
  readonly method: string;
}

export function createSession(
  db: Db,
  input: { userId: string; label: string; ip: string; method: string; mfa?: boolean; ttlMs?: number },
): string {
  // A suspended account (platform admin) cannot sign in by any method.
  if (db.prepare("SELECT 1 FROM users WHERE id = ? AND suspended_at IS NOT NULL").get(input.userId) !== undefined) {
    throw new HttpError(403, "This account is suspended. Write to the Zen Staff team.", "account_suspended");
  }
  const token = newSecret("zhs");
  const now = Date.now();
  db.prepare("UPDATE users SET last_signin_at = ? WHERE id = ?").run(new Date(now).toISOString(), input.userId);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, label, created_at, expires_at, last_used_at, ip, method, mfa_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sha256(token), input.userId, input.label.slice(0, 120), now, now + (input.ttlMs ?? SESSION_TTL_MS), now, input.ip.slice(0, 64), input.method, input.mfa === true ? now : null);
  recordSignIn(db, { userId: input.userId, method: input.method, sessionId: sha256(token).slice(0, 16), ip: input.ip, mfa: input.mfa === true });
  return token;
}

/** A sign-in goes to the audit chain of every company the person belongs to (or the hub's own). */
function recordSignIn(db: Db, input: { userId: string; method: string; sessionId: string; ip: string; mfa: boolean }) {
  const log = auditLogOf(db);
  if (log === null) return;
  const user = db.prepare("SELECT email, name FROM users WHERE id = ?").get(input.userId) as { email: string; name: string } | undefined;
  const companies = (db.prepare("SELECT company_id FROM memberships WHERE user_id = ?").all(input.userId) as Array<{ company_id: string }>).map(
    (row) => row.company_id,
  );
  for (const companyId of companies.length === 0 ? [null] : companies) {
    log.append({
      companyId,
      actorUserId: input.userId,
      actorEmail: user?.email ?? null,
      actorName: user?.name ?? null,
      action: "auth.signin",
      target: `session:${input.sessionId}`,
      detail: { summary: `Signed in (${input.method})`, method: input.method, mfa: input.mfa },
      ip: input.ip,
      deviceId: `session:${input.sessionId}`,
    });
  }
}

export function sessionForToken(db: Db, token: string): SessionInfo | null {
  const hash = sha256(token);
  const row = db
    .prepare(
      "SELECT u.id, u.email, u.name, s.mfa_at, s.method, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended_at IS NULL",
    )
    .get(hash, Date.now()) as
    | { id: string; email: string; name: string; mfa_at: number | null; method: string; last_used_at: number | null }
    | undefined;
  if (row === undefined) return null;
  // Last use is kept to the minute, so the sessions list is useful without a write per request.
  if (row.last_used_at === null || Date.now() - row.last_used_at > 60_000) {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), hash);
  }
  return {
    hash,
    id: hash.slice(0, 16),
    user: { id: row.id, email: row.email, name: row.name },
    mfaAt: row.mfa_at,
    method: row.method,
  };
}

export function markSessionMfa(db: Db, sessionHash: string) {
  db.prepare("UPDATE sessions SET mfa_at = ? WHERE token_hash = ?").run(Date.now(), sessionHash);
}

export function sessionsOf(db: Db, userId: string) {
  return (
    db
      .prepare(
        `SELECT s.token_hash, s.label, s.created_at, s.last_used_at, s.ip, s.method, s.mfa_at,
                d.key_id, d.environment_id
         FROM sessions s LEFT JOIN device_keys d ON d.session_hash = s.token_hash AND d.revoked_at IS NULL
         WHERE s.user_id = ? AND s.expires_at > ? ORDER BY COALESCE(s.last_used_at, s.created_at) DESC`,
      )
      .all(userId, Date.now()) as Array<{
      token_hash: string;
      label: string;
      created_at: number;
      last_used_at: number | null;
      ip: string | null;
      method: string;
      mfa_at: number | null;
      key_id: string | null;
      environment_id: string | null;
    }>
  ).map((row) => ({
    id: row.token_hash.slice(0, 16),
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    ip: row.ip,
    method: row.method,
    twoFactor: row.mfa_at !== null,
    deviceKeyId: row.key_id,
    environmentId: row.environment_id,
  }));
}

/** Ends one session of this user by its public id; its device key stops being valid too. */
export function revokeSession(db: Db, userId: string, sessionId: string): { keyIds: Array<string> } | null {
  if (!/^[0-9a-f]{16}$/.test(sessionId)) return null;
  const row = db
    .prepare("SELECT token_hash FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?")
    .get(userId, sessionId) as { token_hash: string } | undefined;
  if (row === undefined) return null;
  return revokeSessionHash(db, row.token_hash);
}

/** Signing out: the session ends; its device key stays known (unusable without a session) so the
 * same machine can vouch for its next key. */
export function endSession(db: Db, hash: string) {
  db.prepare("UPDATE device_keys SET session_hash = NULL WHERE session_hash = ?").run(hash);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
}

export function revokeSessionHash(db: Db, hash: string): { keyIds: Array<string> } {
  const keys = db
    .prepare("SELECT key_id FROM device_keys WHERE session_hash = ? AND revoked_at IS NULL")
    .all(hash) as Array<{ key_id: string }>;
  db.prepare("UPDATE device_keys SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL").run(Date.now(), hash);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  return { keyIds: keys.map((key) => key.key_id) };
}

// ---- TOTP and recovery codes -----------------------------------------------------------------

export function totpState(db: Db, userId: string): { enabled: boolean; pending: boolean } {
  const row = db.prepare("SELECT enabled_at FROM totp WHERE user_id = ?").get(userId) as
    | { enabled_at: number | null }
    | undefined;
  return { enabled: row?.enabled_at != null, pending: row !== undefined && row.enabled_at === null };
}

/** Starts (or restarts) enrolment; the secret is confirmed by a first code before it counts. */
export function startTotp(db: Db, box: SecretBox, userId: string): string {
  const secret = newTotpSecret();
  db.prepare(
    "INSERT INTO totp (user_id, secret, enabled_at, last_step, created_at) VALUES (?, ?, NULL, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled_at = NULL, last_step = NULL, created_at = excluded.created_at WHERE totp.enabled_at IS NULL",
  ).run(userId, box.seal(secret), Date.now());
  return secret;
}

/** Checks a TOTP code (enabled or pending) and remembers its step so it cannot be replayed. */
export function checkTotp(db: Db, box: SecretBox, userId: string, code: string, nowMs = Date.now()): boolean {
  const row = db.prepare("SELECT secret, last_step FROM totp WHERE user_id = ?").get(userId) as
    | { secret: string; last_step: number | null }
    | undefined;
  if (row === undefined) return false;
  const step = verifyTotp(box.open(row.secret), code, row.last_step, nowMs);
  if (step === null) return false;
  db.prepare("UPDATE totp SET last_step = ? WHERE user_id = ?").run(step, userId);
  return true;
}

export function enableTotp(db: Db, userId: string): Array<string> {
  db.prepare("UPDATE totp SET enabled_at = ? WHERE user_id = ?").run(Date.now(), userId);
  return replaceRecoveryCodes(db, userId);
}

export function disableTotp(db: Db, userId: string) {
  db.prepare("DELETE FROM totp WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
}

export function replaceRecoveryCodes(db: Db, userId: string): Array<string> {
  const codes = newRecoveryCodes();
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
  for (const code of codes) insert.run(userId, sha256(`${userId}:${normalizeRecoveryCode(code)}`));
  return codes;
}

export function useRecoveryCode(db: Db, userId: string, code: string): boolean {
  const hash = sha256(`${userId}:${normalizeRecoveryCode(code)}`);
  const rows = db
    .prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .all(userId) as Array<{ code_hash: string }>;
  const match = rows.find((row) => safeEqualHex(row.code_hash, hash));
  if (match === undefined) return false;
  db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?").run(Date.now(), userId, match.code_hash);
  return true;
}

export function recoveryCodesLeft(db: Db, userId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as {
      n: number;
    }
  ).n;
}

// ---- Device keys -----------------------------------------------------------------------------

export interface DeviceKey {
  readonly keyId: string;
  readonly userId: string;
  readonly environmentId: string | null;
  readonly signPublicKey: string;
  readonly boxPublicKey: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revoked: boolean;
}

interface DeviceRow {
  key_id: string;
  user_id: string;
  environment_id: string | null;
  sign_public_key: string;
  box_public_key: string;
  label: string;
  created_at: number;
  revoked_at: number | null;
}

const toDevice = (row: DeviceRow): DeviceKey => ({
  keyId: row.key_id,
  userId: row.user_id,
  environmentId: row.environment_id,
  signPublicKey: row.sign_public_key,
  boxPublicKey: row.box_public_key,
  label: row.label,
  createdAt: new Date(row.created_at).toISOString(),
  revoked: row.revoked_at !== null,
});

/** Binds a device key to the session that registered it (one live key per session). */
export function registerDeviceKey(
  db: Db,
  input: {
    userId: string;
    sessionHash: string;
    environmentId: string | null;
    signPublicKey: string;
    boxPublicKey: string;
    label: string;
  },
): DeviceKey | { error: string } {
  const keyId = keyIdOf(input.signPublicKey);
  const existing = db.prepare("SELECT * FROM device_keys WHERE key_id = ?").get(keyId) as DeviceRow | undefined;
  if (existing !== undefined) {
    if (existing.user_id !== input.userId || existing.revoked_at !== null) {
      return { error: "This device key cannot be used." };
    }
    db.prepare("UPDATE device_keys SET session_hash = ?, environment_id = ? WHERE key_id = ?").run(
      input.sessionHash,
      input.environmentId,
      keyId,
    );
    return toDevice({ ...existing, environment_id: input.environmentId });
  }
  db.prepare("UPDATE device_keys SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL").run(Date.now(), input.sessionHash);
  db.prepare(
    "INSERT INTO device_keys (key_id, user_id, session_hash, environment_id, sign_public_key, box_public_key, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(keyId, input.userId, input.sessionHash, input.environmentId, input.signPublicKey, input.boxPublicKey, input.label.slice(0, 120), Date.now());
  return getDeviceKey(db, keyId)!;
}

export function getDeviceKey(db: Db, keyId: string): DeviceKey | null {
  const row = db.prepare("SELECT * FROM device_keys WHERE key_id = ?").get(keyId) as DeviceRow | undefined;
  return row === undefined ? null : toDevice(row);
}

/** The live key of a session, if it registered one. */
export function deviceKeyOfSession(db: Db, sessionHash: string): DeviceKey | null {
  const row = db
    .prepare("SELECT * FROM device_keys WHERE session_hash = ? AND revoked_at IS NULL")
    .get(sessionHash) as DeviceRow | undefined;
  return row === undefined ? null : toDevice(row);
}

export function deviceKeysOf(db: Db, userId: string): Array<DeviceKey & { certifiedBy: Array<string> }> {
  const rows = db
    .prepare("SELECT * FROM device_keys WHERE user_id = ? ORDER BY created_at")
    .all(userId) as unknown as Array<DeviceRow>;
  return rows.map((row) => ({ ...toDevice(row), certifiedBy: certsOf(db, row.key_id).map((cert) => cert.signerKeyId) }));
}

export function addDeviceCert(db: Db, keyId: string, signerKeyId: string, signature: string) {
  db.prepare(
    "INSERT INTO device_certs (key_id, signer_key_id, signature, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key_id, signer_key_id) DO UPDATE SET signature = excluded.signature",
  ).run(keyId, signerKeyId, signature, Date.now());
}

export function certsOf(db: Db, keyId: string) {
  return (
    db
      .prepare(
        "SELECT c.signer_key_id, c.signature, d.sign_public_key FROM device_certs c JOIN device_keys d ON d.key_id = c.signer_key_id WHERE c.key_id = ? AND d.revoked_at IS NULL",
      )
      .all(keyId) as Array<{ signer_key_id: string; signature: string; sign_public_key: string }>
  ).map((row) => ({ signerKeyId: row.signer_key_id, signerPublicKey: row.sign_public_key, signature: row.signature }));
}

// ---- OAuth sign-in state ---------------------------------------------------------------------

/** A login request without an e-mail yet; the provider callback fills it in and approves it. */
export function startOauthLogin(
  db: Db,
  input: { provider: string; verifier: string; nonce: string },
): { requestId: string; pollSecret: string; state: string } {
  const id = newId("lc");
  const pollSecret = newSecret("mp");
  const state = newSecret("st");
  const expires = Date.now() + OAUTH_TTL_MS;
  db.prepare(
    "INSERT INTO login_codes (id, email, code_hash, link_hash, poll_hash, expires_at, provider) VALUES (?, '', ?, ?, ?, ?, ?)",
  ).run(id, sha256(newSecret("x")), sha256(newSecret("x")), sha256(pollSecret), expires, input.provider);
  db.prepare(
    "INSERT INTO oauth_states (state_hash, provider, login_id, verifier, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sha256(state), input.provider, id, input.verifier, input.nonce, expires);
  return { requestId: id, pollSecret, state };
}

/** One use per state. */
export function takeOauthState(db: Db, state: string) {
  const hash = sha256(state);
  const row = db
    .prepare("SELECT provider, login_id, verifier, nonce FROM oauth_states WHERE state_hash = ? AND expires_at > ?")
    .get(hash, Date.now()) as { provider: string; login_id: string; verifier: string; nonce: string } | undefined;
  db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(hash);
  return row === undefined
    ? null
    : { provider: row.provider, loginId: row.login_id, verifier: row.verifier, nonce: row.nonce };
}

export function approveOauthLogin(db: Db, loginId: string, email: string) {
  db.prepare("UPDATE login_codes SET email = ?, approved_at = ? WHERE id = ? AND used_at IS NULL").run(email, Date.now(), loginId);
}

export function loginMethod(db: Db, requestId: string): string {
  const row = db.prepare("SELECT provider FROM login_codes WHERE id = ?").get(requestId) as
    | { provider: string }
    | undefined;
  return row?.provider ?? "email";
}
