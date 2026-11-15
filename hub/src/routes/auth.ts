// Sign-in (e-mail code, magic link, Google, Microsoft; passkeys are in passkeys.ts), two-factor authentication, device keys,
// the sessions list, and the person's own profile and preferences.
import { htmlPage, type Kit } from "../app.ts";
import { acceptLanguage, asLanguage, bad, clientIp, socketIp, forbidden, HttpError, makeLimiter, notFound, optStr, str, type Ctx } from "../http.ts";
import { authorizeUrl, checkIdToken, exchangeCode, newNonce, pkcePair } from "../oauth.ts";
import { signInMail } from "../mailTemplates.ts";
import * as policy from "../policy.ts";
import { deviceCertMessage, isPublicKey, verifyEd25519 } from "../signing.ts";
import * as store from "../store.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";
import { qrSvgPath } from "../qrCode.ts";
import { otpauthUri } from "../totp.ts";
import { makeAdminGate } from "./admin.ts";

export function registerAuthRoutes(kit: Kit) {
  const adminGate = makeAdminGate(kit);
  const { db, mailer, config, route, notifier, box, relay } = kit;
  const loginLimiter = kit.loginLimiter;
  // Six digits: five wrong codes per person per 10 minutes, whatever session they come from.
  const totpLimiter = makeLimiter(5, 10 * 60_000, "Too many wrong codes. Wait 10 minutes.");

  const twoFactorStatus = (session: security.SessionInfo) => {
    const roles = team.rolesOfUser(db, session.user.id);
    const totp = security.totpState(db, session.user.id);
    return {
      enabled: totp.enabled,
      required: policy.requiresTwoFactor(roles),
      sessionVerified: session.mfaAt !== null,
      gate: policy.twoFactorGate({ roles, totpEnabled: totp.enabled, sessionVerified: session.mfaAt !== null }),
      recoveryCodesLeft: totp.enabled ? security.recoveryCodesLeft(db, session.user.id) : 0,
    };
  };

  // A passkey sign-in is user-verified (see routes/passkeys.ts), so its session counts as two-factor.
  const finishLogin = (email: string, label: string, ip: string, method: string) => {
    const user = store.upsertUser(db, email);
    const mfa = method === "passkey";
    const token = security.createSession(db, { userId: user.id, label, ip, method, mfa });
    const roles = team.rolesOfUser(db, user.id);
    const gate = policy.twoFactorGate({
      roles,
      totpEnabled: security.totpState(db, user.id).enabled,
      sessionVerified: mfa,
    });
    return { token, user, twoFactor: gate };
  };

  // ---- E-mail code and magic link ----------------------------------------------------------

  route(
    "POST",
    "/v1/auth/start",
    async ({ body, req }) => {
      const email = store.normalizeEmail(str(body, "email", 254));
      if (email === null) throw bad("Enter a valid e-mail address.");
      loginLimiter(`start:${clientIp(req)}`);
      loginLimiter(`start:${email}`);
      const login = store.startLogin(db, email);
      const link = `${config.publicUrl}/v1/auth/link?l=${encodeURIComponent(login.link)}`;
      // The page the person is on (the dashboard sends its language), else the account's, else the browser's.
      const lang = asLanguage(body.lang) ?? team.languageOfEmail(db, email) ?? acceptLanguage(req);
      await mailer.send({ to: email, ...signInMail(lang, { code: login.code, link, publicUrl: config.publicUrl }) });
      return { requestId: login.id, pollSecret: login.pollSecret };
    },
    "public",
  );

  route(
    "POST",
    "/v1/auth/verify",
    ({ body, req }) => {
      const email = store.normalizeEmail(str(body, "email", 254));
      if (email === null) throw bad("Enter a valid e-mail address.");
      loginLimiter(`verify:${clientIp(req)}`);
      const verified = store.verifyLoginCode(db, email, str(body, "code", 12));
      if (verified === null) throw new HttpError(401, "That code is wrong or expired.");
      return finishLogin(verified, optStr(body, "label", 120) ?? "Zen Staff", clientIp(req), "email");
    },
    "public",
  );

  route(
    "POST",
    "/v1/auth/poll",
    ({ body, req }) => {
      const requestId = str(body, "requestId", 80);
      const email = store.pollLogin(db, requestId, str(body, "pollSecret", 200));
      if (email === null) return { pending: true };
      return {
        pending: false,
        ...finishLogin(email, optStr(body, "label", 120) ?? "Zen Staff", clientIp(req), security.loginMethod(db, requestId)),
      };
    },
    "public",
  );

  kit.page("/v1/auth/link", (_req, url, res) => {
    const ok = store.approveLoginLink(db, url.searchParams.get("l") ?? "") !== null;
    htmlPage(
      res,
      ok ? 200 : 400,
      ok ? "Signed in" : "This link expired",
      ok ? "Go back to Zen Staff; it finishes signing in by itself." : "Ask for a new sign-in e-mail from Zen Staff.",
    );
  });

  // ---- Google and Microsoft ----------------------------------------------------------------

  route(
    "GET",
    "/v1/auth/providers",
    () => ({ providers: kit.oauth.map((provider) => ({ id: provider.id, name: provider.name })), passkeys: true }),
    "public",
  );

  const redirectUri = `${config.publicUrl}/v1/auth/oauth/callback`;

  route(
    "POST",
    "/v1/auth/oauth/start",
    ({ body, req }) => {
      const provider = kit.oauth.find((candidate) => candidate.id === str(body, "provider", 20));
      if (provider === undefined) throw notFound("That sign-in method is not set up on this hub.");
      loginLimiter(`oauth:${clientIp(req)}`);
      const { verifier, challenge } = pkcePair();
      const nonce = newNonce();
      const started = security.startOauthLogin(db, { provider: provider.id, verifier, nonce });
      return {
        requestId: started.requestId,
        pollSecret: started.pollSecret,
        url: authorizeUrl(provider, { redirectUri, state: started.state, nonce, challenge }),
      };
    },
    "public",
  );

  kit.page("/v1/auth/oauth/callback", async (_req, url, res) => {
    const state = security.takeOauthState(db, url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    const provider = kit.oauth.find((candidate) => candidate.id === state?.provider);
    if (state === null || provider === undefined || code === null) {
      return htmlPage(res, 400, "This sign-in expired", "Start again from Zen Staff.");
    }
    let claims: Record<string, unknown> | null = null;
    try {
      claims = await exchangeCode(provider, { code, redirectUri, verifier: state.verifier });
    } catch {
      claims = null;
    }
    if (claims === null) return htmlPage(res, 502, "Sign-in failed", `${provider.name} did not confirm the sign-in. Try again.`);
    const checked = checkIdToken(provider, claims, state.nonce);
    if ("error" in checked) return htmlPage(res, 400, "Sign-in refused", checked.error);
    const email = store.normalizeEmail(checked.email);
    if (email === null) return htmlPage(res, 400, "Sign-in refused", "That account has no usable e-mail address.");
    security.approveOauthLogin(db, state.loginId, email);
    return htmlPage(res, 200, "Signed in", "Go back to Zen Staff; it finishes signing in by itself.");
  });

  route("POST", "/v1/auth/logout", ({ session }) => {
    security.endSession(db, session.hash);
    return { ok: true };
  }, "signin");

  kit.page("/v1/dev/outbox", (req, url, res) => {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socketIp(req));
    if (!config.devOutbox || mailer.outbox === null || !loopback) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found." }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ messages: mailer.outbox.get(url.searchParams.get("email") ?? "") ?? [] }));
  });

  // ---- Two-factor authentication -----------------------------------------------------------

  route("GET", "/v1/auth/totp", ({ session }) => twoFactorStatus(session), "signin");

  route("POST", "/v1/auth/totp/setup", ({ session }) => {
    if (security.totpState(db, session.user.id).enabled) throw bad("Two-factor authentication is already on.");
    const secret = security.startTotp(db, box, session.user.id);
    const uri = otpauthUri(secret, session.user.email);
    // `qr`: the same address as an SVG path, so the web dashboard draws it without a QR library.
    return { secret, uri, qr: qrSvgPath(uri) };
  }, "signin");

  route("POST", "/v1/auth/totp/enable", ({ session, body }) => {
    if (security.totpState(db, session.user.id).enabled) throw bad("Two-factor authentication is already on.");
    totpLimiter.check(`totp:${session.user.id}`);
    if (!security.checkTotp(db, box, session.user.id, str(body, "code", 12))) {
      totpLimiter(`totp:${session.user.id}`);
      throw new HttpError(401, "That code is wrong. Check the time on your phone and try again.");
    }
    const recoveryCodes = security.enableTotp(db, session.user.id);
    security.markSessionMfa(db, session.hash);
    notifier.account(session.user.id, "Two-factor authentication is on", "Two-factor authentication was turned on for your Zen Staff account. Keep your recovery codes somewhere safe.");
    return { recoveryCodes };
  }, "signin");

  const checkSecondFactor = (ctx: Ctx): "totp" | "recovery" => {
    const userId = ctx.session.user.id;
    totpLimiter.check(`totp:${userId}`);
    const code = optStr(ctx.body, "code", 12);
    const recovery = optStr(ctx.body, "recoveryCode", 20);
    if (code !== null && security.checkTotp(db, box, userId, code)) return "totp";
    if (recovery !== null && security.useRecoveryCode(db, userId, recovery)) return "recovery";
    // Only wrong codes count towards the limit.
    totpLimiter(`totp:${userId}`);
    throw new HttpError(401, "That code is wrong or was already used.");
  };

  route("POST", "/v1/auth/totp/verify", (ctx) => {
    if (!security.totpState(db, ctx.session.user.id).enabled) throw bad("Two-factor authentication is off.");
    const how = checkSecondFactor(ctx);
    security.markSessionMfa(db, ctx.session.hash);
    if (how === "recovery") {
      notifier.account(ctx.session.user.id, "A recovery code was used", `A recovery code was used to sign in to Zen Staff. ${security.recoveryCodesLeft(db, ctx.session.user.id)} codes are left.`);
    }
    return { ok: true, recoveryCodesLeft: security.recoveryCodesLeft(db, ctx.session.user.id) };
  }, "signin");

  route("POST", "/v1/auth/totp/recovery-codes", (ctx) => {
    if (!security.totpState(db, ctx.session.user.id).enabled) throw bad("Two-factor authentication is off.");
    checkSecondFactor(ctx);
    return { recoveryCodes: security.replaceRecoveryCodes(db, ctx.session.user.id) };
  });

  route("POST", "/v1/auth/totp/disable", (ctx) => {
    if (!policy.canDisableTwoFactor(team.rolesOfUser(db, ctx.session.user.id))) {
      throw forbidden("Owners and admins must keep two-factor authentication on.");
    }
    checkSecondFactor(ctx);
    security.disableTotp(db, ctx.session.user.id);
    notifier.account(ctx.session.user.id, "Two-factor authentication is off", "Two-factor authentication was turned off for your Zen Staff account. If this was not you, sign in, turn it back on and sign out other sessions.");
    return { ok: true };
  });

  // ---- Device keys and sessions ------------------------------------------------------------

  route("POST", "/v1/me/device", ({ session, body }) => {
    const signPublicKey = body.signPublicKey;
    const boxPublicKey = body.boxPublicKey;
    if (!isPublicKey(signPublicKey) || !isPublicKey(boxPublicKey)) throw bad("Send the device's public keys.");
    const environmentId = optStr(body, "environmentId", 80);
    if (environmentId !== null) {
      const environment = store.getEnvironment(db, environmentId);
      if (environment === null || environment.ownerUserId !== session.user.id) throw notFound("No such machine.");
    }
    const registered = security.registerDeviceKey(db, {
      userId: session.user.id,
      sessionHash: session.hash,
      environmentId,
      signPublicKey,
      boxPublicKey,
      label: optStr(body, "label", 120) ?? "Zen Staff",
    });
    if ("error" in registered) throw forbidden(registered.error);
    const others = security.deviceKeysOf(db, session.user.id).filter((key) => !key.revoked && key.keyId !== registered.keyId);
    if (others.length > 0) {
      notifier.account(session.user.id, "New device signed in to Zen Staff", `A new device signed in to your Zen Staff account: ${registered.label}. If this was you, approve it under Team > Security on one of your other devices. If not, sign out that session there.`);
    }
    return { keyId: registered.keyId };
  }, "signin");

  route("GET", "/v1/me/devices", ({ session }) => ({
    devices: security.deviceKeysOf(db, session.user.id).map((key) => ({
      keyId: key.keyId,
      label: key.label,
      environmentId: key.environmentId,
      createdAt: key.createdAt,
      revoked: key.revoked,
      signPublicKey: key.signPublicKey,
      boxPublicKey: key.boxPublicKey,
      certifiedBy: key.certifiedBy,
      current: security.deviceKeyOfSession(db, session.hash)?.keyId === key.keyId,
    })),
  }), "signin");

  // One device vouches for another of the same person; runners that already trust the first
  // then trust the second. The hub checks the signature but cannot make one itself.
  route("POST", "/v1/me/devices/:keyId/certify", ({ session, params, body }) => {
    // The signer is this session's device, or another (not signed-out) device of the same person,
    // e.g. the key this machine used before it signed in again.
    const signerKeyId = optStr(body, "signerKeyId", 40);
    const signer = signerKeyId === null ? security.deviceKeyOfSession(db, session.hash) : security.getDeviceKey(db, signerKeyId);
    if (signer === null || signer.userId !== session.user.id || signer.revoked) throw bad("That signing device is not available.");
    const target = security.getDeviceKey(db, params.keyId!);
    if (target === null || target.userId !== session.user.id || target.revoked) throw notFound("No such device.");
    if (target.keyId === signer.keyId) throw bad("A device cannot approve itself.");
    const signature = str(body, "signature", 200);
    const message = deviceCertMessage({
      userId: session.user.id,
      keyId: target.keyId,
      signPublicKey: target.signPublicKey,
      boxPublicKey: target.boxPublicKey,
    });
    if (!verifyEd25519(signer.signPublicKey, message, signature)) throw bad("The approval signature is not valid.");
    security.addDeviceCert(db, target.keyId, signer.keyId, signature);
    return { ok: true };
  }, "signin");

  route("GET", "/v1/me/sessions", ({ session }) => ({
    sessions: security.sessionsOf(db, session.user.id).map((item) => ({ ...item, current: item.id === session.id })),
  }), "signin");

  route("DELETE", "/v1/me/sessions/:id", ({ session, params }) => {
    const revoked = security.revokeSession(db, session.user.id, params.id!);
    if (revoked === null) throw notFound("No such session.");
    relay.broadcastDeviceRevoked(session.user.id, revoked.keyIds);
    return { ok: true };
  }, "signin");

  // ---- Me ----------------------------------------------------------------------------------

  route("GET", "/v1/me", ({ session }) => {
    const user = session.user;
    return {
      user,
      companies: store.companiesOf(db, user.id),
      environments: store.environmentsOf(db, user.id).map((environment) => ({
        ...environment,
        online: relay.isOnline(environment.id),
        // v9: every company this machine serves, each with its own AI account. `runnerCompanyId`
        // and `aiAccount` keep the first one for older apps.
        runnerCompanyId: environment.runnerCompanyIds[0] ?? null,
        runners: environment.runnerCompanyIds.map((companyId) => ({ companyId, aiAccount: team.aiAccountOf(db, environment.id, companyId) })),
        aiAccount: environment.runnerCompanyIds[0] === undefined ? null : team.aiAccountOf(db, environment.id, environment.runnerCompanyIds[0]),
      })),
      invites: store.invitesForEmail(db, user.email),
      twoFactor: twoFactorStatus(session),
      preferences: team.preferencesOf(db, user.id),
      unreadNotifications: team.unreadCount(db, user.id),
      signInMethods: ["email", ...kit.oauth.map((provider) => provider.id), "passkey"],
      // Platform staff (/app/admin): their roles and what each tab needs; null for everyone else.
      ...(() => {
        const staff = adminGate.staffOf(session);
        return { canSeeStats: staff.caps.includes("stats"), admin: staff.roles.length === 0 ? null : { roles: staff.roles, caps: staff.caps } };
      })(),
    };
  }, "signin");

  route("PATCH", "/v1/me", ({ session, body }) => {
    store.setUserName(db, session.user.id, str(body, "name", 80));
    return { ok: true };
  });

  route("GET", "/v1/me/preferences", ({ session }) => team.preferencesOf(db, session.user.id));

  route("PUT", "/v1/me/preferences", ({ session, body }) => {
    const edition = body.edition;
    const language = body.language;
    if (edition !== undefined && edition !== null && edition !== "office" && edition !== "code") throw bad("edition must be office or code.");
    if (language !== undefined && language !== null && language !== "en" && language !== "ro") throw bad("language must be en or ro.");
    if (body.notifyEmail !== undefined && typeof body.notifyEmail !== "boolean") throw bad("notifyEmail must be true or false.");
    team.setPreferences(db, session.user.id, {
      ...(edition === undefined ? {} : { edition: edition as team.Edition | null }),
      ...(language === undefined ? {} : { language: language as team.Language | null }),
      ...(body.notifyEmail === undefined ? {} : { notifyEmail: body.notifyEmail as boolean }),
    });
    return team.preferencesOf(db, session.user.id);
  });
}
