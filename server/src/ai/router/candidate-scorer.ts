// Phase 3C: Weighted candidate scoring.
// UNKNOWN data uses a neutral 50 score and reduces routing confidence.
// Never silently converts absent data into a high score.

import type { ModelRow, BenchmarkRow, ReliabilityRow } from "../registry.service.js";
import type {
  TaskRequirements,
  ScoredCandidate,
  ScoreComponent,
  ScoringWeights,
  DataStatus,
} from "./types.js";
import { DEFAULT_WEIGHTS } from "./types.js";

const NEUTRAL_SCORE = 50;
const MIN_RELIABILITY_SAMPLE = 10;

// Returns scored candidates sorted descending by compositeScore.
export function scoreCandidates(
  models: ModelRow[],
  requirements: TaskRequirements,
  benchmarks: Map<string, BenchmarkRow[]>,
  reliability: Map<string, ReliabilityRow>,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoredCandidate[] {
  const scored = models.map((model) =>
    scoreModel(
      model,
      requirements,
      benchmarks.get(model.id) ?? [],
      reliability.get(model.id) ?? null,
      weights
    )
  );

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}

function scoreModel(
  model: ModelRow,
  requirements: TaskRequirements,
  benchmarkRows: BenchmarkRow[],
  reliabilityRow: ReliabilityRow | null,
  weights: ScoringWeights
): ScoredCandidate {
  const benchmark = scoreBenchmark(benchmarkRows, requirements.taskType);
  const reliabilityScore = scoreReliability(reliabilityRow);
  const capability = scoreCapability(model, requirements);
  const historical = scoreHistorical(benchmarkRows, requirements.taskType);
  const structuredOut = scoreStructuredOutput(model, requirements);
  const latency = scoreLatency(reliabilityRow, requirements.maximumLatencyMs);
  const context = scoreContext(model, requirements.minimumContextLength);
  const preference = scorePreference(model, requirements.preferredModelId);

  const composite =
    benchmark.value * weights.benchmark +
    reliabilityScore.value * weights.reliability +
    capability.value * weights.capability +
    historical.value * weights.historical +
    structuredOut.value * weights.structuredOutput +
    latency.value * weights.latency +
    context.value * weights.context +
    preference.value * weights.preference;

  return {
    modelId: model.id,
    openrouterId: model.openrouter_id,
    displayName: model.display_name,
    compositeScore: Math.round(composite * 10) / 10,
    components: {
      benchmark,
      reliability: reliabilityScore,
      capability,
      historical,
      structuredOutput: structuredOut,
      latency,
      context,
      preference,
    },
  };
}

// ─── Individual score components ──────────────────────────────────────────────

function scoreBenchmark(rows: BenchmarkRow[], taskType: string): ScoreComponent {
  const match = rows.find((r) => r.task_type === taskType);

  if (!match || match.evaluation_status === "NOT_BENCHMARKED") {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "Not benchmarked for this task type" };
  }
  if (match.evaluation_status === "IN_PROGRESS") {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "Benchmark in progress" };
  }
  if (match.evaluation_status === "STALE") {
    return { value: NEUTRAL_SCORE, status: "INSUFFICIENT", detail: "Benchmark data is stale" };
  }
  if (match.score === null) {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "Benchmark exists but score is null" };
  }

  return {
    value: clamp(match.score, 0, 100),
    status: "KNOWN",
    detail: `Score ${match.score} (sample: ${match.sample_size ?? "unknown"})`,
  };
}

function scoreReliability(rel: ReliabilityRow | null): ScoreComponent {
  if (!rel || rel.total_requests < MIN_RELIABILITY_SAMPLE) {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "Insufficient reliability data" };
  }

  const successRate = rel.successful_requests / rel.total_requests;
  const value = clamp(Math.round(successRate * 100), 0, 100);
  return {
    value,
    status: "KNOWN",
    detail: `${value}% success rate (${rel.total_requests} requests)`,
  };
}

function scoreCapability(model: ModelRow, req: TaskRequirements): ScoreComponent {
  const preferred = req.preferredCapabilities ?? [];
  if (preferred.length === 0) {
    return { value: 100, status: "KNOWN", detail: "No preferred capabilities specified" };
  }

  const capabilityMap: Record<string, boolean> = {
    REASONING: model.supports_reasoning,
    CODING: model.supports_coding,
    VISION: model.supports_vision,
    TOOL_CALLING: model.supports_tool_calling,
    STRUCTURED_OUTPUT: model.supports_structured_output,
    LONG_CONTEXT: (model.context_length ?? 0) >= 100_000,
    // Task-type capabilities derived from model metadata
    SEO: model.supports_reasoning,
    SECURITY: model.supports_reasoning,
    ACCESSIBILITY: model.supports_reasoning,
    PERFORMANCE: model.supports_reasoning,
  };

  const matched = preferred.filter((cap) => capabilityMap[cap] === true).length;
  const value = clamp(Math.round((matched / preferred.length) * 100), 0, 100);
  return {
    value,
    status: "KNOWN",
    detail: `${matched}/${preferred.length} preferred capabilities matched`,
  };
}

