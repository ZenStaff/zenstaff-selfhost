// Sign in with Google or Microsoft (OpenID Connect, authorization code + PKCE). Each provider is
// on only when its client id and secret are set. The app starts the sign-in, opens the returned
// address in the browser, and collects the session by polling, exactly like the e-mail link.
//
// The ID token comes straight from the provider's token endpoint over TLS, so its issuer is
// authenticated by TLS (OpenID Connect Core 3.1.3.7); its claims (issuer, audience, expiry, nonce,
// verified e-mail) are still checked here.
import { createHash, randomBytes } from "node:crypto";

export interface OauthProvider {
  readonly id: "google" | "microsoft";
  readonly name: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Returns the verified e-mail, or an error the person can act on. */
  readonly emailFrom: (claims: Record<string, unknown>) => { email: string } | { error: string };
  readonly issuerOk: (issuer: string) => boolean;
}

/** Personal Microsoft accounts (outlook.com, hotmail.com) live in this tenant. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export function oauthProvidersFromEnv(env: NodeJS.ProcessEnv): Array<OauthProvider> {
  const providers: Array<OauthProvider> = [];
  if (env.HUB_GOOGLE_CLIENT_ID && env.HUB_GOOGLE_CLIENT_SECRET) {
    providers.push({
      id: "google",
      name: "Google",
      authorizeUrl: env.HUB_GOOGLE_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: env.HUB_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
      clientId: env.HUB_GOOGLE_CLIENT_ID,
      clientSecret: env.HUB_GOOGLE_CLIENT_SECRET,
      issuerOk: (issuer) =>
        env.HUB_GOOGLE_ISSUER !== undefined
          ? issuer === env.HUB_GOOGLE_ISSUER
          : issuer === "https://accounts.google.com" || issuer === "accounts.google.com",
      emailFrom: (claims) =>
        typeof claims.email === "string" && claims.email_verified === true
          ? { email: claims.email }
          : { error: "Google did not confirm this e-mail address." },
    });
  }
  if (env.HUB_MICROSOFT_CLIENT_ID && env.HUB_MICROSOFT_CLIENT_SECRET) {
    const tenant = (env.HUB_MICROSOFT_TENANT?.trim() || "common");
    const base = env.HUB_MICROSOFT_BASE_URL ?? "https://login.microsoftonline.com";
    providers.push({
      id: "microsoft",
      name: "Microsoft",
      authorizeUrl: `${base}/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `${base}/${tenant}/oauth2/v2.0/token`,
      clientId: env.HUB_MICROSOFT_CLIENT_ID,
      clientSecret: env.HUB_MICROSOFT_CLIENT_SECRET,
      issuerOk: (issuer) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(issuer) || issuer.startsWith(`${base}/`),
      // Microsoft's `email` claim is only trustworthy for personal accounts or when the tenant
      // marks the domain as verified (optional claim `xms_edov`, enable it in the app registration).
      emailFrom: (claims) => {
        if (typeof claims.email !== "string") {
          return { error: "Microsoft did not send an e-mail address. Add the email optional claim." };
        }
        if (claims.tid === MICROSOFT_CONSUMER_TENANT || claims.xms_edov === true || claims.xms_edov === "1") {
          return { email: claims.email };
        }
        return { error: "Microsoft did not confirm this e-mail address (enable the xms_edov claim)." };
      },
    });
  }
  return providers;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function authorizeUrl(
  provider: OauthProvider,
  input: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pure check of the ID token claims; returns the verified e-mail or the reason it was refused. */
export function checkIdToken(
  provider: OauthProvider,
  claims: Record<string, unknown>,
  nonce: string,
  nowMs = Date.now(),
): { email: string } | { error: string } {
  if (typeof claims.iss !== "string" || !provider.issuerOk(claims.iss)) return { error: "Unexpected issuer." };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(provider.clientId)) return { error: "The sign-in was for another app." };
  if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs - 60_000) return { error: "The sign-in expired." };
  if (claims.nonce !== nonce) return { error: "The sign-in does not match this request." };
  return provider.emailFrom(claims);
}

export async function exchangeCode(
  provider: OauthProvider,
  input: { code: string; redirectUri: string; verifier: string },
): Promise<Record<string, unknown> | null> {
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: input.verifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { id_token?: unknown };
  return typeof json.id_token === "string" ? decodeJwtClaims(json.id_token) : null;
}
