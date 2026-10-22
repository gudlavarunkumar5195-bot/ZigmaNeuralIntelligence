import { config } from "../config.js";
import { query, withTransaction } from "../db/client.js";
import { configuredKeyRing, decryptSecret, encryptSecret } from "../integrations/crypto.js";
import { GoogleNetworkError } from "../integrations/google/http.js";
import { googleOAuthStatus, probeOAuthClient } from "../integrations/google/oauth.js";
import { isClickHouseConfigured, testClickHouse, testPostgres, type DiagnosticResult } from "../services/infrastructure.js";
import {
  credentialAad,
  envFallbackConfigured,
  MANAGED_PROVIDERS,
  refreshPlatformCredentials,
  REJECTED_STATUSES,
  resolveSecret,
  storedCredentialState,
  storedSecret,
  type ManagedProvider,
} from "./credential-store.js";
import { ProviderNetworkError, providerRequest } from "./provider-http.js";

/**
 * Integration registry for the Admin Control Center: what each integration
 * is, how it is managed, whether it is configured and verified, and the
 * low-cost checks that verify it. Only non-secret state leaves this module.
 */

export type CheckStatus =
  | "valid" | "invalid" | "permission_denied" | "quota_exceeded" | "rate_limited" | "unavailable" | "timeout" | "not_configured" | "error";

export interface CheckResult {
  status: CheckStatus;
  message: string;
  details: Record<string, unknown>;
}

export class AdminError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "AdminError";
  }
}

type Management = "admin" | "deployment" | "oauth" | "unsupported";

interface IntegrationDef {
  id: string;
  name: string;
  purpose: string;
  management: Management;
  docsUrl: string | null;
  setup: string;
  envVars: string[];
  capabilities: string[];
  configured: () => boolean;
  check?: () => Promise<CheckResult>;
}

const VALIDATION_TIMEOUT_MS = 10_000;

