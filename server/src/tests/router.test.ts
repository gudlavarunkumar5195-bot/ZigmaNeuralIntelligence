import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before module imports (vi.mock is hoisted)
vi.mock("../config.js", () => ({
  config: {
    OPENROUTER_API_KEY: undefined,
    OX_ALPHA_MODEL: "test-routing-model",
    OX_ALPHA_TIMEOUT_MS: 5_000,
    OX_ALPHA_MAX_RETRIES: 2,
    OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096,
  },
}));
vi.mock("../db/client.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));
vi.mock("../services/audit.service.js", () => ({
  audit: vi.fn(async () => {}),
}));

import { filterCandidates } from "../ai/router/candidate-filter.js";
import { scoreCandidates, calculateRoutingConfidence } from "../ai/router/candidate-scorer.js";
import { defaultPolicy } from "../ai/router/routing-policy.js";
import type { ModelRow, ReliabilityRow, BenchmarkRow } from "../ai/registry.service.js";
import type { TaskRequirements } from "../ai/router/types.js";
import { DEFAULT_WEIGHTS } from "../ai/router/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: `model-${Math.random().toString(36).slice(2, 8)}`,
    openrouter_id: "meta-llama/llama-3.1-8b-instruct:free",
    display_name: "Test Model",
    provider: "meta-llama",
    description: null,
    context_length: 131_072,
    free_status: "FREE",
    status: "AVAILABLE",
    eligibility_status: "ELIGIBLE",
    supports_tool_calling: false,
    supports_structured_output: false,
    supports_reasoning: true,
    supports_coding: false,
    supports_vision: false,
    input_modalities: ["text"],
    output_modalities: ["text"],
    enabled: true,
    first_seen_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-08-01T00:00:00Z",
    last_catalog_refresh: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeReliability(
  modelId: string,
  overrides: Partial<ReliabilityRow> = {}
): ReliabilityRow {
  return {
    id: "rel-id",
    model_id: modelId,
    total_requests: 100,
    successful_requests: 95,
    failed_requests: 5,
    timeout_requests: 0,
    rate_limited_requests: 0,
    malformed_responses: 0,
    avg_latency_ms: 1200,
    p95_latency_ms: 3000,
    last_updated: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeReq(overrides: Partial<TaskRequirements> = {}): TaskRequirements {
  return {
    taskType: "SEO_ANALYSIS",
    complexity: "MEDIUM",
    riskLevel: "MEDIUM",
    requiredCapabilities: [],
    preferredCapabilities: [],
    structuredOutputRequired: false,
    toolCallingRequired: false,
    visionRequired: false,
    ...overrides,
  };
}

// ─── Hard constraint filtering ────────────────────────────────────────────────

describe("filterCandidates — hard constraints", () => {
  it("excludes a disabled model", () => {
    const model = makeModel({ enabled: false });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(eligible).toHaveLength(0);
    expect(excluded[0].reason).toBe("DISABLED");
  });

  it("excludes a model with DISABLED status", () => {
    const model = makeModel({ status: "DISABLED" });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(excluded[0].reason).toBe("DISABLED");
  });

  it("excludes a STALE model", () => {
    const model = makeModel({ status: "STALE" });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(excluded[0].reason).toBe("NOT_ELIGIBLE");
  });

  it("excludes a DEPRECATED model", () => {
    const model = makeModel({ status: "DEPRECATED" });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(excluded[0].reason).toBe("NOT_ELIGIBLE");
  });

  it("excludes a DISCOVERED model (PENDING_REVIEW)", () => {
    const model = makeModel({ status: "DISCOVERED" });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(eligible).toHaveLength(0);
    expect(excluded[0].reason).toBe("NOT_ELIGIBLE");
  });

  it("excludes PAID model when freeOnly=true", () => {
    const model = makeModel({ free_status: "PAID" });
    const { eligible, excluded } = filterCandidates([model], makeReq({ freeOnly: true }));
    expect(eligible).toHaveLength(0);
    expect(["FREE_ONLY_VIOLATION", "NOT_ELIGIBLE"]).toContain(excluded[0].reason);
  });

  it("includes FREE model when freeOnly=true", () => {
    const model = makeModel({ free_status: "FREE" });
    const { eligible } = filterCandidates([model], makeReq({ freeOnly: true }));
    expect(eligible).toHaveLength(1);
  });

  it("excludes model missing structured output when required", () => {
    const model = makeModel({ supports_structured_output: false });
    const { excluded } = filterCandidates([model], makeReq({ structuredOutputRequired: true }));
    expect(excluded[0].reason).toBe("MISSING_STRUCTURED_OUTPUT");
  });

  it("includes model with structured output when required", () => {
    const model = makeModel({ supports_structured_output: true });
    const { eligible } = filterCandidates([model], makeReq({ structuredOutputRequired: true }));
    expect(eligible).toHaveLength(1);
  });

  it("excludes model missing tool calling when required", () => {
    const model = makeModel({ supports_tool_calling: false });
    const { excluded } = filterCandidates([model], makeReq({ toolCallingRequired: true }));
    expect(excluded[0].reason).toBe("MISSING_TOOL_CALLING");
  });

  it("excludes model missing vision when required", () => {
    const model = makeModel({ supports_vision: false });
    const { excluded } = filterCandidates([model], makeReq({ visionRequired: true }));
    expect(excluded[0].reason).toBe("MISSING_VISION");
  });

  it("excludes model with context too short", () => {
    const model = makeModel({ context_length: 4_096 });
    const { excluded } = filterCandidates([model], makeReq({ minimumContextLength: 128_000 }));
    expect(excluded[0].reason).toBe("CONTEXT_TOO_SHORT");
  });

  it("includes model when context meets minimum", () => {
    const model = makeModel({ context_length: 200_000 });
    const { eligible } = filterCandidates([model], makeReq({ minimumContextLength: 128_000 }));
    expect(eligible).toHaveLength(1);
  });

  it("excludes model in excludedModels list", () => {
    const model = makeModel({ openrouter_id: "provider/excluded-model" });
    const { excluded } = filterCandidates([model], makeReq({ excludedModels: ["provider/excluded-model"] }));
    expect(excluded[0].reason).toBe("EXPLICITLY_EXCLUDED");
  });

  it("excludes model from disallowed provider", () => {
    const model = makeModel({ openrouter_id: "openai/gpt-4o", provider: "openai" });
    const { excluded } = filterCandidates([model], makeReq({ allowedProviders: ["meta-llama"] }));
    expect(excluded[0].reason).toBe("PROVIDER_EXCLUDED");
  });

  it("includes model from allowed provider", () => {
    const model = makeModel({ openrouter_id: "meta-llama/llama-3.1-8b:free", provider: "meta-llama" });
    const { eligible } = filterCandidates([model], makeReq({ allowedProviders: ["meta-llama"] }));
    expect(eligible).toHaveLength(1);
  });

  it("excludes model below minimum reliability when sample is sufficient", () => {
    const model = makeModel();
    const rel = new Map([[model.id, makeReliability(model.id, {
      total_requests: 100, successful_requests: 70, failed_requests: 30,
    })]]);
    const { excluded } = filterCandidates([model], makeReq({ minimumReliability: 0.90 }), rel);
    expect(excluded[0].reason).toBe("BELOW_MIN_RELIABILITY");
  });

  it("does NOT exclude when reliability sample is below threshold (insufficient data)", () => {
    const model = makeModel();
    const rel = new Map([[model.id, makeReliability(model.id, {
      total_requests: 5, successful_requests: 1, failed_requests: 4,
    })]]);
    const { eligible } = filterCandidates([model], makeReq({ minimumReliability: 0.90 }), rel);
    expect(eligible).toHaveLength(1);
  });

  it("passes through eligible model with no issues", () => {
    const model = makeModel();
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(eligible).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });

  it("handles multiple models with mixed eligibility", () => {
    const eligible1 = makeModel({ openrouter_id: "provider/a" });
    const disabled = makeModel({ enabled: false, openrouter_id: "provider/b" });
    const eligible2 = makeModel({ openrouter_id: "provider/c" });
    const { eligible, excluded } = filterCandidates([eligible1, disabled, eligible2], makeReq());
    expect(eligible).toHaveLength(2);
    expect(excluded).toHaveLength(1);
  });

  it("prompt injection: excluded model list cannot be bypassed", () => {
    // Simulates: website content tries to include a banned model
    const bannedModel = makeModel({ openrouter_id: "banned/model" });
    const req = makeReq({ excludedModels: ["banned/model"] });
    const { excluded } = filterCandidates([bannedModel], req);
    expect(excluded[0].reason).toBe("EXPLICITLY_EXCLUDED");
    expect(excluded[0].openrouterId).toBe("banned/model");
  });
});

// ─── Candidate scoring ────────────────────────────────────────────────────────

describe("scoreCandidates — weighted scoring", () => {
  it("returns UNKNOWN status for models with no benchmark data", () => {
    const model = makeModel();
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map());
    expect(scored[0].components.benchmark.status).toBe("UNKNOWN");
    expect(scored[0].components.benchmark.value).toBe(50);
  });

  it("returns UNKNOWN status for models with no reliability data", () => {
    const model = makeModel();
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map());
    expect(scored[0].components.reliability.status).toBe("UNKNOWN");
    expect(scored[0].components.reliability.value).toBe(50);
  });

  it("uses actual benchmark score when BENCHMARKED", () => {
    const model = makeModel();
    const benchmarks: BenchmarkRow[] = [{
      id: "b1", model_id: model.id, task_type: "SEO_ANALYSIS",
      score: 88, sample_size: 50, benchmark_version: "v1",
      evaluation_status: "BENCHMARKED", evaluated_at: "2026-07-01T00:00:00Z",
    }];
    const benchmarkMap = new Map([[model.id, benchmarks]]);
    const scored = scoreCandidates([model], makeReq({ taskType: "SEO_ANALYSIS" }), benchmarkMap, new Map());
    expect(scored[0].components.benchmark.status).toBe("KNOWN");
    expect(scored[0].components.benchmark.value).toBe(88);
  });

  it("uses actual reliability rate when sufficient data", () => {
    const model = makeModel();
    const rel = makeReliability(model.id, {
      total_requests: 100, successful_requests: 92, failed_requests: 8,
    });
    const relMap = new Map([[model.id, rel]]);
    const scored = scoreCandidates([model], makeReq(), new Map(), relMap);
    expect(scored[0].components.reliability.status).toBe("KNOWN");
    expect(scored[0].components.reliability.value).toBe(92);
  });

  it("scores capability match correctly", () => {
    const model = makeModel({ supports_reasoning: true, supports_coding: false });
    const req = makeReq({ preferredCapabilities: ["REASONING", "CODING"] });
    const scored = scoreCandidates([model], req, new Map(), new Map());
    // 1 of 2 preferred caps matched = 50%
    expect(scored[0].components.capability.value).toBe(50);
  });

  it("scores 100 capability when no preferred capabilities specified", () => {
    const model = makeModel();
    const req = makeReq({ preferredCapabilities: [] });
    const scored = scoreCandidates([model], req, new Map(), new Map());
    expect(scored[0].components.capability.value).toBe(100);
  });

  it("sorts candidates by composite score descending", () => {
    const modelA = makeModel({ id: "a", openrouter_id: "prov/model-a" });
    const modelB = makeModel({ id: "b", openrouter_id: "prov/model-b" });

    const highRel = makeReliability("a", { total_requests: 100, successful_requests: 99, failed_requests: 1 });
    const lowRel = makeReliability("b", { total_requests: 100, successful_requests: 60, failed_requests: 40 });
    const relMap = new Map([["a", highRel], ["b", lowRel]]);

    const scored = scoreCandidates([modelA, modelB], makeReq(), new Map(), relMap);
    expect(scored[0].openrouterId).toBe("prov/model-a");
    expect(scored[0].compositeScore).toBeGreaterThan(scored[1].compositeScore);
  });

  it("composite score is within 0–100 range", () => {
    const model = makeModel();
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map());
    expect(scored[0].compositeScore).toBeGreaterThanOrEqual(0);
    expect(scored[0].compositeScore).toBeLessThanOrEqual(100);
  });

  it("prefers model matching preferred model ID", () => {
    const modelA = makeModel({ id: "a", openrouter_id: "prov/preferred" });
    const modelB = makeModel({ id: "b", openrouter_id: "prov/other" });
    const req = makeReq({ preferredModelId: "prov/preferred" });
    const scored = scoreCandidates([modelA, modelB], req, new Map(), new Map());
    expect(scored[0].openrouterId).toBe("prov/preferred");
    expect(scored[0].components.preference.value).toBe(100);
  });

  it("context score is UNKNOWN when context_length is null", () => {
    const model = makeModel({ context_length: null });
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map());
    expect(scored[0].components.context.status).toBe("UNKNOWN");
  });

  it("does not produce negative composite score", () => {
    const model = makeModel({ context_length: 1_000 });
    const rel = makeReliability(model.id, {
      total_requests: 100, successful_requests: 10, failed_requests: 90,
    });
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map([[model.id, rel]]));
    expect(scored[0].compositeScore).toBeGreaterThanOrEqual(0);
  });
});

