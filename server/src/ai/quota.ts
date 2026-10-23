// Phase 11: account-wide provider quotas and per-model health.
//
// OpenRouter limits free models per ACCOUNT (50 requests per UTC day while
// fewer than 10 credits were ever purchased, 1,000 after; 20 per minute), not
// per tenant. Every free or trial request therefore reserves a slot in a
// shared, transactional daily counter before it is sent, and requests are
// paced below the per-minute limit. A 429 that reports the daily allowance
// marks the pool exhausted until the next UTC day, so no further requests are
// wasted. Trial (time-limited free) models also count against an operator cap.

import { query, type Queryable } from "../db/client.js";
import { resolveSecret } from "../platform/credential-store.js";
import { providerRequest, ProviderNetworkError } from "../platform/provider-http.js";
import { FAILURE_POLICY, MAX_PROVIDER_COOLDOWN_MS, type FailureCategory } from "./failures.js";
import type { RouterSettings } from "./router/settings.js";

export type QuotaPool = "FREE" | "TRIAL";
const PROVIDER = "openrouter";
/** Trust a provider-reported daily allowance for this long before syncing again. */
const PROVIDER_SYNC_MAX_AGE_MS = 15 * 60_000;

export class QuotaExhaustedError extends Error {
  readonly code = "QUOTA_EXHAUSTED";
  readonly retryable = false;
  constructor(public readonly pool: QuotaPool, public readonly used: number, public readonly limit: number, public readonly resetAt: Date) {
    super(`QUOTA_EXHAUSTED: ${pool === "FREE" ? "free-model" : "trial-model"} allowance used (${used}/${limit}); resets ${resetAt.toISOString()}`);
    this.name = "QuotaExhaustedError";
  }
}

export class PacingError extends Error {
  readonly code = "RATE_PACED";
  readonly retryable = true;
  constructor(public readonly retryAfterMs: number) {
    super(`RATE_PACED: per-minute request pace reached; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "PacingError";
  }
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface PoolStatus {
  pool: QuotaPool;
  day: string;
  used: number;
  limit: number;
  remaining: number;
  exhaustedUntil: string | null;
  providerLimit: number | null;
  providerUsed: number | null;
  providerSyncedAt: string | null;
}

/** Effective daily limit: the operator setting, lowered by what the provider itself reports. */
export function effectiveLimit(pool: QuotaPool, settings: RouterSettings, providerLimit: number | null, providerSyncedAt: Date | null, now = new Date()): number {
  if (pool === "TRIAL") return settings.trials.enabled ? settings.trials.dailyRequestCap : 0;
  const configured = settings.quota.freeDailyRequests;
  const fresh = providerSyncedAt && now.getTime() - providerSyncedAt.getTime() < 24 * 60 * 60_000;
  return fresh && providerLimit !== null ? Math.min(configured, providerLimit) : configured;
}

/**
 * Reserves one request in each pool (FREE always; TRIAL as well for trial
 * models) inside the caller's transaction, and enforces the per-minute pace.
 * Must run in the same transaction that records the attempt row, under a
 * global advisory lock, so concurrent workers can never overshoot.
 */
export async function reserveProviderRequest(tx: Queryable, pools: QuotaPool[], settings: RouterSettings, now = new Date(), provider = PROVIDER): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ai-quota:${provider}`]);
  const day = utcDay(now);
  for (const pool of pools) {
    await tx.query(
      "INSERT INTO ai_provider_quota_days (provider, pool, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [provider, pool, day],
    );
    const { rows } = await tx.query<{ requests: number; provider_limit: number | null; provider_used: number | null; provider_synced_at: Date | null; exhausted_until: Date | null }>(
      "SELECT requests, provider_limit, provider_used, provider_synced_at, exhausted_until FROM ai_provider_quota_days WHERE provider=$1 AND pool=$2 AND day=$3",
      [provider, pool, day],
    );
    const row = rows[0];
    const limit = effectiveLimit(pool, settings, row?.provider_limit ?? null, row?.provider_synced_at ? new Date(row.provider_synced_at) : null, now);
    // The provider's own count includes requests made outside this application with the same key.
    const used = Math.max(Number(row?.requests ?? 0), Number(row?.provider_used ?? 0));
    const resetAt = nextUtcMidnight(now);
    if (row?.exhausted_until && new Date(row.exhausted_until).getTime() > now.getTime()) {
      throw new QuotaExhaustedError(pool, used, limit, new Date(row.exhausted_until));
    }
    if (used >= limit) throw new QuotaExhaustedError(pool, used, limit, resetAt);
  }
  // Per-minute pace across the whole account (every organization and process).
  const { rows: recent } = await tx.query<{ n: string; oldest: Date | null }>(
    "SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM agent_executions WHERE execution_kind='MODEL_ATTEMPT' AND started_at > $1::timestamptz - INTERVAL '60 seconds'",
    [now.toISOString()],
  );
  const inLastMinute = Number(recent[0]?.n ?? 0);
  if (inLastMinute >= settings.quota.freeRequestsPerMinute) {
    const oldest = recent[0]?.oldest ? new Date(recent[0].oldest).getTime() : now.getTime();
    throw new PacingError(Math.max(1_000, oldest + 60_000 - now.getTime()));
  }
  for (const pool of pools) {
    await tx.query(
      "UPDATE ai_provider_quota_days SET requests = requests + 1, provider_used = CASE WHEN provider_used IS NULL THEN NULL ELSE provider_used + 1 END, updated_at = NOW() WHERE provider=$1 AND pool=$2 AND day=$3",
      [provider, pool, day],
    );
  }
}

