// Phase 11: router settings (global, versioned, audited).
//
// Administrators tune budgets, quotas and learning here. Every value is
// clamped to a hard ceiling in code: a stored setting can lower a limit but
// never raise it past the ceiling, and nothing here can enable paid models
// (that stays behind the AI_ALLOW_PAID_MODELS deployment switch).

import { z } from "zod";
import { query, withTransaction } from "../../db/client.js";
import { audit } from "../../services/audit.service.js";

export const ROUTER_TASK_TYPES = [
  "CLASSIFICATION",
  "STRUCTURED_EXTRACTION",
  "SUMMARIZATION",
  "CONTENT_GENERATION",
  "SEO_ANALYSIS",
  "TECHNICAL_REASONING",
  "CODE_GENERATION",
  "RESEARCH_SYNTHESIS",
  "PLANNING",
  "AGENT_COORDINATION",
  "TOOL_USE",
  "VERIFICATION",
] as const;
export type RouterTaskType = (typeof ROUTER_TASK_TYPES)[number];

/** Hard ceilings. Settings are clamped to these; raising one needs a code change and review. */
export const ROUTER_CEILINGS = Object.freeze({
  freeDailyRequests: 1_000,
  freeRequestsPerMinute: 20,
  trialDailyRequests: 1_000,
  orgDailyRequests: 2_000,
  orgDailyTokens: 20_000_000,
  taskInputTokens: 200_000,
  taskOutputTokens: 32_768,
  taskTotalTokens: 1_000_000,
  taskCalls: 12,
  taskAgents: 8,
  taskDepth: 3,
  taskConcurrency: 4,
  retriesPerModel: 3,
  fallbackModels: 5,
  taskWallClockMs: 600_000,
  reductionIterations: 5,
  evaluationAttempts: 2,
  repairAttempts: 1,
});

const weightsSchema = z.object({
  quality: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
  structured: z.number().min(0).max(1),
  latency: z.number().min(0).max(1),
  context: z.number().min(0).max(1),
  availability: z.number().min(0).max(1),
  security: z.number().min(0).max(1),
  resourceFit: z.number().min(0).max(1),
}).strict().refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.001, "weights must sum to 1");

const openrouterId = z.string().trim().min(3).max(255).regex(/^[a-z0-9][\w.\-]*\/[\w.\-:]+$/i);

export const routerSettingsSchema = z.object({
  trials: z.object({
    enabled: z.boolean(),
    dailyRequestCap: z.number().int().min(0).max(ROUTER_CEILINGS.trialDailyRequests),
  }).strict(),
  autoApproveFreeModels: z.boolean(),
  quota: z.object({
    freeDailyRequests: z.number().int().min(1).max(ROUTER_CEILINGS.freeDailyRequests),
    freeRequestsPerMinute: z.number().int().min(1).max(ROUTER_CEILINGS.freeRequestsPerMinute),
    syncFromProvider: z.boolean(),
  }).strict(),
  perOrg: z.object({
    dailyRequests: z.number().int().min(1).max(ROUTER_CEILINGS.orgDailyRequests),
    dailyTokens: z.number().int().min(1_000).max(ROUTER_CEILINGS.orgDailyTokens),
  }).strict(),
  perTask: z.object({
    maxInputTokens: z.number().int().min(500).max(ROUTER_CEILINGS.taskInputTokens),
    maxOutputTokens: z.number().int().min(64).max(ROUTER_CEILINGS.taskOutputTokens),
    maxTotalTokens: z.number().int().min(1_000).max(ROUTER_CEILINGS.taskTotalTokens),
    maxCalls: z.number().int().min(1).max(ROUTER_CEILINGS.taskCalls),
    maxAgents: z.number().int().min(1).max(ROUTER_CEILINGS.taskAgents),
    maxDepth: z.number().int().min(0).max(ROUTER_CEILINGS.taskDepth),
    maxConcurrency: z.number().int().min(1).max(ROUTER_CEILINGS.taskConcurrency),
    maxRetriesPerModel: z.number().int().min(1).max(ROUTER_CEILINGS.retriesPerModel),
    maxFallbackModels: z.number().int().min(0).max(ROUTER_CEILINGS.fallbackModels),
    maxWallClockMs: z.number().int().min(5_000).max(ROUTER_CEILINGS.taskWallClockMs),
    maxReductionIterations: z.number().int().min(0).max(ROUTER_CEILINGS.reductionIterations),
    maxEvaluationAttempts: z.number().int().min(0).max(ROUTER_CEILINGS.evaluationAttempts),
    maxRepairAttempts: z.number().int().min(0).max(ROUTER_CEILINGS.repairAttempts),
  }).strict(),
  catalog: z.object({
    refreshIntervalMinutes: z.number().int().min(30).max(1_440),
    maxStaleHours: z.number().int().min(1).max(72),
  }).strict(),
  quality: z.object({
    minQualityScore: z.number().int().min(0).max(100),
    minSamples: z.number().int().min(3).max(200),
    halfLifeDays: z.number().int().min(1).max(90),
    explorationRate: z.number().min(0).max(0.25),
  }).strict(),
  models: z.object({
    excluded: z.array(openrouterId).max(200),
    pins: z.record(z.enum(ROUTER_TASK_TYPES), openrouterId),
  }).strict(),
  weights: weightsSchema,
  retentionDays: z.number().int().min(30).max(730),
}).strict();

