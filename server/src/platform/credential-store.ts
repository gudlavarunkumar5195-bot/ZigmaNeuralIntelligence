import { config } from "../config.js";
import { query } from "../db/client.js";
import { configuredKeyRing, decryptSecret, encryptSecret } from "../integrations/crypto.js";

/**
 * Platform credentials (admin-managed provider keys), the single place feature
 * modules ask for a provider secret. Precedence for a provider:
 *   1. a stored credential (platform_credentials) that is enabled and not
 *      known to be rejected by the provider;
 *   2. a stored credential that an administrator DISABLED switches the
 *      integration off (no fallback);
 *   3. otherwise the deployment environment variable, as before.
 *
 * Secrets are decrypted into this process's memory only; the cache is
 * reloaded after every admin change in this process and periodically
 * (index.ts) so other processes converge.
 */

export const MANAGED_PROVIDERS = ["openrouter"] as const;
export type ManagedProvider = (typeof MANAGED_PROVIDERS)[number];

const ENV_FALLBACK: Record<ManagedProvider, () => string | undefined> = {
  openrouter: () => config.OPENROUTER_API_KEY || undefined,
};

/** Statuses after which a stored credential is not used. Outages and quota do not disable it. */
export const REJECTED_STATUSES = new Set(["invalid", "permission_denied"]);

export const credentialAad = (provider: ManagedProvider) => `platform:${provider}`;

interface Entry {
  secret: string | null;
  enabled: boolean;
  status: string;
  decryptError: string | null;
}

let stored = new Map<ManagedProvider, Entry>();
let loadedAt = 0;

export async function refreshPlatformCredentials(): Promise<void> {
  const { rows } = await query<{ provider: ManagedProvider; secret_enc: string; enabled: boolean; last_check_status: string }>(
    "SELECT provider, secret_enc, enabled, last_check_status FROM platform_credentials",
  );
  const next = new Map<ManagedProvider, Entry>();
  for (const r of rows) {
    let secret: string | null = null;
    let decryptError: string | null = null;
    try {
      secret = decryptSecret(configuredKeyRing(), r.secret_enc, credentialAad(r.provider));
    } catch {
      decryptError = "The stored credential cannot be decrypted with the configured encryption keys.";
    }
    next.set(r.provider, { secret, enabled: r.enabled, status: r.last_check_status, decryptError });
  }
  stored = next;
  loadedAt = Date.now();
}

/** Reloads when the cache is older than maxAgeMs. Never throws (keeps the previous cache). */
export async function maybeRefreshPlatformCredentials(maxAgeMs = 60_000): Promise<void> {
  if (Date.now() - loadedAt < maxAgeMs) return;
  try {
    await refreshPlatformCredentials();
  } catch (err) {
    console.error(JSON.stringify({ event: "platform_credentials_refresh_failed", error: (err as Error).name }));
  }
}

export type CredentialSource = "admin" | "environment";

/** The secret a feature should use for a provider, or null when the integration is unavailable. */
export function resolveSecret(provider: ManagedProvider): { secret: string; source: CredentialSource } | null {
  const entry = stored.get(provider);
  if (entry && !entry.enabled) return null;
  if (entry?.secret && !REJECTED_STATUSES.has(entry.status)) return { secret: entry.secret, source: "admin" };
  const env = ENV_FALLBACK[provider]();
  return env ? { secret: env, source: "environment" } : null;
}

/** Non-secret view of the in-memory state, for status pages. */
export function storedCredentialState(provider: ManagedProvider): { present: boolean; enabled: boolean; decryptError: string | null } {
  const entry = stored.get(provider);
  return { present: !!entry, enabled: entry?.enabled ?? false, decryptError: entry?.decryptError ?? null };
}

/** The stored secret whatever its status (for re-testing it), or null. */
export function storedSecret(provider: ManagedProvider): string | null {
  return stored.get(provider)?.secret ?? null;
}

export function envFallbackConfigured(provider: ManagedProvider): boolean {
  return !!ENV_FALLBACK[provider]();
}

/**
 * Re-encrypts every stored credential (platform credentials and Google
 * refresh tokens) with the active key, for key rotation. Rows already on the
 * active key are skipped; a row that cannot be decrypted is reported, never
 * changed.
 */
export async function reencryptAllCredentials(googleAad: (orgId: string, id: string) => string): Promise<{ reencrypted: number; alreadyCurrent: number; failed: number }> {
  const ring = configuredKeyRing();
  const out = { reencrypted: 0, alreadyCurrent: 0, failed: 0 };
  if (!ring) return out;
  const platform = await query<{ provider: ManagedProvider; secret_enc: string; key_id: string }>("SELECT provider, secret_enc, key_id FROM platform_credentials");
  for (const r of platform.rows) {
    if (r.key_id === ring.activeKeyId) { out.alreadyCurrent++; continue; }
    try {
      const enc = encryptSecret(ring, decryptSecret(ring, r.secret_enc, credentialAad(r.provider)), credentialAad(r.provider));
      await query("UPDATE platform_credentials SET secret_enc = $2, key_id = $3, updated_at = NOW() WHERE provider = $1 AND key_id = $4", [r.provider, enc.ciphertext, enc.keyId, r.key_id]);
      out.reencrypted++;
    } catch {
      out.failed++;
    }
  }
  const google = await query<{ id: string; org_id: string; refresh_token_enc: string; key_id: string }>(
    "SELECT id, org_id, refresh_token_enc, key_id FROM integrations WHERE refresh_token_enc IS NOT NULL",
  );
  for (const r of google.rows) {
    if (r.key_id === ring.activeKeyId) { out.alreadyCurrent++; continue; }
    try {
      const aad = googleAad(r.org_id, r.id);
      const enc = encryptSecret(ring, decryptSecret(ring, r.refresh_token_enc, aad), aad);
      await query("UPDATE integrations SET refresh_token_enc = $3, key_id = $4, updated_at = NOW() WHERE id = $1 AND org_id = $2 AND key_id = $5", [r.id, r.org_id, enc.ciphertext, enc.keyId, r.key_id]);
      out.reencrypted++;
    } catch {
      out.failed++;
    }
  }
  if (out.reencrypted) await refreshPlatformCredentials();
  return out;
}

/** Test hook: forget the cache. */
export function resetPlatformCredentialCache(): void {
  stored = new Map();
  loadedAt = 0;
}
