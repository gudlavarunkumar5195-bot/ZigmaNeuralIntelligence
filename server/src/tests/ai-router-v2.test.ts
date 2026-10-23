// Phase 11 router: pure policy decisions (pricing, context planning, failures,
// learning, ranking, gates, settings, evaluation). No database or network.
import { describe, expect, it } from "vitest";
import { classifyPricing } from "../ai/pricing.js";
import { planContext, estimateTextTokens, outputReservation, type PromptSection, UNKNOWN_CONTEXT_ASSUMPTION } from "../ai/tokens.js";
import { FAILURE_POLICY, categorizeFailure, categorizeOpenRouterError, parseRetryAfterMs, backoffDelayMs, MAX_PROVIDER_COOLDOWN_MS } from "../ai/failures.js";
import { ProviderError } from "../ai/provider.js";
import { estimateQuality, estimateSecurity, wilsonLowerBound, benchmarkPrior, decayWeight, PRIOR_RANGE, evidenceWeight } from "../ai/router/learning.js";
import { scoreCandidatesV2, pickExploration, explorationDraw } from "../ai/router/scoring-v2.js";
import { findGateExclusion, type GateContext } from "../ai/router/candidate-filter.js";
import { DEFAULT_ROUTER_SETTINGS, mergeSettings, routerSettingsSchema, ROUTER_CEILINGS, type RouterSettings } from "../ai/router/settings.js";
import { classifyTask, profileFor } from "../ai/router/task-profiles.js";
import { decideModel } from "../ai/governance.js";
import { cooldownFor, effectiveLimit } from "../ai/quota.js";
import { evaluateDeterministically } from "../ai/evaluation.js";
import { taskLimitsFrom } from "../ai/task-runs.js";
import { qualifiesForAutoApproval, normalizeOpenRouterModel, nextModelStatus } from "../ai/catalog.service.js";
import type { ModelRow } from "../ai/registry.service.js";
import type { ModelStats } from "../ai/router/learning.js";
import type { TaskRequirements } from "../ai/router/types.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const settings = (patch: Partial<RouterSettings> = {}): RouterSettings => ({ ...structuredClone(DEFAULT_ROUTER_SETTINGS), ...patch });

// ─── Pricing classification (real catalog shapes) ─────────────────────────────