export type RouterSettings = z.infer<typeof routerSettingsSchema>;

/**
 * Conservative defaults for an OpenRouter account with free models only.
 * OpenRouter allows 50 free-model requests per day (1,000 once 10 credits have
 * ever been purchased) and 20 per minute; the per-minute default stays below that.
 */
export const DEFAULT_ROUTER_SETTINGS: RouterSettings = Object.freeze({
  trials: { enabled: true, dailyRequestCap: 20 },
  autoApproveFreeModels: true,
  quota: { freeDailyRequests: 50, freeRequestsPerMinute: 16, syncFromProvider: true },
  perOrg: { dailyRequests: 200, dailyTokens: 2_000_000 },
  perTask: {
    maxInputTokens: 48_000,
    maxOutputTokens: 4_096,
    maxTotalTokens: 120_000,
    maxCalls: 6,
    maxAgents: 5,
    maxDepth: 2,
    maxConcurrency: 2,
    maxRetriesPerModel: 2,
    maxFallbackModels: 3,
    maxWallClockMs: 240_000,
    maxReductionIterations: 3,
    maxEvaluationAttempts: 0,
    maxRepairAttempts: 1,
  },
  catalog: { refreshIntervalMinutes: 360, maxStaleHours: 24 },
  quality: { minQualityScore: 55, minSamples: 5, halfLifeDays: 14, explorationRate: 0.1 },
  models: { excluded: [], pins: {} },
  weights: { quality: 0.3, reliability: 0.2, structured: 0.1, latency: 0.05, context: 0.05, availability: 0.1, security: 0.1, resourceFit: 0.1 },
  retentionDays: 180,
}) as RouterSettings;

export interface StoredRouterSettings {
  settings: RouterSettings;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  source: "default" | "stored";
}

const CACHE_MS = 30_000;
let cache: { value: StoredRouterSettings; at: number } | null = null;

export function invalidateRouterSettingsCache(): void {
  cache = null;
}

/** Merges a stored document over the defaults so settings added later get their default. */
export function mergeSettings(stored: unknown): RouterSettings {
  const base = structuredClone(DEFAULT_ROUTER_SETTINGS) as RouterSettings;
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof RouterSettings>) {
    const v = s[key];
    if (v === undefined) continue;
    const b = base[key];
    merged[key] = b && typeof b === "object" && !Array.isArray(b) && key !== "weights" && v && typeof v === "object"
      ? { ...(b as object), ...(v as object) }
      : v;
  }
  const parsed = routerSettingsSchema.safeParse(merged);
  // A stored document that no longer validates (for example after a ceiling
  // was lowered) falls back to the defaults rather than to partial values.
  return parsed.success ? parsed.data : base;
}

export async function getRouterSettings(): Promise<StoredRouterSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: StoredRouterSettings;
  try {
    const { rows } = await query<{ settings: unknown; version: number; created_at: Date; created_by: string | null }>(
      "SELECT settings, version, created_at, created_by FROM ai_router_settings WHERE is_active LIMIT 1",
    );
    value = rows[0]
      ? { settings: mergeSettings(rows[0].settings), version: rows[0].version, updatedAt: new Date(rows[0].created_at).toISOString(), updatedBy: rows[0].created_by, source: "stored" }
      : { settings: structuredClone(DEFAULT_ROUTER_SETTINGS) as RouterSettings, version: 0, updatedAt: null, updatedBy: null, source: "default" };
  } catch {
    // Unreadable settings must not widen anything: the defaults are the conservative values.
    value = { settings: structuredClone(DEFAULT_ROUTER_SETTINGS) as RouterSettings, version: 0, updatedAt: null, updatedBy: null, source: "default" };
  }
  cache = { value, at: Date.now() };
  return value;
}

export class RouterSettingsError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
    this.name = "RouterSettingsError";
  }
}

/** Replaces the active settings with a validated new version (platform administrators only; checked by the route). */
export async function updateRouterSettings(next: unknown, actorId: string, expectedVersion?: number): Promise<StoredRouterSettings> {
  const parsed = routerSettingsSchema.safeParse(next);
  if (!parsed.success) {
    throw new RouterSettingsError("Invalid router settings", parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const settings = parsed.data;
  const version = await withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-router-settings', 0))");
    const { rows } = await tx.query<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM ai_router_settings");
    const current = Number(rows[0]?.version ?? 0);
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new RouterSettingsError("Settings were changed by someone else; reload and try again", [`expected version ${expectedVersion}, current ${current}`]);
    }
    await tx.query("UPDATE ai_router_settings SET is_active = FALSE WHERE is_active");
    await tx.query("INSERT INTO ai_router_settings (version, settings, is_active, created_by) VALUES ($1, $2, TRUE, $3)", [current + 1, JSON.stringify(settings), actorId]);
    return current + 1;
  });
  invalidateRouterSettingsCache();
  await audit({ userId: actorId, action: "ai_router_settings_updated", resourceType: "ai_router_settings", result: "success", metadata: { version } });
  return getRouterSettings();
}
