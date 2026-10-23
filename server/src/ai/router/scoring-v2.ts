// Phase 11: candidate ranking.
//
// Runs only on candidates that already passed every hard gate (pricing,
// quota, health, capability, context). Ranking can never re-admit an
// excluded model, so quality cannot outrank a security or budget rule.
//
//   composite = Σ weight_i × component_i        (components 0–100, weights sum to 1)
//
//   quality      Bayesian, decayed mean of evaluation scores for this task
//                category, shrunk toward a weak prior (published benchmark
//                index mapped into 35–65, or 50)
//   reliability  Wilson lower bound of recent attempt success (50 when < minSamples)
//   structured   observed JSON validity when the task needs JSON, else declared support
//   latency      recent median latency (50 when unknown)
//   context      headroom of the context window over the request
//   availability recent consecutive failures and remaining trial allowance
//   security     share of evaluated outputs without a security violation
//   resourceFit  lighter models for light tasks, larger windows/output for heavy ones

import type { ModelRow } from "../registry.service.js";
import type { ModelStats } from "./learning.js";
import type { RouterSettings } from "./settings.js";
import type { TaskProfile } from "./task-profiles.js";
import type { ScoreComponent, ScoredCandidate, TaskRequirements } from "./types.js";
import type { ModelHealth } from "../quota.js";

export interface ScoringInput {
  models: ModelRow[];
  requirements: TaskRequirements;
  profile: TaskProfile;
  stats: Map<string, ModelStats>;
  health: Map<string, ModelHealth>;
  settings: RouterSettings;
  trialPool: { remaining: number; limit: number };
}

export function scoreCandidatesV2(input: ScoringInput): ScoredCandidate[] {
  const w = input.settings.weights;
  const pinned = input.settings.models.pins[input.profile.category];
  const scored = input.models.map((model): ScoredCandidate => {
    const st = input.stats.get(model.openrouter_id);
    const quality: ScoreComponent = st
      ? { value: st.quality.value, status: st.quality.status === "KNOWN" ? "KNOWN" : "INSUFFICIENT", detail: `${st.quality.samples} evaluation(s); prior ${st.quality.prior}` }
      : { value: 50, status: "UNKNOWN", detail: "No evaluations" };
    const reliability: ScoreComponent = st && st.reliability.status === "KNOWN"
      ? { value: st.reliability.value, status: "KNOWN", detail: `Wilson lower bound over ${st.reliability.samples} attempts` }
      : { value: 50, status: "UNKNOWN", detail: `${st?.reliability.samples ?? 0} recent attempts (below minimum)` };
    const structured = scoreStructured(model, input.requirements, st);
    const latency = scoreLatency(st?.latencyMedianMs ?? null);
    const context = scoreContext(model, input.requirements);
    const availability = scoreAvailability(model, input.health.get(model.openrouter_id), input.trialPool);
    const security: ScoreComponent = st
      ? { value: st.security, status: "KNOWN", detail: "Share of evaluated outputs without a security violation (smoothed)" }
      : { value: 50, status: "UNKNOWN", detail: "No evaluations" };
    const resourceFit = scoreResourceFit(model, input.profile);
    const preference: ScoreComponent = pinned
      ? { value: pinned === model.openrouter_id ? 100 : 50, status: "KNOWN", detail: pinned === model.openrouter_id ? "Pinned by an administrator" : "Not the pinned model" }
      : { value: 50, status: "KNOWN", detail: "No pin" };

    const composite =
      w.quality * quality.value +
      w.reliability * reliability.value +
      w.structured * structured.value +
      w.latency * latency.value +
      w.context * context.value +
      w.availability * availability.value +
      w.security * security.value +
      w.resourceFit * resourceFit.value;

    return {
      modelId: model.id,
      openrouterId: model.openrouter_id,
      displayName: model.display_name,
      compositeScore: Math.round(composite * 10) / 10,
      pricingClass: model.pricing_class,
      components: {
        // Legacy keys keep the existing decision views working.
        benchmark: quality,
        reliability,
        capability: { value: 100, status: "KNOWN", detail: "Required capabilities enforced by hard gates" },
        historical: security,
        structuredOutput: structured,
        latency,
        context,
        preference,
        availability,
        resourceFit,
        security,
      },
    };
  });
  scored.sort((a, b) => b.compositeScore - a.compositeScore || a.openrouterId.localeCompare(b.openrouterId));
  // An administrator pin wins among eligible candidates; it never bypasses a gate.
  if (pinned) {
    const i = scored.findIndex((c) => c.openrouterId === pinned);
    if (i > 0) scored.unshift(...scored.splice(i, 1));
  }
  return scored;
}

