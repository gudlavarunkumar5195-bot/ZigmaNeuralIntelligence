import { beforeEach, describe, expect, it, vi } from "vitest";

const { cfg, queryMock } = vi.hoisted(() => ({
  cfg: { OX_ALPHA_MODEL: "primary", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 1, OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096, OPENROUTER_API_KEY: "k", AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: 5, AI_ALLOW_PAID_MODELS: false } as Record<string, unknown>,
  queryMock: vi.fn(),
}));
vi.mock("../config.js", () => ({ config: cfg }));
// Requests without an explicit model are routed (Phase 11); the router itself is covered by router tests.
vi.mock("../ai/router/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/router/index.js")>()),
  resolveRouting: async () => ({ id: "decision-1", status: "RESOLVED", selectedModel: { openrouterId: "primary" }, fallbackModels: [], excludedCandidates: [], decisionReason: "test routing" }),
}));
vi.mock("../db/client.js", async () => {
  // Phase 11 governance tables get neutral answers; the model gate follows this file's "FROM models" answer.
  const { governanceDb } = await import("./helpers/ai-governance-db.js");
  const q = governanceDb((sql: string, params?: unknown[]) => (queryMock as unknown as (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>)(sql, params));
  return { query: q, withTransaction: async (fn: (tx: unknown) => unknown) => fn({ query: q }) };
});
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => {}) }));

import { OxAlphaExecutor } from "../ai/ox-alpha.js";
import { defaultPolicy } from "../ai/router/routing-policy.js";
import type { ModelProvider, ModelResponse } from "../ai/provider.js";

const ok = (model: string): ModelResponse => ({ executionId: "x", model, provider: "mock", content: "hi", finishReason: "stop", usage: null, durationMs: 1 });
function provider() {
  const calls: string[] = [];
  const p: ModelProvider = { name: "mock", isAvailable: async () => true, execute: vi.fn(async (r) => { calls.push(r.model); return ok(r.model); }) };
  return { p, calls };
}
const FREE = new Set(["free-a", "free-b"]);
const defaultPolicyRow = () => {
  const d = defaultPolicy();
  return {
    id: "p", org_id: "o", version: 1, free_only: d.freeOnly, min_reliability: 0, min_quality: 0, max_attempts: d.maxAttempts,
    require_cross_model_verification: false, allowed_providers: null, excluded_models: null,
    weight_benchmark: 0.3, weight_reliability: 0.2, weight_capability: 0.15, weight_historical: 0.15, weight_structured_out: 0.05,
    weight_latency: 0.05, weight_context: 0.05, weight_preference: 0.05, description: null, is_active: true, created_at: "", updated_at: "",
  };
};

describe("AI cost guards (P0-6)", () => {
  beforeEach(() => {
    cfg.AI_ALLOW_PAID_MODELS = false;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM models")) return { rows: FREE.has(String(params[0])) ? [{ free_status: "FREE" }] : [{ free_status: "PAID" }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO agent_executions")) return { rows: [{ id: "attempt-row" }] };
      return { rows: [] };
    });
  });

  it("refuses provider calls with no organization or scan context (no unbudgeted calls)", async () => {
    const { p, calls } = provider();
    const r = await new OxAlphaExecutor(p).execute({ model: "free-a", messages: [{ role: "user", content: "x" }] });
    expect(calls).toEqual([]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^AI_UNATTRIBUTED/);
  });

  it("skips models that are not registry-verified FREE and uses a free fallback", async () => {
    const { p, calls } = provider();
    const r = await new OxAlphaExecutor(p).execute({ model: "paid-x", fallbackModels: ["unknown-y", "free-b"], messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    expect(calls).toEqual(["free-b"]);
    expect(r.success).toBe(true);
  });

  it("makes no call at all when every candidate is paid or unknown", async () => {
    const { p, calls } = provider();
    const r = await new OxAlphaExecutor(p).execute({ model: "paid-x", messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    expect(calls).toEqual([]);
    expect(r.error).toMatch(/MODEL_NOT_ALLOWED/);
  });

  it("allows paid models only when AI_ALLOW_PAID_MODELS is explicitly true and the org policy is not free-only", async () => {
    cfg.AI_ALLOW_PAID_MODELS = true;
    // The default routing policy is free-only, and it also binds explicitly named models (Phase 11).
    const blocked = provider();
    await new OxAlphaExecutor(blocked.p).execute({ model: "paid-x", messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    expect(blocked.calls).toEqual([]);
    const legacy = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => sql.includes("FROM routing_policies")
      ? { rows: [{ ...defaultPolicyRow(), free_only: false }] }
      : legacy(sql, params));
    const { p, calls } = provider();
    await new OxAlphaExecutor(p).execute({ model: "paid-x", messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    expect(calls).toEqual(["paid-x"]);
  });

  it("checks the budget and records the attempt inside one locked transaction before calling", async () => {
    const { p } = provider();
    await new OxAlphaExecutor(p).execute({ model: "free-a", messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    const lock = sqls.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    const count = sqls.findIndex((q) => q.includes("COUNT(*)"));
    const insert = sqls.findIndex((q) => q.includes("INSERT INTO agent_executions"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(insert);
    expect(queryMock.mock.calls[lock][1]).toEqual(["ai-budget:o"]);
  });

  it("fails closed when the attempt row cannot be written", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM models")) return { rows: [{ free_status: "FREE" }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO agent_executions")) throw new Error("insert failed");
      return { rows: [] };
    });
    const { p, calls } = provider();
    const r = await new OxAlphaExecutor(p).execute({ model: "free-a", messages: [{ role: "user", content: "x" }], orgId: "o", scanId: "s" });
    expect(calls).toEqual([]);
    expect(r.error).toMatch(/BUDGET_CHECK_FAILED/);
  });

  it("the in-memory default routing policy is free-only", () => {
    expect(defaultPolicy().freeOnly).toBe(true);
  });
});
