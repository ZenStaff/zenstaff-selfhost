// Encryption at rest for the few secrets the hub must be able to read back (TOTP seeds).
// HUB_SECRET_KEY = 32 random bytes, base64 (`openssl rand -base64 32`). Without it, values are
// stored as given (README says to set it in production); values written with a key are prefixed
// `enc1:` so a later key change is detected instead of silently failing.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretBox {
  seal(plain: string): string;
  open(stored: string): string;
  readonly encrypted: boolean;
}

export function makeSecretBox(keyBase64: string | undefined): SecretBox {
  const key = keyBase64 === undefined || keyBase64 === "" ? null : Buffer.from(keyBase64, "base64");
  if (key !== null && key.length !== 32) throw new Error("HUB_SECRET_KEY must be 32 bytes, base64.");
  return {
    encrypted: key !== null,
    seal(plain) {
      if (key === null) return plain;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
    },
    open(stored) {
      if (!stored.startsWith("enc1:")) return stored;
      if (key === null) throw new Error("This secret is encrypted; set HUB_SECRET_KEY.");
      const raw = Buffer.from(stored.slice(5), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