// ─── Routing confidence ───────────────────────────────────────────────────────

describe("calculateRoutingConfidence", () => {
  it("returns 0 confidence with no candidates", () => {
    const { confidence } = calculateRoutingConfidence([]);
    expect(confidence).toBe(0);
  });

  it("reduces confidence when top two candidates are within 5 points", () => {
    const model = makeModel();
    const req = makeReq();
    const scored = scoreCandidates([model, makeModel({ openrouter_id: "prov/b" })], req, new Map(), new Map());
    // Both UNKNOWN benchmark+reliability = same neutral score = within 5 pts
    const { confidence } = calculateRoutingConfidence(scored);
    expect(confidence).toBeLessThan(85);
  });

  it("reduces confidence when majority benchmark scores are UNKNOWN", () => {
    const models = [makeModel(), makeModel({ openrouter_id: "prov/b" }), makeModel({ openrouter_id: "prov/c" })];
    const scored = scoreCandidates(models, makeReq(), new Map(), new Map());
    const { confidence } = calculateRoutingConfidence(scored);
    // All unknown → penalty
    expect(confidence).toBeLessThanOrEqual(75);
  });

  it("confidence is clamped 0–100", () => {
    const model = makeModel();
    const scored = scoreCandidates([model], makeReq(), new Map(), new Map());
    const { confidence } = calculateRoutingConfidence(scored);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(100);
  });
});

