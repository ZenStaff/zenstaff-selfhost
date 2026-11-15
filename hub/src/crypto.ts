import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Opaque bearer secrets: 256 bits, base64url. Only their SHA-256 is stored. */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Six digits, for typing into the app; the e-mail also carries a one-click link. */
export function newLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
