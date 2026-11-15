// The device signature on a relay call: the hub checks it (the session's own live device key, a
// fresh timestamp, a nonce used once) and hands the device and its certificates to the runner,
// which checks the signature again against keys it pinned itself. Shared by the share relay
// (routes/shares.ts) and the company runner relay (routes/companyObjects.ts).
import type { Db } from "./db.ts";
import { bad, forbidden, type Json } from "./http.ts";
import type { RelayRequest } from "./relay.ts";
import { parseRequestSignature, requestMessage, SIGNATURE_MAX_SKEW_MS, verifyEd25519 } from "./signing.ts";
import * as security from "./storeSecurity.ts";

export type SignedDevice = (
  session: security.SessionInfo,
  op: string,
  shareId: string,
  input: Json,
  rawSig: unknown,
) => { sig: NonNullable<RelayRequest["sig"]>; device: NonNullable<RelayRequest["device"]> };

export function makeSignedDevice(db: Db): SignedDevice {
  const seenNonces = new Map<string, number>();
  return (session, op, shareId, input, rawSig) => {
    const sig = parseRequestSignature(rawSig);
    if (sig === null) throw bad("This request must be signed by your device. Update Zen Staff and sign in again.");
    const device = security.deviceKeyOfSession(db, session.hash);
    if (device === null || device.keyId !== sig.keyId) throw forbidden("This device key does not belong to this session.");
    if (Math.abs(Date.now() - sig.ts) > SIGNATURE_MAX_SKEW_MS) throw forbidden("The request is too old. Check this computer's clock.");
    const now = Date.now();
    if ((seenNonces.get(sig.nonce) ?? 0) > now) throw forbidden("This request was already used.");
    const message = requestMessage({ op, shareId, userId: session.user.id, keyId: sig.keyId, ts: sig.ts, nonce: sig.nonce, payload: input });
    if (!verifyEd25519(device.signPublicKey, message, sig.signature)) throw forbidden("The request signature is not valid.");
    if (seenNonces.size > 50_000) for (const [nonce, until] of seenNonces) if (until <= now) seenNonces.delete(nonce);
    seenNonces.set(sig.nonce, now + 2 * SIGNATURE_MAX_SKEW_MS);
    return {
      sig,
      device: {
        userId: session.user.id,
        keyId: device.keyId,
        signPublicKey: device.signPublicKey,
        boxPublicKey: device.boxPublicKey,
        certs: security.certsOf(db, device.keyId),
      },
    };
  };
}