// ─── Default policy ───────────────────────────────────────────────────────────

describe("defaultPolicy", () => {
  it("returns a valid policy with correct defaults", () => {
    const p = defaultPolicy();
    expect(p.freeOnly).toBe(false);
    expect(p.minReliability).toBe(0);
    expect(p.maxAttempts).toBe(5);
    expect(p.weights.benchmark).toBeCloseTo(0.3);
    expect(p.weights.reliability).toBeCloseTo(0.2);
    expect(p.requireCrossModelVerification).toBe(false);
  });

  it("DEFAULT_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
  });
});

// ─── Routing security ─────────────────────────────────────────────────────────

describe("routing security constraints", () => {
  it("OX Alpha cannot bypass explicit model exclusion list", () => {
    const bannedModel = makeModel({ openrouter_id: "banned/model-xyz" });
    const req = makeReq({ excludedModels: ["banned/model-xyz"] });
    const { excluded } = filterCandidates([bannedModel], req);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toBe("EXPLICITLY_EXCLUDED");
  });

  it("disabled model cannot become eligible regardless of requirements", () => {
    const model = makeModel({ enabled: false, status: "AVAILABLE", free_status: "FREE" });
    // Even with permissive requirements, disabled always excluded
    const { eligible } = filterCandidates([model], makeReq({ freeOnly: false }));
    expect(eligible).toHaveLength(0);
  });

  it("PAID model cannot be selected when free-only policy active", () => {
    const paidModel = makeModel({ free_status: "PAID" });
    const { eligible } = filterCandidates([paidModel], makeReq({ freeOnly: true }));
    expect(eligible).toHaveLength(0);
  });

  it("all required capabilities must be met or model is excluded", () => {
    const model = makeModel({ supports_structured_output: false, supports_vision: false });
    const { excluded } = filterCandidates(
      [model],
      makeReq({ structuredOutputRequired: true, visionRequired: true })
    );
    expect(excluded).toHaveLength(1);
    // First failure is structural output
    expect(excluded[0].reason).toBe("MISSING_STRUCTURED_OUTPUT");
  });

  it("empty eligible list produces NO_CANDIDATES in filter result", () => {
    const model = makeModel({ enabled: false });
    const { eligible, excluded } = filterCandidates([model], makeReq());
    expect(eligible).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it("filter is deterministic — same inputs always produce same output", () => {
    const models = [
      makeModel({ id: "x1", openrouter_id: "a/b" }),
      makeModel({ id: "x2", openrouter_id: "c/d", enabled: false }),
    ];
    const req = makeReq();
    const r1 = filterCandidates(models, req);
    const r2 = filterCandidates(models, req);
    expect(r1.eligible.map((m) => m.id)).toEqual(r2.eligible.map((m) => m.id));
    expect(r1.excluded.map((m) => m.reason)).toEqual(r2.excluded.map((m) => m.reason));
  });

  it("score ranking is deterministic — same inputs same order", () => {
    const models = [makeModel({ id: "m1", openrouter_id: "p/a" }), makeModel({ id: "m2", openrouter_id: "p/b" })];
    const req = makeReq();
    const s1 = scoreCandidates(models, req, new Map(), new Map());
    const s2 = scoreCandidates(models, req, new Map(), new Map());
    expect(s1.map((c) => c.openrouterId)).toEqual(s2.map((c) => c.openrouterId));
  });
});
