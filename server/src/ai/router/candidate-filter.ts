// Phase 3C: Deterministic hard-constraint filtering.
// This is application policy — OX Alpha CANNOT override these decisions.

import type { ModelRow, ReliabilityRow } from "../registry.service.js";
import { calculateEligibility } from "../registry.service.js";
import type {
  TaskRequirements,
  ExcludedCandidate,
  ExclusionReason,
} from "./types.js";

/**
 * Phase 11 gates. Present for live routing; absent in legacy callers, which
 * keep the earlier behaviour. Every gate fails closed.
 */
export interface GateContext {
  paidAllowed: boolean;
  trialsEnabled: boolean;
  freePoolRemaining: number;
  trialPoolRemaining: number;
  maxStaleHours: number;
  coolingDown: ReadonlySet<string>;
  now: Date;
  /** Output tokens the task needs at minimum; models whose output cap is lower are excluded. */
  minOutputTokens?: number;
}

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
  reliability?: Map<string, ReliabilityRow>,
  gates?: GateContext
): FilterResult {
  const eligible: ModelRow[] = [];
  const excluded: ExcludedCandidate[] = [];

  const freeOnly = requirements.freeOnly ?? false;
  const minReliability = requirements.minimumReliability;
  const excludedSet = new Set<string>(requirements.excludedModels ?? []);

  for (const model of models) {
    const excl = (gates ? findGateExclusion(model, gates) : null)
      ?? findExclusion(model, requirements, freeOnly, minReliability, excludedSet, reliability)
      ?? (gates ? findSizeExclusion(model, requirements, gates) : null);
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

/** Pricing, trial, quota, health and freshness gates (Phase 11). */
export function findGateExclusion(model: ModelRow, g: GateContext): Exclusion | null {
  if (model.is_router || model.openrouter_id.startsWith("openrouter/")) {
    return { reason: "ROUTER_ALIAS", detail: "Routing alias whose underlying model and price are chosen by the provider" };
  }
  const out = model.output_modalities ?? [];
  if (out.length > 0 && (out.length !== 1 || out[0] !== "text")) {
    return { reason: "NON_TEXT_OUTPUT", detail: `Output modalities: ${out.join(", ")}` };
  }
  const cls = model.pricing_class ?? "UNKNOWN";
  if (cls === "PAID" && !g.paidAllowed) return { reason: "PRICING_PAID", detail: "Paid model; paid usage is not enabled" };
  if (cls === "UNKNOWN" && !g.paidAllowed) return { reason: "PRICING_UNKNOWN", detail: "Price could not be established; refusing to risk a charge" };
  if (cls === "TRIAL") {
    if (!g.trialsEnabled) return { reason: "TRIAL_DISABLED", detail: "Time-limited free model; trial usage is disabled" };
    const exp = model.expires_at ? new Date(model.expires_at) : null;
    if (!exp || exp.getTime() <= g.now.getTime()) return { reason: "TRIAL_EXPIRED", detail: "Free period has ended" };
    if (g.trialPoolRemaining <= 0) return { reason: "QUOTA_EXHAUSTED", detail: "Daily trial allowance used" };
  }
  if ((cls === "FREE" || cls === "TRIAL") && g.freePoolRemaining <= 0) {
    return { reason: "QUOTA_EXHAUSTED", detail: "Daily free-model allowance used" };
  }
  const checked = model.pricing_checked_at ? new Date(model.pricing_checked_at).getTime() : 0;
  if (!checked || g.now.getTime() - checked > g.maxStaleHours * 3_600_000) {
    return { reason: "CATALOG_STALE", detail: "Pricing was not confirmed recently" };
  }
  if (g.coolingDown.has(model.openrouter_id)) {
    return { reason: "COOLING_DOWN", detail: "Recently rate-limited or failing; waiting before retrying" };
  }
  return null;
}

/** Context window and output cap against the request size (Phase 11). */
function findSizeExclusion(model: ModelRow, requirements: TaskRequirements, g: GateContext): Exclusion | null {
  const minOut = g.minOutputTokens ?? 0;
  if (minOut > 0 && model.max_completion_tokens && model.max_completion_tokens < minOut) {
    return { reason: "OUTPUT_LIMIT_TOO_LOW", detail: `Output cap ${model.max_completion_tokens} < ${minOut} needed` };
  }
  const input = requirements.estimatedInputTokens ?? 0;
  if (input > 0) {
    const ctx = model.context_length ?? 0;
    const margin = Math.max(256, Math.ceil(ctx * 0.05));
    const need = input + Math.max(minOut, 1) + margin;
    if (ctx < need) {
      return { reason: "CONTEXT_TOO_SHORT", detail: `Context ${ctx.toLocaleString()} < ${need.toLocaleString()} needed (approximate)` };
    }
  }
  return null;
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
