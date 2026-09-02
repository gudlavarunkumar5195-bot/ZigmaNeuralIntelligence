// Phase 3C: Deterministic hard-constraint filtering.
// This is application policy — OX Alpha CANNOT override these decisions.

import type { ModelRow, ReliabilityRow } from "../registry.service.js";
import { calculateEligibility } from "../registry.service.js";
import type {
  TaskRequirements,
  ExcludedCandidate,
  ExclusionReason,
} from "./types.js";

export interface FilterResult {
  eligible: ModelRow[];
  excluded: ExcludedCandidate[];
}

// Minimum requests required before reliability filtering applies.
// Below this threshold we cannot make a reliable statistical judgement.
const MIN_RELIABILITY_SAMPLE = 10;

export function filterCandidates(
  models: ModelRow[],
  requirements: TaskRequirements,
  reliability?: Map<string, ReliabilityRow>
): FilterResult {
  const eligible: ModelRow[] = [];
  const excluded: ExcludedCandidate[] = [];

  const freeOnly = requirements.freeOnly ?? false;
  const minReliability = requirements.minimumReliability;
  const excludedSet = new Set<string>(requirements.excludedModels ?? []);

  for (const model of models) {
    const excl = findExclusion(model, requirements, freeOnly, minReliability, excludedSet, reliability);
    if (excl) {
      excluded.push({
        openrouterId: model.openrouter_id,
        displayName: model.display_name,
        reason: excl.reason,
        detail: excl.detail,
      });
    } else {
      eligible.push(model);
    }
  }

  return { eligible, excluded };
}

interface Exclusion {
  reason: ExclusionReason;
  detail?: string;
}

function findExclusion(
  model: ModelRow,
  requirements: TaskRequirements,
  freeOnly: boolean,
  minReliability: number | undefined,
  excludedSet: Set<string>,
  reliability?: Map<string, ReliabilityRow>
): Exclusion | null {
  // ── Explicit exclusion (hard) ──────────────────────────────────────────────
  if (excludedSet.has(model.openrouter_id)) {
    return { reason: "EXPLICITLY_EXCLUDED", detail: "Model in exclusion list" };
  }

  // ── Provider restriction (hard) ───────────────────────────────────────────
  if (requirements.allowedProviders && requirements.allowedProviders.length > 0) {
    const allowed = requirements.allowedProviders.some((p) =>
      model.openrouter_id.startsWith(p + "/") || model.provider === p
    );
    if (!allowed) {
      return { reason: "PROVIDER_EXCLUDED", detail: `Provider '${model.provider}' not in allowed list` };
    }
  }

  // ── Eligibility check (hard) ──────────────────────────────────────────────
  const eligibility = calculateEligibility(model, { freeOnly });
  if (eligibility === "DISABLED") {
    return { reason: "DISABLED", detail: "Model is disabled" };
  }
  if (eligibility !== "ELIGIBLE") {
    return { reason: "NOT_ELIGIBLE", detail: `Eligibility: ${eligibility}` };
  }

  // ── Free-only policy (hard) ───────────────────────────────────────────────
  // Already handled by calculateEligibility above when freeOnly=true,
  // but explicit check for clarity and correct reason code.
  if (freeOnly && model.free_status !== "FREE") {
    return { reason: "FREE_ONLY_VIOLATION", detail: "Free-only policy active; model is PAID" };
  }

  // ── Required capabilities (hard) ─────────────────────────────────────────
  if (requirements.structuredOutputRequired && !model.supports_structured_output) {
    return { reason: "MISSING_STRUCTURED_OUTPUT", detail: "Task requires structured output (JSON)" };
  }
  if (requirements.toolCallingRequired && !model.supports_tool_calling) {
    return { reason: "MISSING_TOOL_CALLING", detail: "Task requires tool/function calling" };
  }
  if (requirements.visionRequired && !model.supports_vision) {
    return { reason: "MISSING_VISION", detail: "Task requires vision/image input capability" };
  }

  // ── Context length (hard) ─────────────────────────────────────────────────
  if (requirements.minimumContextLength && requirements.minimumContextLength > 0) {
    const ctx = model.context_length ?? 0;
    if (ctx < requirements.minimumContextLength) {
      return {
        reason: "CONTEXT_TOO_SHORT",
        detail: `Model context ${ctx.toLocaleString()} < required ${requirements.minimumContextLength.toLocaleString()}`,
      };
    }
  }

  // ── Minimum reliability (hard, only when sufficient data exists) ──────────
  if (minReliability !== undefined && minReliability > 0) {
    const rel = reliability?.get(model.id);
    if (rel && rel.total_requests >= MIN_RELIABILITY_SAMPLE) {
      const rate = rel.total_requests > 0
        ? rel.successful_requests / rel.total_requests
        : 0;
      if (rate < minReliability) {
        return {
          reason: "BELOW_MIN_RELIABILITY",
          detail: `Reliability ${(rate * 100).toFixed(1)}% < required ${(minReliability * 100).toFixed(1)}%`,
        };
      }
    }
    // When sample < threshold: pass through (insufficient data, don't exclude)
  }

  return null;
}
