// A software WebAuthn authenticator for the tests: ES256 (P-256) keys, attestation "none",
// clientDataJSON / authenticatorData built by hand, assertion signatures over
// authenticatorData || SHA-256(clientDataJSON), as a browser and a platform authenticator would.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

// ---- Minimal CBOR encoder (unsigned / negative ints, byte and text strings, maps) ------------

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const parts: Array<Buffer> = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

// ---- The authenticator ---------------------------------------------------------------------

export interface SoftPasskey {
  readonly credentialId: Uint8Array;
  readonly privateKey: KeyObject;
  readonly userHandle: string;
  readonly rpId: string;
  counter: number;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function authData(rpId: string, flags: number, counter: number, attested?: Buffer): Buffer {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), counterBytes, ...(attested === undefined ? [] : [attested])]);
}

function clientData(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}

/** navigator.credentials.create(): returns the passkey and the RegistrationResponseJSON. */
export function createCredential(
  options: { challenge: string; rp: { id?: string }; user: { id: string } },
  input: { origin: string; rpId?: string; userVerified?: boolean; counter?: number },
) {
  const rpId = input.rpId ?? options.rp.id!;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = cbor(
    new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const credentialId = randomBytes(16);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, coseKey]);
  const counter = input.counter ?? 0;
  const flags = FLAG_UP | FLAG_AT | (input.userVerified === false ? 0 : FLAG_UV);
  const attestationObject = cbor(
    new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData(rpId, flags, counter, attested)],
    ]),
  );
  const passkey: SoftPasskey = { credentialId, privateKey, userHandle: options.user.id, rpId, counter };
  const response = {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: b64url(clientData("webauthn.create", options.challenge, input.origin)),
      attestationObject: b64url(attestationObject),
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
  return { passkey, response };
}

/** navigator.credentials.get(): an assertion; the counter goes up by one unless given. */
export function getAssertion(
  passkey: SoftPasskey,
  options: { challenge: string },
  input: { origin: string; rpId?: string; counter?: number; userVerified?: boolean; userHandle?: string | null },
) {
  passkey.counter = input.counter ?? passkey.counter + 1;
  const data = authData(input.rpId ?? passkey.rpId, FLAG_UP | (input.userVerified === false ? 0 : FLAG_UV), passkey.counter);
  const client = clientData("webauthn.get", options.challenge, input.origin);
  const signature = sign("sha256", Buffer.concat([data, sha256(client)]), passkey.privateKey);
  return {
    id: b64url(passkey.credentialId),
    rawId: b64url(passkey.credentialId),
    type: "public-key",
    response: {
      clientDataJSON: b64url(client),
      authenticatorData: b64url(data),
      signature: b64url(signature),
      ...(input.userHandle === null ? {} : { userHandle: input.userHandle ?? passkey.userHandle }),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}