describe("pricing classification", () => {
  it("FREE only when every listed price is zero", () => {
    expect(classifyPricing({ id: "a/b:free", pricing: { prompt: "0", completion: "0" }, now: NOW }).pricingClass).toBe("FREE");
    expect(classifyPricing({ id: "a/b", pricing: { prompt: "0", completion: "0", request: "0", image: "0", web_search: "0" }, now: NOW }).pricingClass).toBe("FREE");
  });
  it("any charged field makes the model PAID, including web search, reasoning, cache or a time-of-day override", () => {
    for (const extra of [{ web_search: "0.004" }, { internal_reasoning: "0.000001" }, { input_cache_read: "0.0000001" }, { request: "0.01" }, { image: "0.002" }]) {
      expect(classifyPricing({ id: "x/y:free", pricing: { prompt: "0", completion: "0", ...extra }, now: NOW }).pricingClass).toBe("PAID");
    }
    const overrides = { prompt: "0", completion: "0", overrides: [{ utc_days: ["monday"], prompt: "0.0000003", completion: "0" }] };
    expect(classifyPricing({ id: "x/y", pricing: overrides, now: NOW }).pricingClass).toBe("PAID");
  });
  it("a name or ':free' suffix is not evidence: a paid price wins", () => {
    expect(classifyPricing({ id: "vendor/totally-free:free", pricing: { prompt: "0.000001", completion: "0" }, now: NOW }).pricingClass).toBe("PAID");
  });
  it("negative (dynamic router) prices, missing or unparseable prices are UNKNOWN", () => {
    const router = classifyPricing({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" }, now: NOW });
    expect(router).toMatchObject({ pricingClass: "UNKNOWN", isRouter: true });
    expect(classifyPricing({ id: "a/b", pricing: null, now: NOW }).pricingClass).toBe("UNKNOWN");
    expect(classifyPricing({ id: "a/b", pricing: { prompt: "0" }, now: NOW }).pricingClass).toBe("UNKNOWN");
    expect(classifyPricing({ id: "a/b", pricing: { prompt: "free", completion: "0" }, now: NOW }).pricingClass).toBe("UNKNOWN");
  });
  it("zero price with an announced expiry is a TRIAL until the date, UNKNOWN afterwards", () => {
    expect(classifyPricing({ id: "p/l:free", pricing: { prompt: "0", completion: "0" }, expirationDate: "2026-10-31", now: NOW })).toMatchObject({ pricingClass: "TRIAL" });
    expect(classifyPricing({ id: "p/l:free", pricing: { prompt: "0", completion: "0" }, expirationDate: "2026-10-01", now: NOW }).pricingClass).toBe("UNKNOWN");
    expect(classifyPricing({ id: "p/l:free", pricing: { prompt: "0", completion: "0" }, expirationDate: "not a date", now: NOW }).pricingClass).toBe("UNKNOWN");
  });
  it("normalizes a real catalog entry (OpenRouter /models shape, Oct 2026)", () => {
    const m = normalizeOpenRouterModel({
      id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super (free)", context_length: 262144,
      architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"], tokenizer: "Other" },
      pricing: { prompt: "0", completion: "0" }, top_provider: { context_length: 262144, max_completion_tokens: 235929 },
      supported_parameters: ["max_tokens", "response_format", "structured_outputs", "tools"], expiration_date: null,
      reasoning: { mandatory: false }, benchmarks: { artificial_analysis: { intelligence_index: 12.8, coding_index: 37.7, agentic_index: 1.7 } },
    })!;
    expect(m).toMatchObject({ pricingClass: "FREE", freeStatus: "FREE", contextLength: 262144, maxCompletionTokens: 235929, supportsJsonSchema: true, supportsToolCalling: true, isRouter: false, benchmarks: { intelligence: 12.8, coding: 37.7, agentic: 1.7 } });
    const music = normalizeOpenRouterModel({ id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } })!;
    expect(qualifiesForAutoApproval(music, { free: true, trial: true })).toBe(false);
    expect(qualifiesForAutoApproval(m, { free: true, trial: false })).toBe(true);
    expect(qualifiesForAutoApproval(m, { free: false, trial: false })).toBe(false);
    const routerAlias = normalizeOpenRouterModel({ id: "openrouter/free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } })!;
    expect(qualifiesForAutoApproval(routerAlias, { free: true, trial: true })).toBe(false);
  });
});

// ─── Token planning ───────────────────────────────────────────────────────────

const sec = (id: string, kind: PromptSection["kind"], chars: number, extra: Partial<PromptSection> = {}): PromptSection => ({ id, role: kind === "policy" || kind === "instructions" ? "system" : "user", kind, content: "a".repeat(chars), ...extra });
const limits = { maxInputTokens: 100_000, maxOutputTokens: 4_096, maxReductionIterations: 3 };

describe("token planning", () => {
  it("estimates conservatively (≥ 1 token per 3 UTF-8 bytes) and calibration only raises", () => {
    expect(estimateTextTokens("abc".repeat(100))).toBe(100);
    expect(estimateTextTokens("日本語")).toBe(3);
    expect(estimateTextTokens("abc".repeat(100), 1.5)).toBe(150);
    expect(estimateTextTokens("abc".repeat(100), 0.2)).toBe(100);
  });
  it("small request fits", () => {
    const p = planContext({ sections: [sec("p", "policy", 300), sec("u", "user_request", 600)], model: { contextLength: 8_000, maxCompletionTokens: null }, desiredOutputTokens: 1_000, minOutputTokens: 200, limits });
    expect(p).toMatchObject({ status: "FEASIBLE", reservedOutputTokens: 1_000, approximate: true });
    expect(p.estimatedInputTokens + p.reservedOutputTokens + p.safetyMargin).toBeLessThanOrEqual(8_000);
  });
  it("long history and retrieved documents are dropped first; required sections never", () => {
    const sections = [sec("p", "policy", 900), sec("u", "user_request", 900), sec("h1", "history", 9_000, { priority: 0 }), sec("h2", "history", 9_000, { priority: 1 }), sec("e", "evidence", 3_000, { required: true }), sec("r", "retrieved", 9_000)];
    const p = planContext({ sections, model: { contextLength: 8_000, maxCompletionTokens: null }, desiredOutputTokens: 1_000, minOutputTokens: 200, limits });
    expect(p.status).toBe("FEASIBLE_WITH_REDUCTION");
    expect(p.droppedSectionIds).toEqual(expect.arrayContaining(["h1"]));
    expect(p.droppedSectionIds).not.toContain("p");
    expect(p.droppedSectionIds).not.toContain("u");
    expect(p.droppedSectionIds).not.toContain("e");
    expect(p.messages.map((m) => m.content).join("")).toContain("a".repeat(3_000));
  });
  it("tool definitions count toward the input", () => {
    const base = [sec("p", "policy", 300), sec("u", "user_request", 300)];
    const a = planContext({ sections: base, model: { contextLength: 100_000, maxCompletionTokens: null }, desiredOutputTokens: 500, minOutputTokens: 100, limits });
    const b = planContext({ sections: [...base, sec("t", "tool_spec", 6_000, { required: true })], model: { contextLength: 100_000, maxCompletionTokens: null }, desiredOutputTokens: 500, minOutputTokens: 100, limits });
    expect(b.estimatedInputTokens - a.estimatedInputTokens).toBeGreaterThanOrEqual(2_000);
  });
  it("oversized required content does not fit (caller splits or picks a larger model)", () => {
    const p = planContext({ sections: [sec("p", "policy", 300), sec("u", "user_request", 60_000)], model: { contextLength: 8_000, maxCompletionTokens: null }, desiredOutputTokens: 1_000, minOutputTokens: 200, limits });
    expect(p.status).toBe("DOES_NOT_FIT");
    expect(p.reason).toMatch(/required context exceeds/);
  });
  it("lowers the output reservation only down to the task's minimum", () => {
    const p = planContext({ sections: [sec("p", "policy", 300), sec("u", "user_request", 18_000)], model: { contextLength: 8_000, maxCompletionTokens: null }, desiredOutputTokens: 4_000, minOutputTokens: 500, limits });
    expect(p.status).toBe("FEASIBLE_WITH_REDUCTION");
    expect(p.reservedOutputTokens).toBeGreaterThanOrEqual(500);
    expect(p.reservedOutputTokens).toBeLessThan(4_000);
  });
  it("respects the model's output cap and reserves extra for mandatory reasoning", () => {
    expect(outputReservation(4_000, { contextLength: 100_000, maxCompletionTokens: 2_048 }, { maxOutputTokens: 8_000 })).toBe(2_048);
    expect(outputReservation(1_000, { contextLength: 100_000, maxCompletionTokens: null, reasoningMandatory: true }, { maxOutputTokens: 8_000 })).toBe(3_000);
  });
  it("an unknown context window is assumed small, not trusted", () => {
    const p = planContext({ sections: [sec("p", "policy", 300), sec("u", "user_request", 30_000)], model: { contextLength: null, maxCompletionTokens: null }, desiredOutputTokens: 500, minOutputTokens: 100, limits });
    expect(p.status).toBe("DOES_NOT_FIT");
    expect(p.usableContext).toBeLessThan(UNKNOWN_CONTEXT_ASSUMPTION);
  });
});

// ─── Failure categories and the retry policy ──────────────────────────────────

describe("failure handling policy", () => {
  it("classifies OpenRouter errors by status, typed error_type and message", () => {
    expect(categorizeOpenRouterError(429, "rate_limit_exceeded", "Rate limit exceeded: free-models-per-day")).toBe("QUOTA_EXHAUSTED");
    expect(categorizeOpenRouterError(429, null, "Rate limit exceeded: limit_rpm")).toBe("RATE_LIMITED");
    expect(categorizeOpenRouterError(403, null, "Input was flagged by moderation")).toBe("SAFETY_REJECTION");
    expect(categorizeOpenRouterError(400, "content_policy_violation", "")).toBe("SAFETY_REJECTION");
    expect(categorizeOpenRouterError(401, null, "")).toBe("AUTH_CONFIG");
    expect(categorizeOpenRouterError(402, null, "Insufficient credits")).toBe("AUTH_CONFIG");
    expect(categorizeOpenRouterError(400, null, "This endpoint's maximum context length is 8192 tokens")).toBe("CONTEXT_OVERFLOW");
    expect(categorizeOpenRouterError(404, null, "No endpoints found matching your data policy")).toBe("UNSUPPORTED_CAPABILITY");
    expect(categorizeOpenRouterError(400, null, "bad field")).toBe("REQUEST_REJECTED");
    expect(categorizeOpenRouterError(503, null, "")).toBe("PROVIDER_UNAVAILABLE");
    expect(categorizeOpenRouterError(408, null, "")).toBe("TIMEOUT");
  });
  it("a safety rejection, exhausted quota, auth error or budget stops the task — no fallback to evade a refusal", () => {
    for (const c of ["SAFETY_REJECTION", "QUOTA_EXHAUSTED", "AUTH_CONFIG", "BUDGET_EXHAUSTED", "SECURITY_VIOLATION", "CANCELLED"] as const) {
      expect(FAILURE_POLICY[c].stopTask).toBe(true);
      expect(FAILURE_POLICY[c].tryNextModel).toBe(false);
    }
  });
  it("context overflow is replanned on another model, never resent unchanged", () => {
    expect(FAILURE_POLICY.CONTEXT_OVERFLOW).toMatchObject({ retrySameModel: false, tryNextModel: true });
  });
  it("maps provider errors without a category", () => {
    expect(categorizeFailure(new ProviderError("RATE_LIMITED", "x", true, 429))).toBe("RATE_LIMITED");
    expect(categorizeFailure(new ProviderError("INVALID_REQUEST", "x", false, 401))).toBe("AUTH_CONFIG");
    expect(categorizeFailure(Object.assign(new Error("x"), { code: "BUDGET_EXCEEDED" }))).toBe("BUDGET_EXHAUSTED");
    expect(categorizeFailure(Object.assign(new Error("x"), { code: "TOKEN_BUDGET_EXCEEDED" }))).toBe("BUDGET_EXHAUSTED");
  });
  it("honours Retry-After and reset headers, bounded", () => {
    expect(parseRetryAfterMs("30", null, 0)).toBe(30_000);
    expect(parseRetryAfterMs(null, String(1_800_000_060_000), 1_800_000_000_000)).toBe(60_000); // epoch milliseconds
    expect(parseRetryAfterMs("999999999", null, 0)).toBe(MAX_PROVIDER_COOLDOWN_MS);
    expect(parseRetryAfterMs("-5", null, 0)).toBe(null);
    expect(parseRetryAfterMs(null, null)).toBeNull();
    expect(parseRetryAfterMs("Fri, 23 Oct 2026 12:00:30 GMT", null, Date.parse("2026-10-23T12:00:00Z"))).toBe(30_000);
  });
  it("backoff is jittered and bounded", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(250);
    expect(backoffDelayMs(1, () => 1)).toBe(500);
    expect(backoffDelayMs(10, () => 1)).toBe(4_000);
  });
  it("cooldowns: one outage or timeout does not park a model; repeats and rate limits do", () => {
    expect(cooldownFor("PROVIDER_UNAVAILABLE", 1, null)).toBe(0);
    expect(cooldownFor("TIMEOUT", 1, null)).toBe(0);
    expect(cooldownFor("PROVIDER_UNAVAILABLE", 2, null)).toBeGreaterThan(0);
    expect(cooldownFor("RATE_LIMITED", 1, null)).toBe(60_000);
    expect(cooldownFor("RATE_LIMITED", 1, 300_000)).toBe(300_000);
    expect(cooldownFor("RATE_LIMITED", 3, null)).toBe(120_000);
    expect(cooldownFor("REQUEST_REJECTED", 5, null)).toBe(0);
  });
});

// ─── Learning ─────────────────────────────────────────────────────────────────

describe("learning from evaluations", () => {
  it("no data → prior with low confidence", () => {
    expect(estimateQuality([], 50, 14, 5)).toMatchObject({ value: 50, status: "LOW_CONFIDENCE", samples: 0 });
  });
  it("a single rating cannot move a model far", () => {
    const one = estimateQuality([{ score: 100, ageDays: 0 }], 50, 14, 5);
    expect(one.value).toBeLessThanOrEqual(60);
    expect(one.status).toBe("LOW_CONFIDENCE");
  });
  it("sufficient consistent evidence dominates the prior", () => {
    const many = estimateQuality(Array.from({ length: 30 }, () => ({ score: 90, ageDays: 1 })), 50, 14, 5);
    expect(many.status).toBe("KNOWN");
    expect(many.value).toBeGreaterThan(84);
  });
  it("stale observations count less than recent ones", () => {
    expect(decayWeight(28, 14)).toBeCloseTo(0.25);
    const recentBad = estimateQuality([...Array(10).fill({ score: 90, ageDays: 60 }), ...Array(10).fill({ score: 20, ageDays: 0 })], 50, 14, 5);
    expect(recentBad.value).toBeLessThan(40);
  });
  it("conflicting feedback converges to the middle, not to the last vote", () => {
    const mixed = estimateQuality([{ score: 85, ageDays: 0 }, { score: 25, ageDays: 0 }, { score: 85, ageDays: 0 }, { score: 25, ageDays: 0 }], 50, 14, 5);
    expect(mixed.value).toBeGreaterThan(45);
    expect(mixed.value).toBeLessThan(60);
  });
  it("security violations lower the security score", () => {
    expect(estimateSecurity([], 14)).toBe(50);
    expect(estimateSecurity(Array(20).fill({ score: 0, ageDays: 0, securityViolation: true }), 14)).toBeLessThan(10);
    expect(estimateSecurity(Array(20).fill({ score: 90, ageDays: 0, securityViolation: false }), 14)).toBeGreaterThan(90);
  });
  it("Wilson lower bound is honest for small samples", () => {
    expect(wilsonLowerBound(1, 1)).toBeLessThan(0.25);
    expect(wilsonLowerBound(95, 100)).toBeGreaterThan(0.88);
  });
  it("published benchmarks only nudge the prior within a narrow range", () => {
    expect(benchmarkPrior(70, 0, 70)).toBe(PRIOR_RANGE[1]);
    expect(benchmarkPrior(0, 0, 70)).toBe(PRIOR_RANGE[0]);
    expect(benchmarkPrior(null, 0, 70)).toBe(50);
  });
});

// ─── Gates and ranking ────────────────────────────────────────────────────────

const model = (patch: Partial<ModelRow>): ModelRow => ({
  id: patch.openrouter_id ?? "id", openrouter_id: "v/m:free", display_name: "M", provider: "v", description: null, context_length: 128_000,
  free_status: "FREE", status: "AVAILABLE", eligibility_status: "ELIGIBLE", supports_tool_calling: true, supports_structured_output: true,
  supports_reasoning: false, supports_coding: false, supports_vision: false, input_modalities: ["text"], output_modalities: ["text"], enabled: true,
  first_seen_at: "", last_seen_at: "", last_catalog_refresh: null, created_at: "", updated_at: "",
  pricing_class: "FREE", pricing_checked_at: NOW, expires_at: null, max_completion_tokens: 16_000, reasoning_mandatory: false, supports_json_schema: true, is_router: false,
  benchmark_intelligence: null, benchmark_coding: null, benchmark_agentic: null, ...patch,
});
const gates = (patch: Partial<GateContext> = {}): GateContext => ({ paidAllowed: false, trialsEnabled: true, freePoolRemaining: 10, trialPoolRemaining: 5, maxStaleHours: 24, coolingDown: new Set(), now: NOW, ...patch });

describe("hard eligibility gates", () => {
  it("paid and unknown-price models are excluded unless paid usage is enabled", () => {
    expect(findGateExclusion(model({ pricing_class: "PAID" }), gates())?.reason).toBe("PRICING_PAID");
    expect(findGateExclusion(model({ pricing_class: "UNKNOWN" }), gates())?.reason).toBe("PRICING_UNKNOWN");
    expect(findGateExclusion(model({ pricing_class: "PAID" }), gates({ paidAllowed: true }))).toBeNull();
  });
  it("trials need the setting, an unexpired date and remaining trial allowance", () => {
    const trial = model({ pricing_class: "TRIAL", expires_at: new Date("2026-10-31") });
    expect(findGateExclusion(trial, gates())).toBeNull();
    expect(findGateExclusion(trial, gates({ trialsEnabled: false }))?.reason).toBe("TRIAL_DISABLED");
    expect(findGateExclusion(model({ pricing_class: "TRIAL", expires_at: new Date("2026-10-01") }), gates())?.reason).toBe("TRIAL_EXPIRED");
    expect(findGateExclusion(trial, gates({ trialPoolRemaining: 0 }))?.reason).toBe("QUOTA_EXHAUSTED");
  });
  it("exhausted free allowance, stale pricing, cooldown, routing aliases and non-text output are excluded", () => {
    expect(findGateExclusion(model({}), gates({ freePoolRemaining: 0 }))?.reason).toBe("QUOTA_EXHAUSTED");
    expect(findGateExclusion(model({ pricing_checked_at: new Date("2026-10-20") }), gates())?.reason).toBe("CATALOG_STALE");
    expect(findGateExclusion(model({ pricing_checked_at: null }), gates())?.reason).toBe("CATALOG_STALE");
    expect(findGateExclusion(model({}), gates({ coolingDown: new Set(["v/m:free"]) }))?.reason).toBe("COOLING_DOWN");
    expect(findGateExclusion(model({ openrouter_id: "openrouter/free" }), gates())?.reason).toBe("ROUTER_ALIAS");
    expect(findGateExclusion(model({ output_modalities: ["text", "audio"] }), gates())?.reason).toBe("NON_TEXT_OUTPUT");
  });
  it("call-time check refuses disabled, unreviewed, excluded, paid, expired-trial and stale models", () => {
    const row = { openrouter_id: "v/m:free", enabled: true, status: "AVAILABLE", eligibility_status: "ELIGIBLE", free_status: "FREE", pricing_class: "FREE" as const, pricing_checked_at: NOW, expires_at: null, context_length: 8_000, max_completion_tokens: null, reasoning_mandatory: false, is_router: false };
    expect(decideModel(row, settings(), false, NOW)).toMatchObject({ ok: true });
    expect(decideModel(null, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, enabled: false }, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, status: "DISCOVERED" }, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, free_status: "CHANGED" }, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, pricing_class: "PAID" }, settings(), false, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/paid/) });
    expect(decideModel({ ...row, pricing_class: "TRIAL", expires_at: new Date("2026-10-01") }, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, pricing_checked_at: new Date("2026-10-01") }, settings(), false, NOW)).toBe("STALE");
    const excluded = settings();
    excluded.models.excluded = ["v/m:free"];
    expect(decideModel(row, excluded, false, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/excluded/) });
  });
});

