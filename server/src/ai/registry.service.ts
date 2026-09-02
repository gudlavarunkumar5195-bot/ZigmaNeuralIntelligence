import { query } from "../db/client.js";
import { audit } from "../services/audit.service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelStatus =
  | "DISCOVERED" | "AVAILABLE" | "ELIGIBLE"
  | "DISABLED" | "UNAVAILABLE" | "STALE"
  | "DEPRECATED" | "REQUIRES_REVIEW";

export type EligibilityStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW" | "DISABLED";
export type FreeStatus = "FREE" | "PAID" | "UNKNOWN" | "CHANGED";
export type BenchmarkEvaluationStatus = "NOT_BENCHMARKED" | "IN_PROGRESS" | "BENCHMARKED" | "STALE";

export interface ModelRow {
  id: string;
  openrouter_id: string;
  display_name: string;
  provider: string;
  description: string | null;
  context_length: number | null;
  free_status: FreeStatus;
  status: ModelStatus;
  eligibility_status: EligibilityStatus;
  supports_tool_calling: boolean;
  supports_structured_output: boolean;
  supports_reasoning: boolean;
  supports_coding: boolean;
  supports_vision: boolean;
  input_modalities: string[];
  output_modalities: string[];
  enabled: boolean;
  first_seen_at: string;
  last_seen_at: string;
  last_catalog_refresh: string | null;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkRow {
  id: string;
  model_id: string;
  task_type: string;
  score: number | null;
  sample_size: number | null;
  benchmark_version: string | null;
  evaluation_status: BenchmarkEvaluationStatus;
  evaluated_at: string | null;
}

export interface ReliabilityRow {
  id: string;
  model_id: string;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  timeout_requests: number;
  rate_limited_requests: number;
  malformed_responses: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_updated: string;
}

export interface ModelHistoryRow {
  id: string;
  model_id: string;
  event_type: string;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
}

export interface ModelDetail extends ModelRow {
  benchmarks: BenchmarkRow[];
  reliability: ReliabilityRow | null;
  history: ModelHistoryRow[];
}

export interface EligibilityPolicy {
  freeOnly?: boolean;
  minReliability?: number;
  minBenchmarkScore?: number;
  taskType?: string;
}

export interface ListModelsFilter {
  status?: ModelStatus;
  eligibility?: EligibilityStatus;
  freeOnly?: boolean;
  enabled?: boolean;
}

// ─── Eligibility (deterministic) ─────────────────────────────────────────────
//
// This is application policy — never overridden by an LLM.

export function calculateEligibility(model: ModelRow, policy: EligibilityPolicy = {}): EligibilityStatus {
  if (!model.enabled) return "DISABLED";
  if (model.status === "DISABLED") return "DISABLED";
  if (model.status === "DEPRECATED") return "NOT_ELIGIBLE";
  if (model.status === "STALE" || model.status === "UNAVAILABLE") return "NOT_ELIGIBLE";
  if (model.status === "DISCOVERED" || model.status === "REQUIRES_REVIEW") return "PENDING_REVIEW";
  if (model.free_status === "CHANGED") return "PENDING_REVIEW";

  if (policy.freeOnly && model.free_status !== "FREE") return "NOT_ELIGIBLE";

  return "ELIGIBLE";
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listModels(filter: ListModelsFilter = {}): Promise<ModelRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filter.status !== undefined) {
    conditions.push(`status = $${idx++}`);
    values.push(filter.status);
  }
  if (filter.eligibility !== undefined) {
    conditions.push(`eligibility_status = $${idx++}`);
    values.push(filter.eligibility);
  }
  if (filter.freeOnly) {
    conditions.push(`free_status = $${idx++}`);
    values.push("FREE");
  }
  if (filter.enabled !== undefined) {
    conditions.push(`enabled = $${idx++}`);
    values.push(filter.enabled);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query<ModelRow>(
    `SELECT * FROM models ${where} ORDER BY display_name ASC`,
    values
  );
  return rows;
}

// ─── Get single ───────────────────────────────────────────────────────────────

export async function getModel(id: string): Promise<ModelDetail | null> {
  const { rows } = await query<ModelRow>(
    "SELECT * FROM models WHERE id = $1",
    [id]
  );
  if (rows.length === 0) return null;
  const model = rows[0];

  const [benchmarkResult, reliabilityResult, historyResult] = await Promise.all([
    query<BenchmarkRow>(
      "SELECT * FROM model_benchmarks WHERE model_id=$1 ORDER BY task_type",
      [id]
    ),
    query<ReliabilityRow>(
      "SELECT * FROM model_reliability WHERE model_id=$1",
      [id]
    ),
    query<ModelHistoryRow>(
      "SELECT * FROM model_history WHERE model_id=$1 ORDER BY created_at DESC LIMIT 50",
      [id]
    ),
  ]);

  return {
    ...model,
    benchmarks: benchmarkResult.rows,
    reliability: reliabilityResult.rows[0] ?? null,
    history: historyResult.rows,
  };
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enableModel(
  modelId: string,
  actorId: string,
  orgId?: string
): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean; status: string }>(
    "SELECT enabled, status FROM models WHERE id=$1",
    [modelId]
  );
  if (rows.length === 0) return false;

  const prev = rows[0];
  await query(
    "UPDATE models SET enabled=TRUE, updated_at=NOW() WHERE id=$1",
    [modelId]
  );

  await recordHistory(modelId, "ENABLED", { enabled: prev.enabled }, { enabled: true }, null, actorId);
  await recomputeEligibility(modelId);
  await audit({ userId: actorId, orgId, action: "model_enabled", resourceType: "model", resourceId: modelId as unknown as string, result: "success" });
  return true;
}