/** Called when the provider says the daily allowance is used up: stop sending until it resets. */
export async function markPoolExhausted(pool: QuotaPool, retryAfterMs: number | null, now = new Date()): Promise<void> {
  const midnight = nextUtcMidnight(now);
  const until = retryAfterMs !== null && retryAfterMs > 0 ? new Date(Math.min(now.getTime() + retryAfterMs, midnight.getTime() + 60 * 60_000)) : midnight;
  await query(
    `INSERT INTO ai_provider_quota_days (provider, pool, day, exhausted_until) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, pool, day) DO UPDATE SET exhausted_until = GREATEST(COALESCE(ai_provider_quota_days.exhausted_until, $4), $4), updated_at = NOW()`,
    [PROVIDER, pool, utcDay(now), until.toISOString()],
  );
}

export async function getPoolStatus(settings: RouterSettings, now = new Date()): Promise<PoolStatus[]> {
  const day = utcDay(now);
  const { rows } = await query<{ pool: QuotaPool; requests: number; provider_limit: number | null; provider_used: number | null; provider_synced_at: Date | null; exhausted_until: Date | null }>(
    "SELECT pool, requests, provider_limit, provider_used, provider_synced_at, exhausted_until FROM ai_provider_quota_days WHERE provider=$1 AND day=$2",
    [PROVIDER, day],
  );
  return (["FREE", "TRIAL"] as QuotaPool[]).map((pool) => {
    const r = rows.find((x) => x.pool === pool);
    const syncedAt = r?.provider_synced_at ? new Date(r.provider_synced_at) : null;
    const limit = effectiveLimit(pool, settings, r?.provider_limit ?? null, syncedAt, now);
    const used = Math.max(Number(r?.requests ?? 0), Number(r?.provider_used ?? 0));
    const exhausted = r?.exhausted_until && new Date(r.exhausted_until).getTime() > now.getTime() ? new Date(r.exhausted_until).toISOString() : null;
    return {
      pool, day, used, limit, remaining: exhausted ? 0 : Math.max(0, limit - used), exhaustedUntil: exhausted,
      providerLimit: r?.provider_limit ?? null, providerUsed: r?.provider_used ?? null, providerSyncedAt: syncedAt?.toISOString() ?? null,
    };
  });
}

export interface ProviderQuotaSync {
  status: "synced" | "not_configured" | "unavailable" | "unexpected";
  limit: number | null;
  used: number | null;
  remaining: number | null;
}

/**
 * Reads the account's free-model allowance from OpenRouter's key endpoint
 * (GET /api/v1/key — an account lookup, not an inference call; it costs
 * nothing) and stores it for today's FREE pool.
 */