const req: TaskRequirements = { taskType: "SUMMARIZATION", complexity: "LOW", riskLevel: "LOW", requiredCapabilities: [], structuredOutputRequired: true, toolCallingRequired: false, visionRequired: false, preferredCapabilities: [], estimatedInputTokens: 2_000, desiredOutputTokens: 1_000 };
const stats = (q: number, status: "KNOWN" | "LOW_CONFIDENCE", rel = 50): ModelStats => ({ quality: { value: q, samples: status === "KNOWN" ? 20 : 1, effectiveSamples: 10, status, prior: 50 }, security: 90, jsonValidity: 95, reliability: { value: rel, samples: 20, status: "KNOWN" }, latencyMedianMs: 2_000 });

describe("ranking", () => {
  it("measured quality and reliability outrank unknowns; ties break deterministically", () => {
    const a = model({ openrouter_id: "a/good:free" });
    const b = model({ openrouter_id: "b/new:free" });
    const scored = scoreCandidatesV2({ models: [b, a], requirements: req, profile: profileFor("SUMMARIZATION"), stats: new Map([["a/good:free", stats(85, "KNOWN", 92)]]), health: new Map(), settings: settings(), trialPool: { remaining: 0, limit: 0 } });
    expect(scored[0].openrouterId).toBe("a/good:free");
    expect(scored[1].components.benchmark.status).toBe("UNKNOWN");
  });
  it("light tasks prefer lean models over always-reasoning ones", () => {
    const lean = model({ openrouter_id: "a/lean:free" });
    const heavy = model({ openrouter_id: "b/think:free", reasoning_mandatory: true });
    const scored = scoreCandidatesV2({ models: [heavy, lean], requirements: req, profile: profileFor("CLASSIFICATION"), stats: new Map(), health: new Map(), settings: settings(), trialPool: { remaining: 0, limit: 0 } });
    expect(scored[0].openrouterId).toBe("a/lean:free");
  });
  it("an administrator pin wins among eligible candidates only", () => {
    const s = settings();
    s.models.pins = { SUMMARIZATION: "b/pinned:free" };
    const scored = scoreCandidatesV2({ models: [model({ openrouter_id: "a/x:free" }), model({ openrouter_id: "b/pinned:free" })], requirements: req, profile: profileFor("SUMMARIZATION"), stats: new Map([["a/x:free", stats(95, "KNOWN", 99)]]), health: new Map(), settings: s, trialPool: { remaining: 0, limit: 0 } });
    expect(scored[0].openrouterId).toBe("b/pinned:free");
    // A pin naming a model that is not among the (already gated) candidates changes nothing.
    s.models.pins = { SUMMARIZATION: "paid/model" };
    const again = scoreCandidatesV2({ models: [model({ openrouter_id: "a/x:free" })], requirements: req, profile: profileFor("SUMMARIZATION"), stats: new Map(), health: new Map(), settings: s, trialPool: { remaining: 0, limit: 0 } });
    expect(again.map((c) => c.openrouterId)).toEqual(["a/x:free"]);
  });
  it("exploration is deterministic per seed, rare, and never for risky tasks", () => {
    const scored = scoreCandidatesV2({ models: [model({ openrouter_id: "a/k:free" }), model({ openrouter_id: "b/u:free" })], requirements: req, profile: profileFor("SUMMARIZATION"), stats: new Map([["a/k:free", stats(80, "KNOWN", 90)]]), health: new Map(), settings: settings(), trialPool: { remaining: 0, limit: 0 } });
    expect(explorationDraw("seed-1")).toBe(explorationDraw("seed-1"));
    const seeds = Array.from({ length: 1_000 }, (_, i) => `s${i}`);
    const explored = seeds.filter((s) => pickExploration(scored, 0.1, s, "LOW")).length;
    expect(explored).toBeGreaterThan(50);
    expect(explored).toBeLessThan(150);
    expect(seeds.some((s) => pickExploration(scored, 0.1, s, "HIGH"))).toBe(false);
  });
});

