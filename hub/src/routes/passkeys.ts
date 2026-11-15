// Passkeys (WebAuthn). The app asks for a ceremony link, opens it in the browser, and the hub's own
// page runs navigator.credentials.create (add a passkey, from a signed-in session) or .get (sign
// in: approves a pending login that the app collects by polling /v1/auth/poll, like OAuth).
//
// Two-factor: user verification is required in both ceremonies, so a passkey sign-in is
// possession plus fingerprint / face / PIN and the new session counts as two-factor (mfa_at set).
// Owners and admins still keep TOTP on (it is the fallback that has recovery codes); a passkey
// sign-in only saves them typing the code. Adding a passkey needs a full (two-factor) session.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type { Kit } from "../app.ts";
import { safeEqualHex, sha256 } from "../crypto.ts";
import { bad, clientIp, HttpError, makeLimiter, notFound, optStr, str, type Json } from "../http.ts";
import * as store from "../store.ts";
import * as passkeys from "../storePasskeys.ts";
import * as team from "../storeTeam.ts";
import {
  ceremonyPage,
  expiredPage,
  pageLanguage,
  parseLanguage,
  serveAsset,
  BROWSER_LIB_PATH,
  PAGE_SCRIPT_PATH,
  type WebauthnConfig,
} from "../webauthn.ts";

const CEREMONY_TIMEOUT_MS = 120_000;

const expired = () => new HttpError(400, "This passkey link expired. Start again from Zen Staff.", "passkey_expired");
const refused = (message = "The passkey was not accepted.") => new HttpError(400, message, "passkey_refused");

function credentialResponse(body: Json): Json {
  const response = body.response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) throw bad("Send the passkey response.");
  const value = response as Json;
  if (typeof value.id !== "string" || value.id.length > 1400 || typeof value.response !== "object" || value.response === null) {
    throw bad("Send the passkey response.");
  }
  return value;
}

