// Phase 11: execution governance — the non-bypassable policy layer.
//
// Every provider call made by OxAlphaExecutor goes through these functions:
// model eligibility at call time (pricing, trial, freshness, status), the
// atomic reservation of organization budget + account quota + tokens + the
// attempt row, settlement, model health, and the records that feed learning.
// The model never decides any of this; failures here fail closed.

import { config } from "../config.js";
import { query, withTransaction } from "../db/client.js";
import { reserveOrgAiAttempt } from "./budget.js";
import { refreshCatalog } from "./catalog.service.js";
import { recordModelOutcome, reserveProviderRequest, markPoolExhausted, maybeSyncProviderQuota, getModelHealth, isCoolingDown, type QuotaPool } from "./quota.js";
import { recordReliabilityEvent } from "./registry.service.js";
import { getRouterSettings, type RouterSettings } from "./router/settings.js";
import { resolveRouting } from "./router/index.js";
import { getActivePolicy } from "./router/routing-policy.js";
import { classifyTask } from "./router/task-profiles.js";
import type { RiskLevel, TaskType } from "./router/types.js";
import { reserveTokens, releaseReservation, settleReservation, createTaskRun, finishTaskRun, taskLimitsFrom, isTaskCancelRequested, type SettleResult, type TaskRunStatus, type Feasibility } from "./task-runs.js";
import type { FailureCategory } from "./failures.js";
import type { PricingClass } from "./pricing.js";
import type { TokenUsage } from "./provider.js";

export function paidModelsAllowed(): boolean {
  return (config as { AI_ALLOW_PAID_MODELS?: boolean }).AI_ALLOW_PAID_MODELS === true;
}

export async function getExecutionSettings(): Promise<RouterSettings> {
  return (await getRouterSettings()).settings;
}

// ─── Call-time model eligibility ──────────────────────────────────────────────

export interface CallableModel {
  openrouterId: string;
  pricingClass: PricingClass;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  reasoningMandatory: boolean;
  /** Ratio of provider-reported to estimated prompt tokens observed for this model (>= 1). */
  calibration: number;
}

export type ModelCheck = { ok: true; model: CallableModel } | { ok: false; reason: string; category: FailureCategory };

interface ModelGateRow {
  openrouter_id: string;
  enabled: boolean;
  status: string;
  eligibility_status: string;
  free_status: string;
  pricing_class: PricingClass | null;
  pricing_checked_at: Date | null;
  expires_at: Date | null;
  context_length: number | null;
  max_completion_tokens: number | null;
  reasoning_mandatory: boolean | null;
  is_router: boolean | null;
  output_modalities?: string[] | null;
  provider?: string | null;
}

async function loadGateRow(openrouterId: string): Promise<ModelGateRow | null> {
  const { rows } = await query<ModelGateRow>(
    `SELECT openrouter_id, enabled, status, eligibility_status, free_status, pricing_class, pricing_checked_at, expires_at,
            context_length, max_completion_tokens, reasoning_mandatory, is_router, output_modalities, provider
       FROM models WHERE openrouter_id = $1 LIMIT 1`,
    [openrouterId],
  );
  return rows[0] ?? null;
}

