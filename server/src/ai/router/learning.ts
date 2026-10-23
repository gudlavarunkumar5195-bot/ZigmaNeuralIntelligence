// Phase 11: learned model performance.
//
// Model ranking improves only from persisted, verified records:
//   * ai_model_evaluations (deterministic validators, and explicit user feedback),
//   * model attempt rows (success, latency, failure category).
// Observations decay exponentially with a configurable half-life, quality is
// a Bayesian mean shrunk toward a weak prior, and nothing is reported as
// KNOWN until a minimum number of real samples exists. A single rating or a
// single success cannot move a model far. Learning never touches prompts,
// policies, permissions or limits: it only produces scores.

import { query } from "../../db/client.js";
import type { BenchmarkFocus } from "./task-profiles.js";

export const PRIOR_WEIGHT = 4;          // pseudo-observations behind the prior
export const PRIOR_RANGE = [35, 65] as const; // published benchmarks can only nudge the prior
const EVALUATION_WINDOW_DAYS = 90;
const ATTEMPT_WINDOW_DAYS = 14;

export interface Observation { score: number; ageDays: number; securityViolation?: boolean; jsonValid?: boolean | null; method?: string; /** Evidence weight (default 1). */ weight?: number }

/** How much one evaluation counts: user ratings and structure-only checks are weak evidence. */
export function evidenceWeight(method: string | undefined, confidence: string | undefined): number {
  const byConfidence = confidence === "HIGH" ? 1 : confidence === "MEDIUM" ? 0.8 : 0.5;
  return method === "USER_FEEDBACK" ? Math.min(byConfidence, 0.25) : byConfidence;
}

/** Max user-feedback evaluations per organization and model counted in a window (one org cannot steer rankings). */
export const MAX_FEEDBACK_PER_ORG_MODEL = 3;

export function decayWeight(ageDays: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / Math.max(1, halfLifeDays));
}

export interface QualityEstimate {
  value: number;            // 0–100
  samples: number;          // raw count
  effectiveSamples: number; // decayed weight sum
  status: "KNOWN" | "LOW_CONFIDENCE";
  prior: number;
}

/** Bayesian mean of decayed scores, shrunk toward the prior with PRIOR_WEIGHT pseudo-observations. */
export function estimateQuality(observations: Observation[], prior: number, halfLifeDays: number, minSamples: number): QualityEstimate {
  let wSum = 0;
  let wScore = 0;
  for (const o of observations) {
    const w = decayWeight(o.ageDays, halfLifeDays) * (o.weight ?? 1);
    wSum += w;
    wScore += w * clamp(o.score, 0, 100);
  }
  const value = (PRIOR_WEIGHT * prior + wScore) / (PRIOR_WEIGHT + wSum);
  return {
    value: round1(value),
    samples: observations.length,
    effectiveSamples: round1(wSum),
    status: observations.length >= minSamples && wSum >= minSamples / 2 ? "KNOWN" : "LOW_CONFIDENCE",
    prior: round1(prior),
  };
}

/** Security compliance: Beta(1,1)-smoothed share of evaluated outputs without a security violation. */
export function estimateSecurity(observations: Observation[], halfLifeDays: number): number {
  let wSum = 0;
  let wClean = 0;
  for (const o of observations) {
    const w = decayWeight(o.ageDays, halfLifeDays);
    wSum += w;
    if (!o.securityViolation) wClean += w;
  }
  return round1(((wClean + 1) / (wSum + 2)) * 100);
}

/** Lower bound of the 95% Wilson interval: an honest success rate for small samples. */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

/** Maps a published benchmark index into the narrow prior range relative to the candidate set. */
export function benchmarkPrior(value: number | null, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return 50;
  if (max <= min) return 50;
  const t = clamp((value - min) / (max - min), 0, 1);
  return round1(PRIOR_RANGE[0] + t * (PRIOR_RANGE[1] - PRIOR_RANGE[0]));
}

export interface ModelStats {
  quality: QualityEstimate;
  security: number;
  jsonValidity: number | null;   // 0–100, null without structured-output evaluations
  reliability: { value: number; samples: number; status: "KNOWN" | "UNKNOWN" };
  latencyMedianMs: number | null;
}

interface EvaluationRow { model: string; task_type: string; quality_score: number; security_violation: boolean; validators: unknown; age_days: number; method: string; confidence: string; org_id: string }
interface AttemptRow { model_id: string; total: string; ok: string; latency_p50: number | null }

