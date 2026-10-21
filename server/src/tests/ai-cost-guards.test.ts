import { beforeEach, describe, expect, it, vi } from "vitest";

const { cfg, queryMock } = vi.hoisted(() => ({
  cfg: { OX_ALPHA_MODEL: "primary", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 1, OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096, OPENROUTER_API_KEY: "k", AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: 5, AI_ALLOW_PAID_MODELS: false } as Record<string, unknown>,
  queryMock: vi.fn(),
}));
vi.mock("../config.js", () => ({ config: cfg }));
vi.mock("../db/client.js", () => ({
  query: queryMock,
  withTransaction: async (fn: (tx: unknown) => unknown) => fn({ query: queryMock }),
}));
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

  it("allows paid models only when AI_ALLOW_PAID_MODELS is explicitly true", async () => {
    cfg.AI_ALLOW_PAID_MODELS = true;
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