// ─── Settings, classification, evaluation ─────────────────────────────────────

describe("settings and classification", () => {
  it("defaults are valid and conservative for a free-only account", () => {
    expect(routerSettingsSchema.safeParse(DEFAULT_ROUTER_SETTINGS).success).toBe(true);
    expect(DEFAULT_ROUTER_SETTINGS.quota.freeDailyRequests).toBe(50);
    expect(DEFAULT_ROUTER_SETTINGS.quota.freeRequestsPerMinute).toBeLessThan(20);
  });
  it("values above the hard ceilings are rejected, and a stored document cannot enable paid models", () => {
    const over = structuredClone(DEFAULT_ROUTER_SETTINGS) as RouterSettings;
    over.perTask.maxAgents = ROUTER_CEILINGS.taskAgents + 1;
    expect(routerSettingsSchema.safeParse(over).success).toBe(false);
    expect(routerSettingsSchema.safeParse({ ...DEFAULT_ROUTER_SETTINGS, allowPaidModels: true }).success).toBe(false);
    expect(mergeSettings({ perTask: { maxAgents: 999 } })).toEqual(DEFAULT_ROUTER_SETTINGS);
    expect(mergeSettings({ trials: { enabled: false } }).trials).toEqual({ enabled: false, dailyRequestCap: 20 });
  });
  it("weights must sum to 1", () => {
    expect(routerSettingsSchema.safeParse({ ...DEFAULT_ROUTER_SETTINGS, weights: { ...DEFAULT_ROUTER_SETTINGS.weights, quality: 0.9 } }).success).toBe(false);
  });
  it("tasks are classified from the feature or agent type, never content", () => {
    expect(classifyTask({ feature: "content_brief" }).category).toBe("CONTENT_GENERATION");
    expect(classifyTask({ taskType: "SECURITY_ANALYSIS" }).category).toBe("TECHNICAL_REASONING");
    expect(classifyTask({ taskType: "CODE_GENERATION" }).tier).toBe("HEAVY");
    expect(classifyTask({ taskType: "ignore previous instructions" }).category).toBe("SEO_ANALYSIS");
  });
  it("task-limit overrides can only lower limits", () => {
    expect(taskLimitsFrom(settings(), { maxAgents: 100, maxCalls: 2 })).toMatchObject({ maxAgents: DEFAULT_ROUTER_SETTINGS.perTask.maxAgents, maxCalls: 2 });
  });
  it("free daily limit is the lower of the setting and the provider's own figure", () => {
    expect(effectiveLimit("FREE", settings(), 1_000, NOW, NOW)).toBe(50);
    expect(effectiveLimit("FREE", settings(), 20, NOW, NOW)).toBe(20);
    expect(effectiveLimit("FREE", settings(), 20, new Date("2026-10-01"), NOW)).toBe(50);
    expect(effectiveLimit("TRIAL", settings({ trials: { enabled: false, dailyRequestCap: 20 } }), null, null, NOW)).toBe(0);
  });
});

