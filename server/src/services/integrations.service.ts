import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { configuredKeyRing, decryptSecret, encryptSecret } from "../integrations/crypto.js";
import {
  assertOAuthConfigured,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchGoogleIdentity,
  GSC_SCOPE,
  OAuthExchangeError,
  randomToken,
  refreshAccessToken,
  RefreshTokenRevokedError,
  revokeToken,
  sha256Hex,
} from "../integrations/google/oauth.js";
import { GscApiError, GscClient, propertyType, READABLE_PERMISSIONS, type AccessTokenProvider } from "../integrations/google/search-console.js";
import { audit } from "./audit.service.js";

/**
 * Google Search Console integrations owned by an organization.
 *
 * OAuth flow (authorization code + PKCE):
 * 1. start: an owner/admin asks for an authorization URL. We store
 *    sha256(state), sha256(browser nonce) and the PKCE verifier (encrypted),
 *    valid 10 minutes, single use. The browser nonce goes into an httpOnly
 *    cookie scoped to the callback path, binding the flow to this browser.
 * 2. callback: the state row is consumed atomically; the cookie must match;
 *    the user must still be an owner/admin of the org; the code is exchanged;
 *    the read-only Search Console scope must have been granted; the refresh
 *    token is encrypted (bound to org + integration id) and stored.
 * Tokens, codes and secrets never leave the server and are never logged.
 */

export const PROVIDER = "google_search_console";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const RETURN_PATHS = ["/settings/integrations", "/search/performance"] as const;
export type ReturnPath = (typeof RETURN_PATHS)[number];

export const credentialAad = (orgId: string, integrationId: string) => `integration:${PROVIDER}:${orgId}:${integrationId}`;
const verifierAad = (stateHash: string) => `oauth_state:${stateHash}`;