export async function disableModel(
  modelId: string,
  actorId: string,
  reason: string,
  orgId?: string
): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean }>(
    "SELECT enabled FROM models WHERE id=$1",
    [modelId]
  );
  if (rows.length === 0) return false;

  await query(
    "UPDATE models SET enabled=FALSE, eligibility_status='DISABLED', updated_at=NOW() WHERE id=$1",
    [modelId]
  );

  await recordHistory(modelId, "DISABLED", { enabled: true }, { enabled: false }, reason, actorId);
  await audit({ userId: actorId, orgId, action: "model_disabled", resourceType: "model", resourceId: modelId as unknown as string, result: "success", metadata: { reason } });
  return true;
}

// ─── Recalculate eligibility ──────────────────────────────────────────────────

export async function recomputeEligibility(modelId: string): Promise<EligibilityStatus> {
  const { rows } = await query<ModelRow>("SELECT * FROM models WHERE id=$1", [modelId]);
  if (rows.length === 0) return "NOT_ELIGIBLE";

  const newEligibility = calculateEligibility(rows[0]);
  await query(
    "UPDATE models SET eligibility_status=$2, updated_at=NOW() WHERE id=$1",
    [modelId, newEligibility]
  );
  return newEligibility;
}

// ─── Get eligible models ──────────────────────────────────────────────────────

export async function getEligibleModels(policy: EligibilityPolicy = {}): Promise<ModelRow[]> {
  const all = await listModels({ enabled: true });
  return all.filter((m) => calculateEligibility(m, policy) === "ELIGIBLE");
}

// ─── Reliability update ───────────────────────────────────────────────────────
//
// Called after each agent execution to keep reliability metrics current.

export interface ReliabilityEvent {
  openrouterId: string;
  outcome: "success" | "failed" | "timeout" | "rate_limited" | "malformed";
  latencyMs?: number;
}

export async function recordReliabilityEvent(event: ReliabilityEvent): Promise<void> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM models WHERE openrouter_id=$1",
    [event.openrouterId]
  );
  if (rows.length === 0) return;
  const modelId = rows[0].id;

  // Ensure reliability row exists
  await query(
    `INSERT INTO model_reliability (model_id) VALUES ($1)
     ON CONFLICT (model_id) DO NOTHING`,
    [modelId]
  );

  // Increment appropriate counters
  const outcomeCol = {
    success: "successful_requests",
    failed: "failed_requests",
    timeout: "timeout_requests",
    rate_limited: "rate_limited_requests",
    malformed: "malformed_responses",
  }[event.outcome];

  await query(
    `UPDATE model_reliability
     SET total_requests = total_requests + 1,
         ${outcomeCol} = ${outcomeCol} + 1,
         last_updated = NOW()
     WHERE model_id = $1`,
    [modelId]
  );

  // Update average latency if provided
  if (event.latencyMs !== undefined) {
    await query(
      `UPDATE model_reliability
       SET avg_latency_ms = CASE
         WHEN avg_latency_ms IS NULL THEN $2
         ELSE (avg_latency_ms * (total_requests - 1) + $2) / total_requests
       END
       WHERE model_id = $1`,
      [modelId, event.latencyMs]
    );
  }
}

// ─── Tenant preferences ───────────────────────────────────────────────────────

export interface OrgPreference {
  taskType: string;
  preferredModelId: string | null;
  fallbackModelIds: string[];
  freeOnly: boolean;
  minReliability: number;
  minBenchmarkScore: number;
}

export async function getOrgPreferences(orgId: string): Promise<OrgPreference[]> {
  const { rows } = await query<{
    task_type: string;
    preferred_model_id: string | null;
    fallback_model_ids: string[];
    free_only: boolean;
    min_reliability: number;
    min_benchmark_score: number;
  }>(
    "SELECT * FROM model_preferences WHERE org_id=$1 AND enabled=TRUE ORDER BY task_type",
    [orgId]
  );
  return rows.map((r) => ({
    taskType: r.task_type,
    preferredModelId: r.preferred_model_id,
    fallbackModelIds: r.fallback_model_ids ?? [],
    freeOnly: r.free_only,
    minReliability: Number(r.min_reliability),
    minBenchmarkScore: Number(r.min_benchmark_score),
  }));
}

export async function upsertOrgPreference(
  orgId: string,
  pref: OrgPreference,
  actorId: string
): Promise<void> {
  await query(
    `INSERT INTO model_preferences
       (org_id, task_type, preferred_model_id, fallback_model_ids, free_only,
        min_reliability, min_benchmark_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, task_type) DO UPDATE
       SET preferred_model_id=$3, fallback_model_ids=$4, free_only=$5,
           min_reliability=$6, min_benchmark_score=$7, updated_at=NOW()`,
    [orgId, pref.taskType, pref.preferredModelId, pref.fallbackModelIds,
     pref.freeOnly, pref.minReliability, pref.minBenchmarkScore]
  );
  await audit({ userId: actorId, orgId, action: "model_preference_updated", resourceType: "model_preference", resourceId: orgId as unknown as string, result: "success" });
}

// ─── History helper ───────────────────────────────────────────────────────────

async function recordHistory(
  modelId: string, eventType: string,
  oldValue: unknown, newValue: unknown,
  reason: string | null, actorId: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO model_history (model_id, event_type, old_value, new_value, reason, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [modelId, eventType,
       oldValue ? JSON.stringify(oldValue) : null,
       newValue ? JSON.stringify(newValue) : null,
       reason, actorId]
    );
  } catch { /* history must never crash main flow */ }
}