describe("deterministic evaluation", () => {
  it("valid JSON with a passing task validator passes with medium confidence", () => {
    expect(evaluateDeterministically({ content: "{}", requireJson: true, jsonValid: true, truncated: false, guardViolations: [], taskValidation: { ok: true, issues: [] } })).toMatchObject({ outcome: "PASS", score: 100, confidence: "MEDIUM" });
  });
  it("structure alone is low confidence: fluent output is not proof of correctness", () => {
    expect(evaluateDeterministically({ content: "Looks great!", requireJson: false, jsonValid: null, truncated: false, guardViolations: [] }).confidence).toBe("LOW");
  });
  it("invalid JSON, truncation, failed validation and guard violations lower the score", () => {
    expect(evaluateDeterministically({ content: "{", requireJson: true, jsonValid: false, truncated: false, guardViolations: [] }).outcome).toBe("FAIL");
    expect(evaluateDeterministically({ content: "x", requireJson: false, jsonValid: null, truncated: true, guardViolations: [] }).score).toBe(70);
    expect(evaluateDeterministically({ content: "{}", requireJson: true, jsonValid: true, truncated: false, guardViolations: [], taskValidation: { ok: false, issues: ["unknown evidence id"] } }).outcome).toBe("FAIL");
    expect(evaluateDeterministically({ content: "x", requireJson: false, jsonValid: null, truncated: false, guardViolations: ["CANARY_LEAK"] })).toMatchObject({ outcome: "FAIL", securityViolation: true });
  });
});