/** OpenRouter's key endpoint: authenticates the key and returns its limits; no model call, no cost. */
export async function validateOpenRouterKey(secret: string): Promise<CheckResult> {
  let res;
  try {
    res = await providerRequest("https://openrouter.ai/api/v1/key", { method: "GET", headers: { authorization: `Bearer ${secret}` }, timeoutMs: VALIDATION_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ProviderNetworkError) {
      return err.timedOut
        ? { status: "timeout", message: "OpenRouter did not answer in time. Try again later.", details: {} }
        : { status: "unavailable", message: "OpenRouter could not be reached. Check the server's outbound network and try again.", details: {} };
    }
    throw err;
  }
  const data = ((res.body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (true) {
    case res.status === 200:
      return {
        status: "valid",
        message: "OpenRouter accepted the key.",
        details: { freeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null, creditLimit: num(data.limit), creditRemaining: num(data.limit_remaining), usage: num(data.usage) },
      };
    case res.status === 401:
      return { status: "invalid", message: "OpenRouter rejected the key: it is wrong, disabled or deleted. Create a new key in the OpenRouter dashboard and enter it again.", details: {} };
    case res.status === 402:
      return { status: "quota_exceeded", message: "The OpenRouter account has no remaining credits for this key. Add credits or raise the key's limit, then test again.", details: {} };
    case res.status === 403:
      return { status: "permission_denied", message: "OpenRouter refused this key for the request. Check the key's restrictions in the OpenRouter dashboard.", details: {} };
    case res.status === 429:
      return { status: "rate_limited", message: "OpenRouter rate-limited the check. Wait a minute and test again.", details: {} };
    case res.status >= 500:
      return { status: "unavailable", message: `OpenRouter is having problems (HTTP ${res.status}). The key was not judged; try again later.`, details: {} };
    default:
      return { status: "error", message: `OpenRouter answered unexpectedly (HTTP ${res.status}).`, details: {} };
  }
}

const fromDiagnostic = (d: DiagnosticResult): CheckResult => ({
  status:
    d.status === "connected" ? "valid"
    : d.status === "not_configured" ? "not_configured"
    : d.status === "authentication_failed" ? "invalid"
    : d.status === "timeout" ? "timeout"
    : d.status === "unavailable" ? "unavailable"
    : "error",
  message: d.summary,
  details: { latencyMs: d.latencyMs, steps: d.steps.map((s) => ({ label: s.label, status: s.status })) },
});

async function checkGoogleOAuth(): Promise<CheckResult> {
  const status = googleOAuthStatus();
  if (!status.configured) return { status: "not_configured", message: `Missing: ${status.missing.join(", ")}.`, details: { missing: status.missing } };
  try {
    const r = await probeOAuthClient();
    if (r === "valid") return { status: "valid", message: "Google authenticated the OAuth client ID and secret.", details: {} };
    if (r === "invalid_client") return { status: "invalid", message: "Google rejected the OAuth client ID or secret. Copy them again from Google Cloud Console → APIs & Services → Credentials.", details: {} };
    return { status: "error", message: `Google answered unexpectedly (${r.unexpected}).`, details: {} };
  } catch (err) {
    if (err instanceof GoogleNetworkError) {
      return { status: err.timedOut ? "timeout" : "unavailable", message: err.timedOut ? "Google did not answer in time." : "Google could not be reached.", details: {} };
    }
    throw err;
  }
}

async function checkEncryption(): Promise<CheckResult> {
  let ring;
  try {
    ring = configuredKeyRing();
  } catch (err) {
    return { status: "error", message: (err as Error).message, details: {} };
  }
  if (!ring) return { status: "not_configured", message: "INTEGRATION_ENCRYPTION_KEYS is not set: credentials cannot be stored.", details: {} };
  const probe = encryptSecret(ring, "probe", "self-test");
  const ok = decryptSecret(ring, probe.ciphertext, "self-test") === "probe";
  return ok
    ? { status: "valid", message: `Key ring loaded (${ring.keys.size} key(s), active ${ring.activeKeyId}).`, details: { keys: ring.keys.size, activeKeyId: ring.activeKeyId } }
    : { status: "error", message: "Encryption self-test failed.", details: {} };
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "openrouter",
    name: "OpenRouter (AI models)",
    purpose: "AI analysis: scan intelligence, keyword prioritization, model catalog refresh.",
    management: "admin",
    docsUrl: "https://openrouter.ai/settings/keys",
    setup: "Create an API key in the OpenRouter dashboard (Settings → Keys) and enter it here. Free models only unless AI_ALLOW_PAID_MODELS=true.",
    envVars: ["OPENROUTER_API_KEY"],
    capabilities: ["ai_analysis", "model_catalog"],
    configured: () => !!resolveSecret("openrouter"),
    // Tests the stored key when there is one (even a rejected or disabled one), else the environment key.
    check: async () => {
      const secret = storedSecret("openrouter") ?? resolveSecret("openrouter")?.secret;
      return secret ? validateOpenRouterKey(secret) : { status: "not_configured", message: "No OpenRouter key is stored or set in the environment.", details: {} };
    },
  },
  {
    id: "google_oauth",
    name: "Google OAuth client",
    purpose: "Lets organizations connect Google Search Console (read-only).",
    management: "deployment",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    setup: "Deployment secrets: create a Web OAuth client in Google Cloud Console, set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI and INTEGRATION_ENCRYPTION_KEYS in App Platform, then redeploy. See docs/SEARCH_CONSOLE.md.",
    envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"],
    capabilities: ["search_console_connect", "keyword_research_first_party"],
    configured: () => googleOAuthStatus().configured,
    check: checkGoogleOAuth,
  },
  {
    id: "google_search_console",
    name: "Google Search Console connections",
    purpose: "Per-organization Google accounts connected through OAuth; source of search performance and keyword research data.",
    management: "oauth",
    docsUrl: null,
    setup: "Each organization connects its own Google account in Settings → Integrations. Tokens are encrypted per connection.",
    envVars: [],
    capabilities: ["search_performance", "keyword_research_first_party"],
    configured: () => googleOAuthStatus().configured,
  },
  {
    id: "encryption",
    name: "Credential encryption key ring",
    purpose: "Encrypts stored provider credentials and OAuth refresh tokens (AES-256-GCM).",
    management: "deployment",
    docsUrl: null,
    setup: "Deployment secret INTEGRATION_ENCRYPTION_KEYS=k1:<base64 32 bytes>. Generate with: node -e \"console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))\". Back it up outside the database.",
    envVars: ["INTEGRATION_ENCRYPTION_KEYS", "INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID"],
    capabilities: ["credential_storage"],
    configured: () => { try { return !!configuredKeyRing(); } catch { return false; } },
    check: checkEncryption,
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    purpose: "Transactional application database.",
    management: "deployment",
    docsUrl: null,
    setup: "Deployment secret DATABASE_URL (and DIRECT_DATABASE_URL for migrations).",
    envVars: ["DATABASE_URL"],
    capabilities: ["application_data"],
    configured: () => !!config.DATABASE_URL,
    check: async () => fromDiagnostic(await testPostgres()),
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    purpose: "Analytics event store fed by the analytics outbox.",
    management: "deployment",
    docsUrl: "https://clickhouse.com/docs",
    setup: "Deployment secrets CLICKHOUSE_HOST, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD (and CLICKHOUSE_CA_CERT if needed). Optional: without it, events stay in the PostgreSQL outbox.",
    envVars: ["CLICKHOUSE_HOST", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"],
    capabilities: ["analytics_events"],
    configured: () => isClickHouseConfigured(),
    check: async () => fromDiagnostic(await testClickHouse("connection")),
  },
  {
    id: "email",
    name: "Transactional email",
    purpose: "Password-reset and notification emails.",
    management: "unsupported",
    docsUrl: null,
    setup: "Not implemented: no email provider is integrated yet, so password-reset links and alert emails cannot be delivered.",
    envVars: [],
    capabilities: [],
    configured: () => false,
  },
  {
    id: "licensed_search_data",
    name: "Licensed keyword / SERP / backlink data",
    purpose: "Search volume, difficulty, CPC, rankings, backlinks, competitor discovery.",
    management: "unsupported",
    docsUrl: null,
    setup: "Not implemented: needs an approved paid provider (see docs/KEYWORD_RESEARCH.md). These metrics are shown as unsupported, never estimated.",
    envVars: [],
    capabilities: [],
    configured: () => false,
  },
];

const byId = (id: string) => {
  const def = INTEGRATIONS.find((i) => i.id === id);
  if (!def) throw new AdminError(404, "INTEGRATION_NOT_FOUND", "Unknown integration.");
  return def;
};
const isManaged = (id: string): id is ManagedProvider => (MANAGED_PROVIDERS as readonly string[]).includes(id);

async function recordCheck(provider: string, result: CheckResult, trigger: "save" | "test" | "scheduled", userId: string | null): Promise<void> {
  await query(
    "INSERT INTO platform_integration_checks (provider, status, message, details, trigger, checked_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [provider, result.status, result.message.slice(0, 500), JSON.stringify(result.details), trigger, userId],
  );
}

export interface IntegrationStatus {
  id: string;
  name: string;
  purpose: string;
  management: Management;
  docsUrl: string | null;
  setup: string;
  envVars: Array<{ name: string; set: boolean }>;
  capabilities: string[];
  configured: boolean;
  canTest: boolean;
  featureEnabled: boolean;
  credential: null | { source: "admin" | "environment" | null; stored: boolean; suffix: string | null; enabled: boolean; validatedAt: string | null; status: string | null; error: string | null; updatedAt: string | null; decryptError: string | null; envFallback: boolean };
  lastCheck: null | { status: CheckStatus; message: string | null; checkedAt: string; trigger: string };
  lastSuccessAt: string | null;
  details: Record<string, unknown>;
}

const envSet = (name: string) => !!(process.env[name] ?? (config as unknown as Record<string, unknown>)[name]);

export async function listIntegrations(): Promise<IntegrationStatus[]> {
  await refreshPlatformCredentials();
  const [checks, creds, gsc] = await Promise.all([
    query<{ provider: string; status: CheckStatus; message: string | null; checked_at: Date; trigger: string; details: Record<string, unknown>; last_success: Date | null }>(
      `SELECT DISTINCT ON (provider) provider, status, message, checked_at, trigger, details,
              (SELECT MAX(checked_at) FROM platform_integration_checks s WHERE s.provider = c.provider AND s.status = 'valid') AS last_success
         FROM platform_integration_checks c ORDER BY provider, checked_at DESC`,
    ),
    query<{ provider: string; secret_suffix: string; enabled: boolean; validated_at: Date; last_check_status: string; last_check_error: string | null; updated_at: Date; details: Record<string, unknown> }>(
      "SELECT provider, secret_suffix, enabled, validated_at, last_check_status, last_check_error, updated_at, details FROM platform_credentials",
    ),
    query<{ status: string; n: string }>("SELECT status, COUNT(*)::text AS n FROM integrations GROUP BY status"),
  ]);
  return INTEGRATIONS.map((def) => {
    const check = checks.rows.find((c) => c.provider === def.id);
    const cred = creds.rows.find((c) => c.provider === def.id);
    let credential: IntegrationStatus["credential"] = null;
    if (isManaged(def.id)) {
      const resolved = resolveSecret(def.id);
      credential = {
        source: resolved?.source ?? null,
        stored: !!cred,
        suffix: cred?.secret_suffix ?? null,
        enabled: cred?.enabled ?? true,
        validatedAt: cred?.validated_at.toISOString() ?? null,
        status: cred?.last_check_status ?? null,
        error: cred?.last_check_error ?? null,
        updatedAt: cred?.updated_at.toISOString() ?? null,
        decryptError: storedCredentialState(def.id).decryptError,
        envFallback: envFallbackConfigured(def.id),
      };
    }
    const details: Record<string, unknown> = { ...(cred?.details ?? {}) };
    if (def.id === "google_search_console") details.connections = Object.fromEntries(gsc.rows.map((r) => [r.status, Number(r.n)]));
    const configured = def.configured();
    return {
      id: def.id,
      name: def.name,
      purpose: def.purpose,
      management: def.management,
      docsUrl: def.docsUrl,
      setup: def.setup,
      envVars: def.envVars.map((name) => ({ name, set: envSet(name) })),
      capabilities: def.capabilities,
      configured,
      canTest: !!def.check,
      featureEnabled: configured && (!isManaged(def.id) || !!resolveSecret(def.id)),
      credential,
      lastCheck: check ? { status: check.status, message: check.message, checkedAt: check.checked_at.toISOString(), trigger: check.trigger } : null,
      lastSuccessAt: check?.last_success?.toISOString() ?? null,
      details,
    };
  });
}

const SECRET_SHAPE = /^[\x21-\x7e]{10,512}$/;

/**
 * Validates a submitted credential with the provider and stores it only if it
 * is accepted. A rejected credential never replaces the stored one.
 */
export async function saveCredential(provider: string, secret: string, actorId: string): Promise<{ result: CheckResult; integration: IntegrationStatus }> {
  const def = byId(provider);
  if (!isManaged(def.id)) throw new AdminError(409, "NOT_ADMIN_MANAGED", `${def.name} is configured through ${def.management === "oauth" ? "each organization's OAuth connection" : "deployment settings"}, not here.`);
  if (!SECRET_SHAPE.test(secret)) throw new AdminError(400, "CREDENTIAL_MALFORMED", "The key must be 10–512 printable characters without spaces.");
  let ring;
  try {
    ring = configuredKeyRing();
  } catch {
    ring = null;
  }
  if (!ring) throw new AdminError(503, "ENCRYPTION_NOT_CONFIGURED", "Credentials cannot be stored: INTEGRATION_ENCRYPTION_KEYS is not configured on the server. Nothing was saved.");

  const result = await validateOpenRouterKey(secret);
  await recordCheck(def.id, result, "save", actorId);
  if (result.status !== "valid") {
    throw new AdminError(result.status === "unavailable" || result.status === "timeout" ? 503 : 422, "CREDENTIAL_NOT_VERIFIED", result.message, { status: result.status, previousCredentialKept: true });
  }

  const enc = encryptSecret(ring, secret, credentialAad(def.id));
  if (decryptSecret(ring, enc.ciphertext, credentialAad(def.id)) !== secret) throw new AdminError(500, "ENCRYPTION_SELF_TEST_FAILED", "The credential could not be stored safely. Nothing was saved.");
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO platform_credentials (provider, secret_enc, key_id, secret_suffix, enabled, validated_at, last_check_at, last_check_status, last_check_error, details, updated_by)
       VALUES ($1,$2,$3,$4,TRUE,NOW(),NOW(),'valid',NULL,$5,$6)
       ON CONFLICT (provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, key_id = EXCLUDED.key_id, secret_suffix = EXCLUDED.secret_suffix, enabled = TRUE,
         validated_at = NOW(), last_check_at = NOW(), last_check_status = 'valid', last_check_error = NULL, details = EXCLUDED.details, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [def.id, enc.ciphertext, enc.keyId, secret.slice(-4), JSON.stringify(result.details), actorId],
    );
  });
  await refreshPlatformCredentials();
  const resolved = resolveSecret(def.id);
  if (resolved?.source !== "admin" || resolved.secret !== secret) throw new AdminError(500, "CREDENTIAL_NOT_ACTIVE", "The credential was stored but is not readable by the integration service. Check the encryption key configuration.");
  return { result, integration: (await listIntegrations()).find((i) => i.id === def.id)! };
}

/** Re-checks an integration with what is configured now. Never deletes a credential. */
export async function testIntegration(provider: string, actorId: string | null, trigger: "test" | "scheduled" = "test"): Promise<CheckResult> {
  const def = byId(provider);
  if (!def.check) throw new AdminError(409, "NOT_TESTABLE", `${def.name} has no server-side check.`);
  await refreshPlatformCredentials();
  let result: CheckResult;
  try {
    result = await def.check();
  } catch {
    result = { status: "error", message: "The check failed unexpectedly. See the server logs for this request id.", details: {} };
  }
  await recordCheck(def.id, result, trigger, actorId);
  if (isManaged(def.id) && storedSecret(def.id) && result.status !== "not_configured") {
    // Outages and quota keep the credential usable; only a provider rejection stops its use.
    await query(
      `UPDATE platform_credentials SET last_check_at = NOW(), last_check_status = $2, last_check_error = $3,
              validated_at = CASE WHEN $2 = 'valid' THEN NOW() ELSE validated_at END,
              details = CASE WHEN $2 = 'valid' THEN $4::jsonb ELSE details END
        WHERE provider = $1`,
      [def.id, result.status, result.status === "valid" ? null : result.message.slice(0, 500), JSON.stringify(result.details)],
    );
    await refreshPlatformCredentials();
  }
  return result;
}

export async function setCredentialEnabled(provider: string, enabled: boolean): Promise<void> {
  const def = byId(provider);
  if (!isManaged(def.id)) throw new AdminError(409, "NOT_ADMIN_MANAGED", `${def.name} cannot be switched here.`);
  const { rows } = await query<{ last_check_status: string }>("SELECT last_check_status FROM platform_credentials WHERE provider = $1", [def.id]);
  if (!rows[0]) throw new AdminError(404, "CREDENTIAL_NOT_FOUND", "No stored credential to enable or disable.");
  if (enabled && REJECTED_STATUSES.has(rows[0].last_check_status)) {
    throw new AdminError(409, "CREDENTIAL_REJECTED", "The provider rejected this credential at its last check. Test it again or replace it before enabling.");
  }
  await query("UPDATE platform_credentials SET enabled = $2, updated_at = NOW() WHERE provider = $1", [def.id, enabled]);
  await refreshPlatformCredentials();
}

export async function removeCredential(provider: string): Promise<{ removed: boolean }> {
  const def = byId(provider);
  if (!isManaged(def.id)) throw new AdminError(409, "NOT_ADMIN_MANAGED", `${def.name} has no stored credential.`);
  const { rowCount } = await query("DELETE FROM platform_credentials WHERE provider = $1", [def.id]);
  await refreshPlatformCredentials();
  return { removed: (rowCount ?? 0) > 0 };
}

/** Feature-module question: is this capability backed by a configured, usable integration? */
export function capabilityAvailable(capability: string): boolean {
  return INTEGRATIONS.some((i) => i.capabilities.includes(capability) && i.configured() && (!isManaged(i.id) || !!resolveSecret(i.id)));
}