function scoreStructured(model: ModelRow, req: TaskRequirements, st: ModelStats | undefined): ScoreComponent {
  if (!req.structuredOutputRequired) return { value: 100, status: "KNOWN", detail: "Structured output not required" };
  if (st?.jsonValidity !== null && st?.jsonValidity !== undefined) return { value: st.jsonValidity, status: "KNOWN", detail: "Observed JSON validity" };
  const declared = model.supports_json_schema ? 75 : model.supports_structured_output ? 65 : 40;
  return { value: declared, status: "UNKNOWN", detail: "Declared support only" };
}

function scoreLatency(medianMs: number | null): ScoreComponent {
  if (medianMs === null) return { value: 50, status: "UNKNOWN", detail: "No latency data" };
  return { value: clamp(Math.round(100 - medianMs / 600), 0, 100), status: "KNOWN", detail: `Median ${medianMs} ms` };
}

function scoreContext(model: ModelRow, req: TaskRequirements): ScoreComponent {
  const ctx = model.context_length ?? 0;
  if (!ctx) return { value: 50, status: "UNKNOWN", detail: "Context length unknown" };
  const need = (req.estimatedInputTokens ?? 0) + (req.desiredOutputTokens ?? 0);
  if (need <= 0) return { value: ctx >= 128_000 ? 90 : ctx >= 32_000 ? 80 : 60, status: "KNOWN", detail: `${Math.round(ctx / 1000)}k context` };
  const ratio = ctx / need;
  const value = ratio >= 4 ? 100 : ratio >= 2 ? 85 : ratio >= 1.2 ? 70 : 50;
  return { value, status: "KNOWN", detail: `${ratio.toFixed(1)}× the estimated request` };
}

function scoreAvailability(model: ModelRow, health: ModelHealth | undefined, trial: { remaining: number; limit: number }): ScoreComponent {
  let value = 100 - 15 * Math.min(5, health?.consecutiveFailures ?? 0);
  if (model.pricing_class === "TRIAL" && trial.limit > 0) value = Math.min(value, 30 + 70 * (trial.remaining / trial.limit));
  return { value: clamp(Math.round(value), 0, 100), status: "KNOWN", detail: `${health?.consecutiveFailures ?? 0} consecutive failure(s)` };
}

function scoreResourceFit(model: ModelRow, profile: TaskProfile): ScoreComponent {
  const ctx = model.context_length ?? 0;
  const out = model.max_completion_tokens ?? 0;
  const intelligence = num(model.benchmark_intelligence);
  if (profile.tier === "LIGHT") {
    // Routine work: avoid models that always spend tokens reasoning, and very large models.
    let v = 100;
    if (model.reasoning_mandatory) v -= 40;
    if (intelligence !== null && intelligence >= 40) v -= 15;
    return { value: clamp(v, 0, 100), status: "KNOWN", detail: "Light task: prefers lean models" };
  }
  if (profile.tier === "HEAVY") {
    let v = 100;
    if (out && out < 8_192) v -= 30;
    if (ctx && ctx < 64_000) v -= 20;
    return { value: clamp(v, 0, 100), status: "KNOWN", detail: "Heavy task: prefers large windows and output" };
  }
  return { value: model.reasoning_mandatory ? 65 : 80, status: "KNOWN", detail: "Standard task" };
}

/** Deterministic exploration draw from the correlation id (reproducible in tests and audits). */
export function explorationDraw(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * With probability `rate`, and only for low-risk tasks, promotes the least
 * sampled low-confidence candidate among the top three so new free models
 * gather evidence. Returns null when no exploration happens.
 */
export function pickExploration(scored: ScoredCandidate[], rate: number, seed: string, risk: string): ScoredCandidate | null {
  if (rate <= 0 || risk !== "LOW" || scored.length < 2) return null;
  if (explorationDraw(seed) >= rate) return null;
  const pool = scored.slice(0, 3).filter((c) => c.components.benchmark.status !== "KNOWN");
  const choice = pool.find((c) => c !== scored[0]);
  return choice ?? null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
