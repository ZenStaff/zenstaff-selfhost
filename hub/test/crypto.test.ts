import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import { makeSecretBox } from "../src/secretBox.ts";
import {
  canonicalJson,
  deviceCertMessage,
  fingerprintOf,
  keyIdOf,
  parseRequestSignature,
  requestMessage,
  statementMessage,
  verifyEd25519,
} from "../src/signing.ts";
import { base32Decode, base32Encode, newRecoveryCodes, otpauthUri, totpAt, verifyTotp } from "../src/totp.ts";

describe("TOTP", () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (the 6-digit tail of the 8-digit values).
  const seed = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the RFC 6238 test vectors", () => {
    assert.equal(seed, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(totpAt(seed, Math.floor(59 / 30)), "287082");
    assert.equal(totpAt(seed, Math.floor(1111111109 / 30)), "081804");
    assert.equal(totpAt(seed, Math.floor(1234567890 / 30)), "005924");
    assert.equal(totpAt(seed, Math.floor(2000000000 / 30)), "279037");
  });
  it("accepts one step of drift and refuses replays and older steps", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    assert.equal(verifyTotp(seed, totpAt(seed, step), null, now), step);
    assert.equal(verifyTotp(seed, totpAt(seed, step - 1), null, now), step - 1);
    assert.equal(verifyTotp(seed, totpAt(seed, step + 1), null, now), step + 1);
    assert.equal(verifyTotp(seed, totpAt(seed, step - 2), null, now), null);
    assert.equal(verifyTotp(seed, totpAt(seed, step), step, now), null, "same code twice");
    assert.equal(verifyTotp(seed, totpAt(seed, step - 1), step, now), null, "older code after a newer one");
    assert.equal(verifyTotp(seed, "12345", null, now), null);
    assert.equal(verifyTotp(seed, "abcdef", null, now), null);
  });
  it("round-trips base32 and builds an authenticator URI", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
    assert.match(otpauthUri(seed, "a@b.example"), /^otpauth:\/\/totp\/Zen%20Staff%3Aa%40b\.example\?secret=GEZ/);
  });
  it("recovery codes are distinct and readable", () => {
    const codes = newRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });
});

describe("secret box", () => {
  it("encrypts with a key and refuses to open without it", () => {
    const box = makeSecretBox(Buffer.alloc(32, 7).toString("base64"));
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    assert.match(sealed, /^enc1:/);
    assert.equal(box.open(sealed), "JBSWY3DPEHPK3PXP");
    assert.throws(() => makeSecretBox(undefined).open(sealed));
    assert.throws(() => makeSecretBox(Buffer.alloc(16).toString("base64")));
    assert.equal(makeSecretBox(undefined).seal("x"), "x");
  });
});

describe("signing", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" }).x!;
  const signText = (text: string) => sign(null, Buffer.from(text), pair.privateKey).toString("base64url");

  it("canonical JSON sorts keys, drops undefined, keeps arrays in order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: "x" }, z: undefined }), '{"a":{"c":"x","d":[3,1]},"b":1}');
    assert.equal(canonicalJson(null), "null");
    assert.throws(() => canonicalJson({ a: Number.NaN }));
  });

  it("pins the request message format (shared with the app's hubCrypto.ts)", () => {
    const message = requestMessage({
      op: "thread.prompt",
      shareId: "sh_1",
      userId: "usr_1",
      keyId: "k1",
      ts: 1_700_000_000_000,
      nonce: "nonce-nonce-nonce-1",
      payload: { text: "Salut" },
    });
    assert.equal(
      message,
      'zen-hub-request-v1\n{"body":"hL-zmRevZWgMIZXg8NsKC69TR1uR8Iz0_fUW4h7GKBg","keyId":"k1","nonce":"nonce-nonce-nonce-1","op":"thread.prompt","shareId":"sh_1","ts":1700000000000,"userId":"usr_1"}',
    );
    assert.match(deviceCertMessage({ userId: "u", keyId: "k", signPublicKey: "s", boxPublicKey: "b" }), /^zen-hub-device-v1\n\{"boxPublicKey":"b"/);
    assert.match(statementMessage({ action: "grant" }), /^zen-hub-statement-v1\n/);
  });

  it("verifies Ed25519 signatures and refuses tampering", () => {
    const message = requestMessage({ op: "thread.view", shareId: "s", userId: "u", keyId: keyIdOf(publicKey), ts: 1, nonce: "n".repeat(16), payload: {} });
    const signature = signText(message);
    assert.equal(verifyEd25519(publicKey, message, signature), true);
    assert.equal(verifyEd25519(publicKey, `${message} `, signature), false);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    assert.equal(verifyEd25519(other, message, signature), false);
    assert.equal(verifyEd25519("not-a-key", message, signature), false);
    assert.equal(keyIdOf(publicKey).length, 22);
  });

  it("shows the same device fingerprint as the app (test vector shared with hubCrypto.ts)", () => {
    assert.equal(fingerprintOf(Buffer.alloc(32, 7).toString("base64url")), "4BB0 6F8E 4E3A 7715 D201 D573 D0AA 4237");
  });

  it("parses only well-formed signatures", () => {
    assert.equal(parseRequestSignature(null), null);
    assert.equal(parseRequestSignature({ keyId: "k", ts: 1.5, nonce: "x".repeat(16), signature: "s" }), null);
    assert.equal(parseRequestSignature({ keyId: "k", ts: 1, nonce: "short", signature: "s" }), null);
    assert.deepEqual(parseRequestSignature({ keyId: "k", ts: 1, nonce: "x".repeat(16), signature: "s" }), {
      keyId: "k",
      ts: 1,
      nonce: "x".repeat(16),
      signature: "s",
    });
  });
});