/** Pure decision on a model row (exported for tests). */
export function decideModel(row: ModelGateRow | null, settings: RouterSettings, paidAllowed: boolean, now = new Date()): ModelCheck | "STALE" {
  if (!row) return { ok: false, reason: "model is not in the catalog", category: "POLICY_BLOCKED" };
  if (!row.enabled || row.status === "DISABLED" || row.eligibility_status === "DISABLED") return { ok: false, reason: "model is disabled", category: "POLICY_BLOCKED" };
  if (row.status === "STALE" || row.status === "DEPRECATED" || row.status === "UNAVAILABLE") return { ok: false, reason: `model is ${row.status.toLowerCase()}`, category: "POLICY_BLOCKED" };
  if (row.status === "DISCOVERED" || row.status === "REQUIRES_REVIEW" || row.free_status === "CHANGED") return { ok: false, reason: "model awaits review", category: "POLICY_BLOCKED" };
  if (row.eligibility_status !== "ELIGIBLE") return { ok: false, reason: "model is not approved for use", category: "POLICY_BLOCKED" };
  // An empty list is a legacy row without modality data (the catalog always fills it in).
  const outputs = row.output_modalities ?? [];
  if (outputs.some((m) => m !== "text")) return { ok: false, reason: "model does not produce text-only output", category: "POLICY_BLOCKED" };
  if (settings.models.excluded.includes(row.openrouter_id)) return { ok: false, reason: "model is excluded by an administrator", category: "POLICY_BLOCKED" };
  if (row.is_router) return { ok: false, reason: "routing aliases are not callable", category: "POLICY_BLOCKED" };
  const cls = row.pricing_class ?? "UNKNOWN";
  if ((cls === "PAID" || cls === "UNKNOWN") && !paidAllowed) {
    return { ok: false, reason: cls === "PAID" ? "paid model; paid usage is disabled" : "price unknown; refusing to risk a charge", category: "POLICY_BLOCKED" };
  }
  if (cls === "TRIAL") {
    if (!settings.trials.enabled) return { ok: false, reason: "trial models are disabled", category: "POLICY_BLOCKED" };
    if (!row.expires_at || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "free period has ended", category: "POLICY_BLOCKED" };
  }
  const checked = row.pricing_checked_at ? new Date(row.pricing_checked_at).getTime() : 0;
  if (!checked || now.getTime() - checked > settings.catalog.maxStaleHours * 3_600_000) return "STALE";
  return {
    ok: true,
    model: {
      openrouterId: row.openrouter_id,
      pricingClass: cls,
      contextLength: row.context_length,
      maxCompletionTokens: row.max_completion_tokens,
      reasoningMandatory: row.reasoning_mandatory === true,
      calibration: 1,
    },
  };
}

/**
 * Re-validates a model immediately before a call. Stale pricing triggers one
 * (shared) catalog refresh; if pricing still cannot be confirmed the model is
 * refused — an unverifiable price is never risked.
 */
export async function checkCallableModel(openrouterId: string, settings: RouterSettings, orgId?: string): Promise<ModelCheck> {
  let row = await loadGateRow(openrouterId);
  let decision = decideModel(row, settings, paidModelsAllowed());
  if (decision === "STALE") {
    try { await refreshCatalog(); } catch { /* handled below: still stale means refused */ }
    row = await loadGateRow(openrouterId);
    decision = decideModel(row, settings, paidModelsAllowed());
    if (decision === "STALE") return { ok: false, reason: "pricing could not be re-confirmed (catalog stale)", category: "POLICY_BLOCKED" };
  }
  if (!decision.ok) return decision;
  // The organization's routing policy also binds callers that name a model explicitly.
  if (orgId && row) {
    const policy = await getActivePolicy(orgId);
    if (policy.excludedModels?.includes(openrouterId)) return { ok: false, reason: "model is excluded by the organization's routing policy", category: "POLICY_BLOCKED" };
    if (policy.allowedProviders?.length && !policy.allowedProviders.some((p) => openrouterId.startsWith(`${p}/`) || row!.provider === p)) {
      return { ok: false, reason: "provider is not allowed by the organization's routing policy", category: "POLICY_BLOCKED" };
    }
    if (policy.freeOnly && decision.model.pricingClass !== "FREE" && decision.model.pricingClass !== "TRIAL") {
      return { ok: false, reason: "paid model; the organization's policy is free-only", category: "POLICY_BLOCKED" };
    }
  }
  decision.model.calibration = await loadCalibration(openrouterId);
  return decision;
}