/**
 * Loads decayed statistics for candidate models on one task category.
 * Evaluations are aggregated across organizations as scores only (no task
 * content), so every tenant benefits from measured model quality.
 */
export async function loadModelStats(input: {
  models: Array<{ openrouterId: string; benchmarks: Record<BenchmarkFocus, number | null> }>;
  category: string;
  focus: BenchmarkFocus;
  halfLifeDays: number;
  minSamples: number;
}): Promise<Map<string, ModelStats>> {
  const ids = input.models.map((m) => m.openrouterId);
  const out = new Map<string, ModelStats>();
  if (ids.length === 0) return out;

  const [evals, attempts] = await Promise.all([
    query<EvaluationRow>(
      `SELECT model, task_type, quality_score, security_violation, validators, method, confidence, org_id,
              EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 AS age_days
         FROM ai_model_evaluations
        WHERE model = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval
        ORDER BY created_at DESC LIMIT 5000`,
      [ids, String(EVALUATION_WINDOW_DAYS)],
    ),
    // Only failures attributable to the model count against reliability.
    query<AttemptRow>(
      `SELECT model_id,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'completed' AND failure_category IS NULL) AS ok,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'completed') AS latency_p50
         FROM agent_executions
        WHERE execution_kind = 'MODEL_ATTEMPT' AND model_id = ANY($1::text[])
          AND started_at > NOW() - ($2 || ' days')::interval
          AND status IN ('completed', 'failed')
          AND (failure_category IS NULL OR failure_category NOT IN ('CANCELLED','BUDGET_EXHAUSTED','QUOTA_EXHAUSTED','AUTH_CONFIG','POLICY_BLOCKED','NETWORK','CONTEXT_OVERFLOW','SAFETY_REJECTION','REQUEST_REJECTED'))
        GROUP BY model_id`,
      [ids, String(ATTEMPT_WINDOW_DAYS)],
    ),
  ]);

  const focusValues = input.models.map((m) => m.benchmarks[input.focus]).filter((v): v is number => v !== null && Number.isFinite(v));
  const min = focusValues.length ? Math.min(...focusValues) : 0;
  const max = focusValues.length ? Math.max(...focusValues) : 0;

  for (const m of input.models) {
    const feedbackSeen = new Map<string, number>();
    const rows = evals.rows.filter((r) => {
      if (r.model !== m.openrouterId) return false;
      if (r.method !== "USER_FEEDBACK") return true;
      const n = (feedbackSeen.get(r.org_id) ?? 0) + 1;
      feedbackSeen.set(r.org_id, n);
      return n <= MAX_FEEDBACK_PER_ORG_MODEL; // rows are newest first
    });
    const forTask = rows.filter((r) => r.task_type === input.category);
    const toObs = (r: EvaluationRow): Observation => ({
      score: Number(r.quality_score),
      ageDays: Number(r.age_days),
      securityViolation: r.security_violation,
      jsonValid: jsonValidFrom(r.validators),
      method: r.method,
      weight: evidenceWeight(r.method, r.confidence),
    });
    const prior = benchmarkPrior(m.benchmarks[input.focus], min, max);
    const quality = estimateQuality(forTask.map(toObs), prior, input.halfLifeDays, input.minSamples);
    const allObs = rows.map(toObs);
    const security = estimateSecurity(allObs, input.halfLifeDays);
    const jsonObs = allObs.filter((o) => o.jsonValid !== null && o.jsonValid !== undefined);
    const jsonValidity = jsonObs.length ? round1((jsonObs.filter((o) => o.jsonValid).length / jsonObs.length) * 100) : null;

    const a = attempts.rows.find((r) => r.model_id === m.openrouterId);
    const total = Number(a?.total ?? 0);
    const ok = Number(a?.ok ?? 0);
    const reliability = total >= input.minSamples
      ? { value: round1(wilsonLowerBound(ok, total) * 100), samples: total, status: "KNOWN" as const }
      : { value: 50, samples: total, status: "UNKNOWN" as const };
    out.set(m.openrouterId, { quality, security, jsonValidity, reliability, latencyMedianMs: a?.latency_p50 != null ? Math.round(Number(a.latency_p50)) : null });
  }
  return out;
}

function jsonValidFrom(validators: unknown): boolean | null {
  if (!Array.isArray(validators)) return null;
  const v = validators.find((x) => x && typeof x === "object" && (x as { name?: unknown }).name === "json_valid") as { passed?: unknown } | undefined;
  return typeof v?.passed === "boolean" ? v.passed : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