function scoreHistorical(rows: BenchmarkRow[], taskType: string): ScoreComponent {
  // Historical task performance comes from task-specific benchmark BENCHMARKED rows.
  // Phase 3G will add verified execution outcome data; for now, fall through
  // to benchmark if present, otherwise UNKNOWN.
  const match = rows.find((r) => r.task_type === taskType && r.evaluation_status === "BENCHMARKED");
  if (!match || match.score === null) {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "No verified historical task data" };
  }
  // Small bonus/penalty relative to 50 for prior history
  return {
    value: clamp(match.score, 0, 100),
    status: "KNOWN",
    detail: `Historical score: ${match.score}`,
  };
}

function scoreStructuredOutput(model: ModelRow, req: TaskRequirements): ScoreComponent {
  if (!req.structuredOutputRequired) {
    return { value: 100, status: "KNOWN", detail: "Structured output not required" };
  }
  // Already filtered out models missing this; if we reach here they have it
  return {
    value: model.supports_structured_output ? 100 : NEUTRAL_SCORE,
    status: "KNOWN",
    detail: model.supports_structured_output ? "Supports structured output" : "Structured output not confirmed",
  };
}

function scoreLatency(
  rel: ReliabilityRow | null,
  maxLatencyMs: number | undefined
): ScoreComponent {
  if (!rel || rel.avg_latency_ms === null || rel.total_requests < MIN_RELIABILITY_SAMPLE) {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "No latency data" };
  }

  const avg = rel.avg_latency_ms;

  if (maxLatencyMs !== undefined) {
    // Score based on percentage of budget used
    const ratio = avg / maxLatencyMs;
    const value = ratio <= 1.0
      ? clamp(Math.round((1 - ratio * 0.5) * 100), 0, 100)
      : 0;
    return { value, status: "KNOWN", detail: `Avg ${avg}ms vs ${maxLatencyMs}ms budget` };
  }

  // No budget: score inversely on absolute latency (lower is better)
  // 500ms → 100, 5000ms → 50, 30000ms → 0
  const value = clamp(Math.round(100 - (avg / 600)), 0, 100);
  return { value, status: "KNOWN", detail: `Avg latency ${avg}ms` };
}

function scoreContext(model: ModelRow, minContext: number | undefined): ScoreComponent {
  const ctx = model.context_length ?? 0;
  if (ctx === 0) {
    return { value: NEUTRAL_SCORE, status: "UNKNOWN", detail: "Context length unknown" };
  }
  if (!minContext || minContext === 0) {
    // Prefer larger context windows slightly
    const value = ctx >= 128_000 ? 100 : ctx >= 32_000 ? 85 : ctx >= 8_000 ? 70 : 55;
    return { value, status: "KNOWN", detail: `Context: ${(ctx / 1000).toFixed(0)}k tokens` };
  }
  // Surplus factor: having 2× the requirement scores 100
  const surplus = ctx / minContext;
  const value = clamp(Math.round(Math.min(surplus, 2) * 50), 0, 100);
  return { value, status: "KNOWN", detail: `Context ${(ctx / 1000).toFixed(0)}k vs ${(minContext / 1000).toFixed(0)}k required` };
}

function scorePreference(model: ModelRow, preferredId: string | undefined): ScoreComponent {
  if (!preferredId) {
    return { value: NEUTRAL_SCORE, status: "KNOWN", detail: "No model preference set" };
  }
  const match = model.openrouter_id === preferredId;
  return {
    value: match ? 100 : 0,
    status: "KNOWN",
    detail: match ? "Matches preferred model" : "Not the preferred model",
  };
}

// ─── Confidence calculation ───────────────────────────────────────────────────

export interface ConfidenceAssessment {
  confidence: number;  // 0–100
  factors: string[];
}

export function calculateRoutingConfidence(
  candidates: ScoredCandidate[]
): ConfidenceAssessment {
  if (candidates.length === 0) {
    return { confidence: 0, factors: ["No eligible candidates"] };
  }

  let confidence = 85;
  const factors: string[] = [];

  const top = candidates[0];
  const second = candidates[1];

  // Close competition between top two candidates
  if (second && Math.abs(top.compositeScore - second.compositeScore) < 5) {
    confidence -= 10;
    factors.push("Top candidates have similar scores — selection is a close call");
  }

  // Count how many candidates have UNKNOWN benchmark data
  const unknownBenchmarks = candidates.filter(
    (c) => c.components.benchmark.status === "UNKNOWN"
  ).length;
  if (unknownBenchmarks > candidates.length / 2) {
    confidence -= 15;
    factors.push(`${unknownBenchmarks}/${candidates.length} candidates lack benchmark data`);
  }

  // Count UNKNOWN reliability data
  const unknownReliability = candidates.filter(
    (c) => c.components.reliability.status === "UNKNOWN"
  ).length;
  if (unknownReliability > candidates.length / 2) {
    confidence -= 10;
    factors.push(`${unknownReliability}/${candidates.length} candidates lack reliability data`);
  }

  // Single candidate — high confidence in selection, lower in quality
  if (candidates.length === 1) {
    confidence -= 5;
    factors.push("Only one eligible candidate");
  }

  if (factors.length === 0) {
    factors.push("Good candidate data quality and clear score separation");
  }

  return { confidence: clamp(confidence, 0, 100), factors };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getDataStatus(candidates: ScoredCandidate[], component: keyof ScoredCandidate["components"]): DataStatus {
  const statuses = candidates.map((c) => c.components[component].status);
  if (statuses.every((s) => s === "KNOWN")) return "KNOWN";
  if (statuses.every((s) => s === "UNKNOWN")) return "UNKNOWN";
  return "INSUFFICIENT";
}