/** p90 of provider-reported / estimated prompt tokens over recent attempts; only ever raises estimates. */
async function loadCalibration(openrouterId: string): Promise<number> {
  try {
    const { rows } = await query<{ p90: number | null; n: string }>(
      `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY prompt_tokens::float / NULLIF(estimated_input_tokens, 0)) AS p90, COUNT(*) AS n
         FROM (SELECT prompt_tokens, estimated_input_tokens FROM agent_executions
                WHERE execution_kind='MODEL_ATTEMPT' AND model_id=$1 AND usage_estimated = FALSE
                  AND prompt_tokens IS NOT NULL AND estimated_input_tokens > 0
                ORDER BY started_at DESC LIMIT 50) recent`,
      [openrouterId],
    );
    const p90 = Number(rows[0]?.p90);
    return Number(rows[0]?.n ?? 0) >= 5 && Number.isFinite(p90) ? Math.max(1, p90) : 1;
  } catch {
    return 1;
  }
}

export async function isCancelRequested(taskRunId: string, orgId: string): Promise<boolean> {
  try {
    return await isTaskCancelRequested(taskRunId, orgId);
  } catch {
    return false;
  }
}

export async function modelIsCoolingDown(openrouterId: string): Promise<boolean> {
  try {
    return isCoolingDown((await getModelHealth([openrouterId])).get(openrouterId));
  } catch {
    return false;
  }
}

// ─── Routing for callers that did not choose a model ──────────────────────────

export interface ModelChain {
  chain: string[];
  decisionId: string | null;
  reason: string;
  /** Routing policy max_attempts (lowers the executor's total-attempt limit). */
  maxAttempts?: number;
}

export async function resolveModelChain(input: {
  taskType?: string;
  feature?: string;
  requireJson: boolean;
  estimatedInputTokens: number;
  riskLevel?: RiskLevel;
  orgId?: string;
  correlationId: string;
  taskRunId?: string | null;
}): Promise<ModelChain> {
  const profile = classifyTask({ taskType: input.taskType, feature: input.feature });
  const decision = await resolveRouting({
    requirements: {
      taskType: profile.category as TaskType,
      complexity: profile.tier === "HEAVY" ? "HIGH" : profile.tier === "LIGHT" ? "LOW" : "MEDIUM",
      riskLevel: input.riskLevel ?? "MEDIUM",
      requiredCapabilities: [],
      structuredOutputRequired: input.requireJson,
      toolCallingRequired: false,
      visionRequired: false,
      preferredCapabilities: [],
      orgId: input.orgId,
      estimatedInputTokens: input.estimatedInputTokens,
      desiredOutputTokens: profile.desiredOutputTokens,
    },
    correlationId: input.correlationId,
    orgId: input.orgId,
    feature: input.feature,
    taskRunId: input.taskRunId ?? undefined,
  });
  if (decision.status !== "RESOLVED" || !decision.selectedModel) {
    const reasons = [...new Set(decision.excludedCandidates.map((e) => e.reason))].slice(0, 6).join(", ");
    return { chain: [], decisionId: decision.id, reason: `no eligible model${reasons ? ` (${reasons})` : ""}` };
  }
  return { chain: [decision.selectedModel.openrouterId, ...decision.fallbackModels.map((f) => f.openrouterId)], decisionId: decision.id, reason: decision.decisionReason, maxAttempts: decision.maxAttempts };
}

// ─── Atomic reservation ───────────────────────────────────────────────────────

export interface ReserveAttemptInput {
  orgId: string;
  taskRunId: string | null;
  model: CallableModel;
  estimatedInput: number;
  estimatedOutput: number;
  settings: RouterSettings;
  insertAttempt: (tx: { query: typeof query }) => Promise<string>;
}

export interface Reservation { attemptRowId: string; reservationId: string }

/**
 * One transaction: organization request budget (advisory lock), account-wide
 * free/trial quota and pace, token budget (org and task), then the attempt
 * row. Any refusal rolls everything back, so nothing is counted for a call
 * that is not made.
 */