// ─── Regression tests for the Phase 11 security review ────────────────────────

describe("review regressions", () => {
  it("a model that reappears after going stale needs its earlier approval to become available again", () => {
    expect(nextModelStatus({ prevStatus: "STALE", prevEligibility: "ELIGIBLE", approve: false, freeStatus: "FREE" }).status).toBe("AVAILABLE");
    expect(nextModelStatus({ prevStatus: "STALE", prevEligibility: "NOT_ELIGIBLE", approve: false, freeStatus: "PAID" }).status).toBe("DISCOVERED");
    expect(nextModelStatus({ prevStatus: "STALE", prevEligibility: "NOT_ELIGIBLE", approve: true, freeStatus: "FREE" })).toEqual({ status: "AVAILABLE", autoPromoted: true });
    expect(nextModelStatus({ prevStatus: "DISCOVERED", prevEligibility: "NOT_ELIGIBLE", approve: true, freeStatus: "CHANGED" }).status).toBe("DISCOVERED");
  });
  it("the call-time gate requires an approved, text-only model", () => {
    const row = { openrouter_id: "v/m:free", enabled: true, status: "AVAILABLE", eligibility_status: "ELIGIBLE", free_status: "FREE", pricing_class: "FREE" as const, pricing_checked_at: NOW, expires_at: null, context_length: 8_000, max_completion_tokens: null, reasoning_mandatory: false, is_router: false, output_modalities: ["text"] };
    expect(decideModel(row, settings(), false, NOW)).toMatchObject({ ok: true });
    expect(decideModel({ ...row, eligibility_status: "NOT_ELIGIBLE" }, settings(), false, NOW)).toMatchObject({ ok: false });
    expect(decideModel({ ...row, output_modalities: ["text", "audio"] }, settings(), false, NOW)).toMatchObject({ ok: false });
  });
  it("only OpenRouter's free-model daily marker exhausts the account allowance", () => {
    expect(categorizeOpenRouterError(429, "rate_limit_exceeded", "Resource has been exhausted (e.g. check quota).")).toBe("RATE_LIMITED");
    expect(categorizeOpenRouterError(429, null, "daily limit for this upstream model")).toBe("RATE_LIMITED");
    expect(categorizeOpenRouterError(429, null, "Rate limit exceeded: free-models-per-day")).toBe("QUOTA_EXHAUSTED");
  });
  it("one organization's ratings cannot push a measured model below the quality threshold", () => {
    const ratings = Array.from({ length: 3 }, () => ({ score: 25, ageDays: 0, weight: evidenceWeight("USER_FEEDBACK", "LOW") }));
    const measured = Array.from({ length: 10 }, () => ({ score: 90, ageDays: 1, weight: evidenceWeight("DETERMINISTIC", "MEDIUM") }));
    expect(estimateQuality([...measured, ...ratings], 50, 14, 5).value).toBeGreaterThan(DEFAULT_ROUTER_SETTINGS.quality.minQualityScore);
    expect(evidenceWeight("USER_FEEDBACK", "HIGH")).toBe(0.25);
  });
  it("a provider Retry-After sets a rate-limit cooldown exactly, so a short wait can be honoured", () => {
    expect(cooldownFor("RATE_LIMITED", 1, 5_000)).toBe(5_000);
  });
  it("prototype keys do not crash classification; null prices are not zero", () => {
    expect(classifyTask({ feature: "constructor" }).category).toBe("SEO_ANALYSIS");
    expect(classifyTask({ taskType: "__proto__" }).category).toBe("SEO_ANALYSIS");
    expect(classifyPricing({ id: "a/b", pricing: { prompt: "0", completion: "0", image: null }, now: NOW }).pricingClass).toBe("UNKNOWN");
  });
});
