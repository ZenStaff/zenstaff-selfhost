// Signed client requests. Each signed-in device (a Zen Staff server) creates an Ed25519 key at
// sign-in and registers its public half here. Relay requests carry the device's signature over the
// exact op, share and input the runner will receive; the runner verifies it against keys it pinned
// itself, so a compromised hub cannot forge a prompt as a user. The hub checks the same signature
// first (defence in depth, and so a stolen session alone cannot send unsigned requests).
//
// The app has the same rules in apps/server/src/zen/hub/hubCrypto.ts; test vectors pin both.
import { createHash, createPublicKey, verify } from "node:crypto";

export const SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

/** JSON with sorted keys and no whitespace: the bytes both sides sign and verify. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("not canonical");
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256b64(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Key id = first 16 bytes of SHA-256 over the raw public key, base64url. */
export function keyIdOf(signPublicKey: string): string {
  return createHash("sha256").update(Buffer.from(signPublicKey, "base64url")).digest("base64url").slice(0, 22);
}

/**
 * What people compare out of band when a runner asks to approve a new device: the first 16 bytes
 * of SHA-256 over the raw signing key, as 8 groups of 4 hex digits ("3F2A 9C01 ...").
 */
export function fingerprintOf(signPublicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(signPublicKey, "base64url")).digest("hex").slice(0, 32).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

export interface RequestSignature {
  readonly keyId: string;
  readonly ts: number;
  readonly nonce: string;
  readonly signature: string;
}

/** What a device signs for one relay request. */
export function requestMessage(input: {
  readonly op: string;
  readonly shareId: string;
  readonly userId: string;
  readonly keyId: string;
  readonly ts: number;
  readonly nonce: string;
  readonly payload: unknown;
}): string {
  return `zen-hub-request-v1\n${canonicalJson({
    op: input.op,
    shareId: input.shareId,
    userId: input.userId,
    keyId: input.keyId,
    ts: input.ts,
    nonce: input.nonce,
    body: sha256b64(canonicalJson(input.payload ?? null)),
  })}`;
}

/** One device vouches for another device of the same person. */
export function deviceCertMessage(input: {
  readonly userId: string;
  readonly keyId: string;
  readonly signPublicKey: string;
  readonly boxPublicKey: string;
}): string {
  return `zen-hub-device-v1\n${canonicalJson(input)}`;
}

/** An admin's statement (Enterprise grant, install approval), signed by their device. */
export function statementMessage(statement: Record<string, unknown>): string {
  return `zen-hub-statement-v1\n${canonicalJson(statement)}`;
}

export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function parseRequestSignature(value: unknown): RequestSignature | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.keyId !== "string" ||
    raw.keyId.length > 40 ||
    typeof raw.ts !== "number" ||
    !Number.isInteger(raw.ts) ||
    typeof raw.nonce !== "string" ||
    raw.nonce.length < 16 ||
    raw.nonce.length > 64 ||
    typeof raw.signature !== "string" ||
    raw.signature.length > 200
  ) {
    return null;
  }
  return { keyId: raw.keyId, ts: raw.ts, nonce: raw.nonce, signature: raw.signature };
}
