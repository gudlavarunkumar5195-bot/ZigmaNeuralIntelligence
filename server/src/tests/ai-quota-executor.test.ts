// Phase 11: the executor stops — with no provider call — once the account's
// free allowance is used, and a provider "daily limit" 429 marks the pool
// exhausted so later requests are not wasted.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, opts } = vi.hoisted(() => ({ queryMock: vi.fn(), opts: { freeRequestsUsed: 0, cancelled: false } }));
vi.mock("../config.js", () => ({ config: { OX_ALPHA_MODEL: "free-a", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 2, OX_ALPHA_MAX_OUTPUT_TOKENS: 1_000, AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: 500, AI_ALLOW_PAID_MODELS: false } }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../db/client.js", async () => {
  const { governanceDb } = await import("./helpers/ai-governance-db.js");
  const q = (sql: string, params?: unknown[]) => sql.includes("SELECT cancel_requested") ? Promise.resolve({ rows: [{ cancel_requested: opts.cancelled }] }) : governanceDb((s: string, p?: unknown[]) => queryMock(s, p), { freeRequestsUsed: opts.freeRequestsUsed })(sql, params);
  return { query: q, withTransaction: async (fn: (tx: unknown) => unknown) => fn({ query: q }) };
});

import { OxAlphaExecutor } from "../ai/ox-alpha.js";
import { ProviderError, type ModelProvider } from "../ai/provider.js";

const request = { model: "free-a", fallbackModels: ["free-b"], messages: [{ role: "user" as const, content: "hi" }], orgId: "org", scanId: "scan" };

describe("free allowance and the executor", () => {
  beforeEach(() => {
    opts.freeRequestsUsed = 0;
    opts.cancelled = false;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM models")) return { rows: [{ free_status: "FREE" }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO agent_executions")) return { rows: [{ id: "attempt" }] };
      return { rows: [], rowCount: 0 };
    });
  });

  it("makes no provider call when today's free allowance is already used", async () => {
    opts.freeRequestsUsed = 50;
    const p: ModelProvider = { name: "m", isAvailable: async () => true, execute: vi.fn() };
    const r = await new OxAlphaExecutor(p).execute(request);
    expect(p.execute).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: false, failureCategory: "QUOTA_EXHAUSTED" });
    expect(r.error).toMatch(/QUOTA_EXHAUSTED/);
  });

  it("a provider daily-limit 429 stops the task (no fallback) and marks the pool exhausted", async () => {
    const p: ModelProvider = { name: "m", isAvailable: async () => true, execute: vi.fn(async () => { throw new ProviderError("RATE_LIMITED", "Rate limit exceeded: free-models-per-day", true, 429, "QUOTA_EXHAUSTED", 3_600_000); }) };
    const r = await new OxAlphaExecutor(p).execute(request);
    expect(p.execute).toHaveBeenCalledTimes(1);
    expect(r.failureCategory).toBe("QUOTA_EXHAUSTED");
  });

  it("a cancellation requested through the API stops the task before the next provider call", async () => {
    opts.cancelled = true;
    const p: ModelProvider = { name: "m", isAvailable: async () => true, execute: vi.fn() };
    const r = await new OxAlphaExecutor(p).execute({ ...request, taskRunId: "task-run-1" });
    expect(p.execute).not.toHaveBeenCalled();
    expect(r.failureCategory).toBe("CANCELLED");
  });

  it("NaN attempt limits fall back safely", async () => {
    const p: ModelProvider = { name: "m", isAvailable: async () => true, execute: vi.fn(async () => { throw new ProviderError("PROVIDER_ERROR", "down", true, 503); }) };
    const r = await new OxAlphaExecutor(p).execute({ ...request, maxRetries: Number.NaN, maxTotalAttempts: Number.NaN });
    expect(r.attempts).toBeGreaterThan(0);
    expect(r.attempts).toBeLessThanOrEqual(4);
  });
});