export class IntegrationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export async function startGoogleOAuth(input: { orgId: string; userId: string; returnPath: ReturnPath }, now = Date.now()) {
  assertOAuthConfigured();
  const ring = configuredKeyRing();
  const state = randomToken();
  const browserNonce = randomToken();
  const codeVerifier = randomToken(48);
  const stateHash = sha256Hex(state);
  const { ciphertext } = encryptSecret(ring, codeVerifier, verifierAad(stateHash));
  await query("DELETE FROM oauth_states WHERE expires_at < NOW() - interval '1 day'");
  await query(
    `INSERT INTO oauth_states (org_id, user_id, provider, state_hash, browser_hash, code_verifier_enc, return_path, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.orgId, input.userId, PROVIDER, stateHash, sha256Hex(browserNonce), ciphertext, input.returnPath, new Date(now + OAUTH_STATE_TTL_MS)],
  );
  return { authorizationUrl: buildAuthorizationUrl({ state, codeVerifier }), browserNonce };
}

export type OAuthOutcome =
  | { outcome: "connected"; returnPath: ReturnPath; integrationId: string }
  | { outcome: "cancelled" | "error"; returnPath: ReturnPath; reason: string };

/** Reasons we put in the redirect: a fixed vocabulary, never Google's text. */
const SAFE_GOOGLE_ERRORS = new Set(["access_denied", "admin_policy_enforced", "org_internal", "invalid_client", "invalid_grant", "invalid_request", "redirect_uri_mismatch", "unauthorized_client"]);

export async function completeGoogleOAuth(input: { state?: string; code?: string; error?: string; browserNonce?: string }): Promise<OAuthOutcome> {
  const fallback: ReturnPath = "/settings/integrations";
  if (!input.state || input.state.length > 200) return { outcome: "error", returnPath: fallback, reason: "invalid_state" };
  // Single use: whoever consumes the row first wins; replays find nothing.
  const { rows } = await query<{ id: string; org_id: string; user_id: string; browser_hash: string; code_verifier_enc: string; return_path: ReturnPath; state_hash: string }>(
    `UPDATE oauth_states SET used_at = NOW()
      WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING id, org_id, user_id, browser_hash, code_verifier_enc, return_path, state_hash`,
    [sha256Hex(input.state), PROVIDER],
  );
  const st = rows[0];
  if (!st) return { outcome: "error", returnPath: fallback, reason: "invalid_state" };
  const returnPath = st.return_path;
  if (!input.browserNonce || sha256Hex(input.browserNonce) !== st.browser_hash) {
    return { outcome: "error", returnPath, reason: "browser_mismatch" };
  }
  if (input.error) {
    if (input.error === "access_denied") return { outcome: "cancelled", returnPath, reason: "access_denied" };
    return { outcome: "error", returnPath, reason: SAFE_GOOGLE_ERRORS.has(input.error) ? input.error : "google_error" };
  }
  if (!input.code || input.code.length > 2048) return { outcome: "error", returnPath, reason: "missing_code" };

  // The user who started the flow must still be allowed to manage integrations.
  const { rows: member } = await query<{ role: string }>(
    `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND u.active = TRUE`,
    [st.user_id, st.org_id],
  );
  if (!member[0] || !["owner", "admin"].includes(member[0].role)) return { outcome: "error", returnPath, reason: "forbidden" };

  const ring = configuredKeyRing();
  let tokens;
  try {
    const verifier = decryptSecret(ring, st.code_verifier_enc, verifierAad(st.state_hash));
    tokens = await exchangeAuthorizationCode(input.code, verifier);
  } catch (err) {
    return { outcome: "error", returnPath, reason: err instanceof OAuthExchangeError && SAFE_GOOGLE_ERRORS.has(err.reason) ? err.reason : "token_exchange_failed" };
  }
  if (!tokens.scopes.includes(GSC_SCOPE)) {
    // Granular consent: the user unticked Search Console access.
    if (tokens.refreshToken) await revokeToken(tokens.refreshToken);
    return { outcome: "error", returnPath, reason: "scope_denied" };
  }
  if (!tokens.refreshToken) return { outcome: "error", returnPath, reason: "no_refresh_token" };
  let identity;
  try {
    identity = await fetchGoogleIdentity(tokens.accessToken);
  } catch {
    return { outcome: "error", returnPath, reason: "identity_failed" };
  }

  const integrationId = await withTransaction(async (tx) => {
    const { rows: existing } = await tx.query<{ id: string }>(
      "SELECT id FROM integrations WHERE org_id = $1 AND provider = $2 AND external_account_id = $3 FOR UPDATE",
      [st.org_id, PROVIDER, identity.sub],
    );
    const id = existing[0]?.id ?? randomUUID();
    const { ciphertext, keyId } = encryptSecret(ring, tokens.refreshToken!, credentialAad(st.org_id, id));
    await tx.query(
      `INSERT INTO integrations (id, org_id, provider, external_account_id, account_email, scopes, refresh_token_enc, key_id, status, status_reason, connected_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NULL,$9)
       ON CONFLICT (org_id, provider, external_account_id) DO UPDATE SET
         account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes, refresh_token_enc = EXCLUDED.refresh_token_enc,
         key_id = EXCLUDED.key_id, status = 'active', status_reason = NULL, connected_by = EXCLUDED.connected_by,
         connected_at = NOW(), updated_at = NOW()`,
      [id, st.org_id, PROVIDER, identity.sub, identity.email, tokens.scopes, ciphertext, keyId, st.user_id],
    );
    return id;
  });
  tokenCache.delete(integrationId);
  await audit({ userId: st.user_id, orgId: st.org_id, action: "integration_connected", resourceType: "integration", resourceId: integrationId, result: "success", metadata: { provider: PROVIDER } });
  return { outcome: "connected", returnPath, integrationId };
}

// ─── Access tokens ───────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

interface IntegrationRow {
  id: string;
  org_id: string;
  status: string;
  refresh_token_enc: string | null;
}

async function markReauthRequired(orgId: string, integrationId: string, reason: string) {
  tokenCache.delete(integrationId);
  await query(
    "UPDATE integrations SET status = 'reauth_required', status_reason = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2",
    [integrationId, orgId, reason.slice(0, 500)],
  );
}

/** Access tokens live in memory only, refreshed from the encrypted refresh token. */
export function accessTokenProvider(orgId: string, integrationId: string, now: () => number = Date.now): AccessTokenProvider {
  return {
    async get(forceRefresh = false) {
      const cached = tokenCache.get(integrationId);
      if (!forceRefresh && cached && cached.expiresAt > now()) return cached.token;
      const { rows } = await query<IntegrationRow>(
        "SELECT id, org_id, status, refresh_token_enc FROM integrations WHERE id = $1 AND org_id = $2",
        [integrationId, orgId],
      );
      const row = rows[0];
      if (!row || row.status !== "active" || !row.refresh_token_enc) {
        throw new GscApiError("auth", "The Google connection needs to be reauthorized", 401);
      }
      try {
        const refreshToken = decryptSecret(configuredKeyRing(), row.refresh_token_enc, credentialAad(orgId, integrationId));
        const tokens = await refreshAccessToken(refreshToken);
        tokenCache.set(integrationId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
        return tokens.accessToken;
      } catch (err) {
        if (err instanceof RefreshTokenRevokedError) {
          await markReauthRequired(orgId, integrationId, "Google access was revoked or expired; reconnect the account");
          throw new GscApiError("auth", "The Google connection needs to be reauthorized", 401);
        }
        throw err instanceof GscApiError ? err : new GscApiError("transient", "Could not refresh the Google access token", 0);
      }
    },
  };
}

export function clientFor(orgId: string, integrationId: string): GscClient {
  return new GscClient(accessTokenProvider(orgId, integrationId), { key: integrationId });
}

/** Test hook: forget cached access tokens. */
export function resetTokenCache(): void {
  tokenCache.clear();
}

// ─── Read / manage ───────────────────────────────────────────────────────────

export async function listIntegrations(orgId: string) {
  const { rows } = await query(
    `SELECT i.id, i.provider, i.account_email, i.scopes, i.status, i.status_reason, i.connected_at, i.updated_at,
            u.full_name AS connected_by_name,
            COALESCE(json_agg(json_build_object('websiteId', p.website_id, 'siteUrl', p.site_url, 'status', p.status, 'domain', w.domain))
                     FILTER (WHERE p.id IS NOT NULL), '[]') AS properties
       FROM integrations i
       LEFT JOIN users u ON u.id = i.connected_by
       LEFT JOIN gsc_properties p ON p.integration_id = i.id AND p.org_id = i.org_id
       LEFT JOIN websites w ON w.id = p.website_id AND w.org_id = p.org_id
      WHERE i.org_id = $1
      GROUP BY i.id, u.full_name
      ORDER BY i.connected_at DESC, i.id`,
    [orgId],
  );
  return rows;
}

export async function getIntegration(orgId: string, integrationId: string) {
  const { rows } = await query<{ id: string; status: string; account_email: string | null }>(
    "SELECT id, status, account_email FROM integrations WHERE id = $1 AND org_id = $2",
    [integrationId, orgId],
  );
  return rows[0] ?? null;
}

/** Properties the connected Google account can see, straight from the API. */
export async function listAccessibleProperties(orgId: string, integrationId: string) {
  const integration = await getIntegration(orgId, integrationId);
  if (!integration) return null;
  if (integration.status !== "active") throw new IntegrationError(409, "INTEGRATION_REAUTH_REQUIRED", "Reconnect this Google account to list its properties");
  const sites = await clientFor(orgId, integrationId).listSites();
  const { rows: linked } = await query<{ site_url: string; website_id: string }>(
    "SELECT site_url, website_id FROM gsc_properties WHERE org_id = $1 AND integration_id = $2",
    [orgId, integrationId],
  );
  return sites
    .map((s) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel,
      propertyType: propertyType(s.siteUrl),
      canReadData: READABLE_PERMISSIONS.has(s.permissionLevel),
      linkedWebsiteIds: linked.filter((l) => l.site_url === s.siteUrl).map((l) => l.website_id),
    }))
    .filter((s) => s.propertyType !== null)
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/**
 * Disconnect: revoke at Google (best effort), then delete the integration;
 * its linked properties, sync jobs, coverage and stored search data cascade.
 */
export async function disconnectIntegration(orgId: string, integrationId: string, actorId: string) {
  const { rows } = await query<IntegrationRow>(
    "SELECT id, org_id, status, refresh_token_enc FROM integrations WHERE id = $1 AND org_id = $2",
    [integrationId, orgId],
  );
  const row = rows[0];
  if (!row) return null;
  let revokedAtGoogle = false;
  if (row.refresh_token_enc) {
    try {
      revokedAtGoogle = await revokeToken(decryptSecret(configuredKeyRing(), row.refresh_token_enc, credentialAad(orgId, integrationId)));
    } catch {
      revokedAtGoogle = false;
    }
  }
  await query("DELETE FROM integrations WHERE id = $1 AND org_id = $2", [integrationId, orgId]);
  tokenCache.delete(integrationId);
  await audit({ userId: actorId, orgId, action: "integration_disconnected", resourceType: "integration", resourceId: integrationId, result: "success", metadata: { provider: PROVIDER, revokedAtGoogle } });
  return { revokedAtGoogle };
}