export function registerPasskeyRoutes(kit: Kit, rp: WebauthnConfig) {
  const { db, config, route, notifier } = kit;
  const startLimiter = makeLimiter(config.loginLimitPer10Minutes ?? 10, 10 * 60_000);
  const registerLimiter = makeLimiter(10, 10 * 60_000, "Too many passkey requests. Wait a few minutes.");
  // The ceremony routes are public (the page has no session): per address, and five failures per link.
  const pageLimiter = makeLimiter(Math.max(60, config.loginLimitPer10Minutes ?? 0), 10 * 60_000);
  const failLimiter = makeLimiter(5, passkeys.CEREMONY_TTL_MS, "Too many failed attempts. Start again from Zen Staff.");

  const challengeMatches = (ceremony: passkeys.Ceremony) => (challenge: string) =>
    ceremony.challengeHash !== null && safeEqualHex(sha256(challenge), ceremony.challengeHash);

  const liveCeremony = (body: Json, kind: "register" | "login", ip: string) => {
    pageLimiter(`pk:${ip}`);
    const ceremony = passkeys.ceremonyForToken(db, str(body, "t", 200), kind);
    if (ceremony === null) throw expired();
    failLimiter.check(`pk:${ceremony.id}`);
    return ceremony;
  };

  const failed = (ceremony: passkeys.Ceremony, error: HttpError): never => {
    failLimiter(`pk:${ceremony.id}`);
    throw error;
  };

  // ---- Static files --------------------------------------------------------------------------

  kit.page(BROWSER_LIB_PATH, (_req, _url, res) => serveAsset(res, "lib"));
  kit.page(PAGE_SCRIPT_PATH, (_req, _url, res) => serveAsset(res, "page"));

  // ---- Add a passkey (signed in) -------------------------------------------------------------

  route("GET", "/v1/me/passkeys", ({ session }) => ({
    passkeys: passkeys.passkeysOf(db, session.user.id).map((passkey) => ({
      id: passkey.id,
      label: passkey.label,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      transports: passkey.transports,
      backedUp: passkey.backedUp,
      deviceType: passkey.deviceType,
    })),
  }), "signin");

  route("POST", "/v1/me/passkeys/register", ({ session, body }) => {
    registerLimiter(`register:${session.user.id}`);
    passkeys.pruneCeremonies(db);
    const lang = parseLanguage(body.lang);
    const label = optStr(body, "label", 120) ?? "Passkey";
    const started = passkeys.startRegistration(db, { userId: session.user.id, sessionHash: session.hash, label, lang });
    return {
      url: `${config.publicUrl}/v1/passkeys/register?t=${encodeURIComponent(started.token)}`,
      expiresAt: new Date(started.expiresAt).toISOString(),
    };
  });

  kit.page("/v1/passkeys/register", (req, url, res) => {
    const token = url.searchParams.get("t") ?? "";
    const ceremony = passkeys.ceremonyForToken(db, token, "register");
    const user = ceremony?.userId == null ? null : store.getUser(db, ceremony.userId);
    if (ceremony === null || user === null || ceremony.sessionHash === null || !passkeys.sessionExists(db, ceremony.sessionHash)) {
      return expiredPage(res, ceremony?.lang ?? pageLanguage(req, url));
    }
    ceremonyPage(res, { mode: "register", token, lang: ceremony.lang, email: user.email });
  });

  route("POST", "/v1/passkeys/register/options", async ({ body, req }) => {
    const ceremony = liveCeremony(body, "register", clientIp(req));
    const user = ceremony.userId === null ? null : store.getUser(db, ceremony.userId);
    if (user === null || ceremony.sessionHash === null || !passkeys.sessionExists(db, ceremony.sessionHash)) throw expired();
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: new Uint8Array(Buffer.from(passkeys.userHandleOf(db, user.id), "base64url")),
      attestationType: "none",
      timeout: CEREMONY_TIMEOUT_MS,
      excludeCredentials: passkeys.passkeysOf(db, user.id).map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    });
    passkeys.setChallenge(db, ceremony.id, options.challenge);
    return { options };
  }, "public");

  route("POST", "/v1/passkeys/register/finish", async ({ body, req }) => {
    const ceremony = liveCeremony(body, "register", clientIp(req));
    const response = credentialResponse(body);
    const user = ceremony.userId === null ? null : store.getUser(db, ceremony.userId);
    if (user === null || ceremony.sessionHash === null || !passkeys.sessionExists(db, ceremony.sessionHash)) throw expired();
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: challengeMatches(ceremony),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      });
    } catch {
      return failed(ceremony, refused());
    }
    if (!verification.verified) return failed(ceremony, refused());
    const info = verification.registrationInfo;
    if (!passkeys.consumeCeremony(db, ceremony.id)) throw expired();
    const added = passkeys.addPasskey(db, {
      userId: user.id,
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
      label: ceremony.label ?? "Passkey",
    });
    if ("error" in added) throw refused(added.error);
    team.audit(db, { companyId: null, actorUserId: user.id, action: "passkey.add", detail: `Passkey added: ${added.label}` });
    notifier.account(
      user.id,
      "A passkey was added to your Zen Staff account",
      `A passkey (${added.label}) was added to your Zen Staff account. It can now be used to sign in. If this was not you, remove it under Team > Account and sign out other sessions.`,
    );
    return { ok: true, id: added.id };
  }, "public");

  route("DELETE", "/v1/me/passkeys/:id", ({ session, params }) => {
    const removed = passkeys.deletePasskey(db, session.user.id, params.id!);
    if (removed === null) throw notFound("No such passkey.");
    team.audit(db, { companyId: null, actorUserId: session.user.id, action: "passkey.remove", detail: `Passkey removed: ${removed.label}` });
    notifier.account(
      session.user.id,
      "A passkey was removed from your Zen Staff account",
      `The passkey ${removed.label} was removed from your Zen Staff account and can no longer sign in. If this was not you, sign in, check your passkeys and sign out other sessions.`,
    );
    return { ok: true };
  });

  // ---- Sign in with a passkey ----------------------------------------------------------------

  route("POST", "/v1/auth/passkey/start", ({ body, req }) => {
    startLimiter(`passkey:${clientIp(req)}`);
    passkeys.pruneCeremonies(db);
    const started = passkeys.startLogin(db, parseLanguage(body.lang));
    return {
      requestId: started.requestId,
      pollSecret: started.pollSecret,
      url: `${config.publicUrl}/v1/passkeys/login?t=${encodeURIComponent(started.token)}`,
      expiresAt: new Date(started.expiresAt).toISOString(),
    };
  }, "public");

  kit.page("/v1/passkeys/login", (req, url, res) => {
    const token = url.searchParams.get("t") ?? "";
    const ceremony = passkeys.ceremonyForToken(db, token, "login");
    if (ceremony === null) return expiredPage(res, pageLanguage(req, url));
    ceremonyPage(res, { mode: "login", token, lang: ceremony.lang });
  });

  route("POST", "/v1/passkeys/login/options", async ({ body, req }) => {
    const ceremony = liveCeremony(body, "login", clientIp(req));
    // Discoverable credentials: no allow list, the authenticator offers this hub's passkeys.
    const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: "required", timeout: CEREMONY_TIMEOUT_MS });
    passkeys.setChallenge(db, ceremony.id, options.challenge);
    return { options };
  }, "public");

  route("POST", "/v1/passkeys/login/finish", async ({ body, req }) => {
    const ceremony = liveCeremony(body, "login", clientIp(req));
    const response = credentialResponse(body);
    const passkey = passkeys.passkeyByCredentialId(db, response.id as string);
    if (passkey === null) return failed(ceremony, refused("This passkey is not registered on this hub; it may have been removed."));
    const inner = response.response as Json;
    if (typeof inner.userHandle === "string" && inner.userHandle !== "" && passkeys.userIdOfHandle(db, inner.userHandle) !== passkey.userId) {
      return failed(ceremony, refused());
    }
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challengeMatches(ceremony),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: passkey.credentialId, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
        requireUserVerification: true,
      });
    } catch {
      // Includes a signature counter that went backwards (a cloned authenticator).
      return failed(ceremony, refused());
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) return failed(ceremony, refused());
    const user = store.getUser(db, passkey.userId);
    if (user === null || ceremony.loginId === null) throw expired();
    if (!passkeys.consumeCeremony(db, ceremony.id)) throw expired();
    passkeys.touchPasskey(db, passkey.id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp);
    passkeys.approvePasskeyLogin(db, ceremony.loginId, user.email);
    return { ok: true };
  }, "public");
}
