import { createHash, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { googleRequest } from "./http.js";

/**
 * Google OAuth 2.0 for web server apps (authorization code + PKCE S256).
 * Scopes are the minimum for read-only Search Console data plus the account
 * identity shown to the user ("which Google account is connected").
 */

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const OAUTH_SCOPES = ["openid", "email", GSC_SCOPE];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const REQUIRED_OAUTH_ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "INTEGRATION_ENCRYPTION_KEYS"] as const;

/** Names (never values) of the settings still missing for the integration to work. */
export function googleOAuthStatus(env: Record<string, unknown> = config): { configured: boolean; missing: string[] } {
  const missing = REQUIRED_OAUTH_ENV.filter((name) => !String(env[name] ?? "").trim());
  return { configured: missing.length === 0, missing };
}

export class OAuthNotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly code = "INTEGRATION_NOT_CONFIGURED";
  constructor(readonly missing: string[]) {
    super(`Google Search Console is not configured on the server (missing: ${missing.join(", ")})`);
    this.name = "OAuthNotConfiguredError";
  }
}

export class OAuthExchangeError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

export function assertOAuthConfigured(): { clientId: string; clientSecret: string; redirectUri: string } {
  const status = googleOAuthStatus();
  if (!status.configured) throw new OAuthNotConfiguredError(status.missing);
  return { clientId: config.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET!, redirectUri: config.GOOGLE_OAUTH_REDIRECT_URI! };
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

export function buildAuthorizationUrl(input: { state: string; codeVerifier: string; loginHint?: string }): string {
  const { clientId, redirectUri } = assertOAuthConfigured();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    // Re-consent so Google issues a refresh token on every connect/reconnect.
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${AUTH_URL}?${params}`;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scopes: string[];
}

function tokenSet(body: Record<string, unknown>, now: number): TokenSet {
  if (typeof body.access_token !== "string") throw new OAuthExchangeError("token_response_invalid", "Google returned no access token");
  return {
    accessToken: body.access_token,
    expiresAt: now + Math.max(0, Number(body.expires_in ?? 0) - 60) * 1_000,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
  };
}

async function tokenRequest(params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await googleRequest(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    timeoutMs: config.GSC_REQUEST_TIMEOUT_MS ?? 30_000,
  });
  return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

export async function exchangeAuthorizationCode(code: string, codeVerifier: string, now = Date.now()): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = assertOAuthConfigured();
  const { status, body } = await tokenRequest({
    grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
  });
  if (status !== 200) {
    // The error code only; descriptions can echo request data.
    throw new OAuthExchangeError(String(body.error ?? `http_${status}`), "Google rejected the authorization code");
  }
  return tokenSet(body, now);
}

/**
 * Checks the configured OAuth client without any user data or cost: a code
 * that cannot exist is exchanged. Google answers invalid_grant only after it
 * has authenticated the client, and invalid_client when the ID or secret is
 * wrong.
 */
export async function probeOAuthClient(): Promise<"valid" | "invalid_client" | { unexpected: string }> {
  const { clientId, clientSecret, redirectUri } = assertOAuthConfigured();
  const { status, body } = await tokenRequest({
    grant_type: "authorization_code", code: "zni-client-validation-probe", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
  });
  const reason = String(body.error ?? `http_${status}`);
  if (reason === "invalid_grant") return "valid";
  if (reason === "invalid_client" || reason === "unauthorized_client") return "invalid_client";
  return { unexpected: reason };
}

export class RefreshTokenRevokedError extends Error {
  constructor(readonly reason: string) {
    super("Google refresh token is no longer valid; the user must reconnect");
    this.name = "RefreshTokenRevokedError";
  }
}

export async function refreshAccessToken(refreshToken: string, now = Date.now()): Promise<TokenSet> {
  const { clientId, clientSecret } = assertOAuthConfigured();
  const { status, body } = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  if (status === 400 || status === 401) {
    const reason = String(body.error ?? `http_${status}`);
    // invalid_grant: revoked, expired, password change, or testing-mode expiry.
    if (reason === "invalid_grant" || reason === "unauthorized_client") throw new RefreshTokenRevokedError(reason);
    throw new OAuthExchangeError(reason, "Google refused the token refresh");
  }
  if (status !== 200) throw new OAuthExchangeError(`http_${status}`, "Google token refresh failed");
  return tokenSet(body, now);
}

/** Best effort: revoking at Google. Local deletion happens regardless. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await googleRequest(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      timeoutMs: config.GSC_REQUEST_TIMEOUT_MS ?? 30_000,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function fetchGoogleIdentity(accessToken: string): Promise<{ sub: string; email: string | null; emailVerified: boolean }> {
  const res = await googleRequest(USERINFO_URL, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, timeoutMs: config.GSC_REQUEST_TIMEOUT_MS ?? 30_000 });
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200 || typeof body.sub !== "string" || !body.sub) throw new OAuthExchangeError("userinfo_failed", "Could not read the Google account identity");
  return { sub: body.sub, email: typeof body.email === "string" ? body.email : null, emailVerified: body.email_verified === true };
}