export async function reserveAttempt(input: ReserveAttemptInput): Promise<Reservation> {
  let reservationId = "";
  const pools: QuotaPool[] = input.model.pricingClass === "TRIAL" ? ["FREE", "TRIAL"] : input.model.pricingClass === "FREE" ? ["FREE"] : [];
  const orgLimit = input.settings.perOrg.dailyRequests;
  const attemptRowId = await reserveOrgAiAttempt(input.orgId, async (tx) => {
    if (pools.length) await reserveProviderRequest(tx, pools, input.settings);
    reservationId = await reserveTokens(tx, {
      orgId: input.orgId, taskRunId: input.taskRunId, model: input.model.openrouterId,
      estimatedInput: input.estimatedInput, estimatedOutput: input.estimatedOutput, settings: input.settings,
    });
    return input.insertAttempt(tx as { query: typeof query });
  }, orgLimit);
  return { attemptRowId, reservationId };
}

export async function settleAttempt(reservationId: string, orgId: string, usage: TokenUsage | null, fallback: { input: number; output: number }, attemptRowId: string): Promise<SettleResult> {
  return settleReservation(reservationId, orgId, usage, fallback, attemptRowId);
}

export async function releaseAttempt(reservationId: string, orgId: string): Promise<void> {
  if (reservationId) await releaseReservation(reservationId, orgId);
}

export async function recordAttemptOutcome(model: string, category: FailureCategory | null, latencyMs: number | null, retryAfterMs: number | null): Promise<void> {
  await recordModelOutcome(model, category, retryAfterMs);
  const outcome = category === null ? "success"
    : category === "TIMEOUT" ? "timeout"
    : category === "RATE_LIMITED" ? "rate_limited"
    : category === "MALFORMED_OUTPUT" || category === "INVALID_PROVIDER_RESPONSE" ? "malformed"
    : "failed";
  try {
    await recordReliabilityEvent({ openrouterId: model, outcome, latencyMs: latencyMs ?? undefined });
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_reliability_write_failed", error: (err as Error).message }));
  }
}

export async function onQuotaExhausted(pricingClass: PricingClass, retryAfterMs: number | null): Promise<void> {
  // Only free and trial requests draw on the account's free-model allowance.
  if (pricingClass !== "FREE" && pricingClass !== "TRIAL") return;
  try {
    await markPoolExhausted("FREE", retryAfterMs);
    if (pricingClass === "TRIAL") await markPoolExhausted("TRIAL", retryAfterMs);
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_quota_mark_failed", error: (err as Error).message }));
  }
}

export async function syncQuotaIfDue(settings: RouterSettings): Promise<void> {
  await maybeSyncProviderQuota(settings).catch(() => undefined);
}

// ─── Task runs ────────────────────────────────────────────────────────────────

export async function openTaskRun(input: { orgId: string; taskType: string; feature: string; settings: RouterSettings; feasibility: Feasibility; detail?: Record<string, unknown>; userId?: string | null; correlationId: string; scanId?: string | null; researchRunId?: string | null; aivBrandId?: string | null }): Promise<string | null> {
  try {
    return await createTaskRun({
      orgId: input.orgId, taskType: input.taskType, feature: input.feature, feasibility: input.feasibility, feasibilityDetail: input.detail,
      limits: taskLimitsFrom(input.settings), createdBy: input.userId ?? null, correlationId: input.correlationId,
      scanId: input.scanId ?? null, researchRunId: input.researchRunId ?? null, aivBrandId: input.aivBrandId ?? null,
    });
  } catch (err) {
    // A task-run record is bookkeeping; the per-call budget gates still apply without it.
    console.warn(JSON.stringify({ level: "warn", event: "ai_task_run_create_failed", error: (err as Error).message }));
    return null;
  }
}

export async function closeTaskRun(id: string | null, orgId: string, status: Exclude<TaskRunStatus, "RUNNING">, fields: { errorCode?: string | null; selectedModel?: string | null; feasibility?: Feasibility } = {}): Promise<void> {
  if (id) await finishTaskRun(id, orgId, status, fields);
}

export async function withGovernanceTransaction<T>(fn: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
  return withTransaction((client) => fn(client as unknown as { query: typeof query }));
}