export async function syncProviderQuota(now = new Date()): Promise<ProviderQuotaSync> {
  const key = resolveSecret("openrouter")?.secret;
  if (!key) return { status: "not_configured", limit: null, used: null, remaining: null };
  let res;
  try {
    res = await providerRequest("https://openrouter.ai/api/v1/key", { method: "GET", headers: { authorization: `Bearer ${key}` }, timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof ProviderNetworkError) return { status: "unavailable", limit: null, used: null, remaining: null };
    throw err;
  }
  if (res.status !== 200) return { status: res.status >= 500 || res.status === 429 ? "unavailable" : "unexpected", limit: null, used: null, remaining: null };
  const data = ((res.body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const daily = data.free_model_daily_requests as { used?: unknown; limit?: unknown; remaining?: unknown } | undefined;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const limit = int(daily?.limit);
  const used = int(daily?.used);
  const remaining = int(daily?.remaining);
  if (limit === null) return { status: "unexpected", limit: null, used, remaining };
  await query(
    `INSERT INTO ai_provider_quota_days (provider, pool, day, provider_limit, provider_used, provider_synced_at) VALUES ($1, 'FREE', $2, $3, $4, $5)
     ON CONFLICT (provider, pool, day) DO UPDATE SET provider_limit = $3, provider_used = $4, provider_synced_at = $5, updated_at = NOW()`,
    [PROVIDER, utcDay(now), limit, used, now.toISOString()],
  );
  return { status: "synced", limit, used, remaining };
}

/** Syncs when the stored provider figure is older than PROVIDER_SYNC_MAX_AGE_MS; failures are non-fatal. */
export async function maybeSyncProviderQuota(settings: RouterSettings, now = new Date()): Promise<void> {
  if (!settings.quota.syncFromProvider) return;
  const { rows } = await query<{ provider_synced_at: Date | null }>(
    "SELECT provider_synced_at FROM ai_provider_quota_days WHERE provider=$1 AND pool='FREE' AND day=$2",
    [PROVIDER, utcDay(now)],
  );
  const synced = rows[0]?.provider_synced_at ? new Date(rows[0].provider_synced_at).getTime() : 0;
  if (now.getTime() - synced < PROVIDER_SYNC_MAX_AGE_MS) return;
  try {
    await syncProviderQuota(now);
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_quota_sync_failed", error: (err as Error).name }));
  }
}

// ─── Per-model health and cooldowns ───────────────────────────────────────────

export interface ModelHealth {
  openrouterId: string;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  lastFailureCategory: string | null;
}

export async function getModelHealth(ids: string[]): Promise<Map<string, ModelHealth>> {
  const out = new Map<string, ModelHealth>();
  if (ids.length === 0) return out;
  const { rows } = await query<{ openrouter_id: string; cooldown_until: Date | null; consecutive_failures: number; last_failure_category: string | null }>(
    "SELECT openrouter_id, cooldown_until, consecutive_failures, last_failure_category FROM ai_model_health WHERE openrouter_id = ANY($1::text[])",
    [ids],
  );
  for (const r of rows) {
    out.set(r.openrouter_id, { openrouterId: r.openrouter_id, cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until) : null, consecutiveFailures: r.consecutive_failures, lastFailureCategory: r.last_failure_category });
  }
  return out;
}

export function isCoolingDown(h: ModelHealth | undefined, now = new Date()): boolean {
  return !!h?.cooldownUntil && h.cooldownUntil.getTime() > now.getTime();
}

/** Cooldown for a failure: the category's base, doubled after repeated failures, never shorter than the provider hint. */
export function cooldownFor(category: FailureCategory, consecutiveFailures: number, retryAfterMs: number | null): number {
  const base = FAILURE_POLICY[category].cooldownMs;
  // A single outage or timeout is usually transient: park the model only when it repeats.
  if ((category === "PROVIDER_UNAVAILABLE" || category === "TIMEOUT") && consecutiveFailures < 2 && !retryAfterMs) return 0;
  // An explicit provider hint on a rate limit is the cooldown; otherwise the category default applies.
  if (category === "RATE_LIMITED" && retryAfterMs !== null && retryAfterMs > 0) return Math.min(MAX_PROVIDER_COOLDOWN_MS, retryAfterMs);
  const scaled = base * (consecutiveFailures >= 3 ? 2 : 1);
  return Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(scaled, retryAfterMs ?? 0, 0));
}

export async function recordModelOutcome(openrouterId: string, category: FailureCategory | null, retryAfterMs: number | null = null, now = new Date()): Promise<void> {
  try {
    if (category === null) {
      await query(
        `INSERT INTO ai_model_health (openrouter_id, consecutive_failures, last_success_at, cooldown_until) VALUES ($1, 0, $2, NULL)
         ON CONFLICT (openrouter_id) DO UPDATE SET consecutive_failures = 0, last_success_at = $2, cooldown_until = NULL, updated_at = NOW()`,
        [openrouterId, now.toISOString()],
      );
      return;
    }
    if (!FAILURE_POLICY[category].countsAgainstModel) return;
    const { rows } = await query<{ consecutive_failures: number }>(
      `INSERT INTO ai_model_health (openrouter_id, consecutive_failures, last_failure_category, last_failure_at) VALUES ($1, 1, $2, $3)
       ON CONFLICT (openrouter_id) DO UPDATE SET consecutive_failures = ai_model_health.consecutive_failures + 1, last_failure_category = $2, last_failure_at = $3, updated_at = NOW()
       RETURNING consecutive_failures`,
      [openrouterId, category, now.toISOString()],
    );
    const ms = cooldownFor(category, rows[0]?.consecutive_failures ?? 1, retryAfterMs);
    if (ms > 0) {
      await query(
        "UPDATE ai_model_health SET cooldown_until = GREATEST(COALESCE(cooldown_until, $2::timestamptz), $2::timestamptz) WHERE openrouter_id = $1",
        [openrouterId, new Date(now.getTime() + ms).toISOString()],
      );
    }
  } catch (err) {
    // Health bookkeeping must not fail an AI call, but must be visible.
    console.warn(JSON.stringify({ level: "warn", event: "ai_model_health_write_failed", error: (err as Error).message }));
  }
}
