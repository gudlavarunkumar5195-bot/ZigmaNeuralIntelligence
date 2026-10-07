import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { OX_ALPHA_MODEL: "primary", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 50, OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096, OPENROUTER_API_KEY: "k" } }));
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({ query: queryMock }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => {}) }));
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("../ai/agents/executor.js", () => ({ agentExecutor: { execute: executeMock } }));
vi.mock("../ai/agents/discovery.js", () => ({ runDiscovery: vi.fn(async () => ({ pages: [{ url: "https://e.com" }], evidence: [{ evidenceId: "11111111-1111-4111-8111-111111111111" }], warnings: [] })) }));
vi.mock("../ai/evidence/store.js", () => ({ findScanEvidence: vi.fn(async () => []), findEvidence: vi.fn(async () => []) }));
vi.mock("../services/cross-domain.service.js", () => ({ buildCrossDomainFinding: vi.fn(() => null), buildProposal: vi.fn(), persistCrossDomainFinding: vi.fn(), persistRemediationProposal: vi.fn() }));

import { OxAlphaExecutor } from "../ai/ox-alpha.js";
import { ProviderError } from "../ai/provider.js";
import type { ModelProvider, ModelResponse } from "../ai/provider.js";
import { AI_AGENT_DEADLINE_MS, AI_MAX_ATTEMPTS_PER_MODEL, AI_MAX_TOTAL_ATTEMPTS, AiDeadlineError, effectiveMaxTotalAttempts, withDeadline } from "../ai/limits.js";
import { runScanIntelligence, startStageHeartbeat } from "../ai/agents/scan-pipeline.js";

const ok = (content = "{}"): ModelResponse => ({ executionId: "x", model: "m", provider: "mock", content, finishReason: "stop", usage: null, durationMs: 1 });
const provider = (impl: (model: string) => Promise<ModelResponse>): ModelProvider & { calls: string[] } => {
  const calls: string[] = [];
  return { name: "mock", calls, isAvailable: async () => true, execute: vi.fn(async (req) => { calls.push(req.model); return impl(req.model); }) };
};
const req = { messages: [{ role: "user" as const, content: "hi" }] };

describe("bounded AI attempts (F-010)", () => {
  beforeEach(() => { vi.useFakeTimers(); queryMock.mockResolvedValue({ rows: [{ id: "db" }] }); });
  afterEach(() => vi.useRealTimers());

  it("never exceeds the hard total attempt cap with an always-failing provider, even with huge maxRetries and many fallbacks", async () => {
    const p = provider(async () => { throw new ProviderError("PROVIDER_ERROR", "boom", true); });
    const promise = new OxAlphaExecutor(p).execute({ ...req, maxRetries: 1000, fallbackModels: ["f1", "f2", "f3", "f4"] });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(p.calls.length).toBe(AI_MAX_TOTAL_ATTEMPTS);
    expect(result.attempts).toBe(AI_MAX_TOTAL_ATTEMPTS);
    expect(result.error).toMatch(/AI_ATTEMPT_LIMIT/);
  });
  it("clamps per-model retries", async () => {
    const p = provider(async () => { throw new ProviderError("PROVIDER_ERROR", "boom", true); });
    const promise = new OxAlphaExecutor(p).execute({ ...req, maxRetries: 1000, maxTotalAttempts: 100 });
    await vi.runAllTimersAsync();
    await promise;
    expect(p.calls.length).toBe(AI_MAX_ATTEMPTS_PER_MODEL);
  });
  it("honours a lower policy max_attempts but clamps a higher one", () => {
    expect(effectiveMaxTotalAttempts(2)).toBe(2);
    expect(effectiveMaxTotalAttempts(20)).toBe(AI_MAX_TOTAL_ATTEMPTS);
    expect(effectiveMaxTotalAttempts(0)).toBe(1);
  });
  it("still uses the fallback chain, counted against total attempts", async () => {
    const p = provider(async (model) => { if (model === "primary") throw new ProviderError("MODEL_UNAVAILABLE", "down", false); return ok(); });
    const promise = new OxAlphaExecutor(p).execute({ ...req, fallbackModels: ["fallback"] });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect(p.calls).toEqual(["primary", "fallback"]);
    expect(result.attempts).toBe(2);
  });
  it("maps an attempt timeout to a retryable TIMEOUT and retries within the cap", async () => {
    const p = provider(() => new Promise<ModelResponse>(() => undefined));
    (p.execute as ReturnType<typeof vi.fn>).mockImplementation((r: { signal: AbortSignal; model: string }) => { p.calls.push(r.model); return new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))); });
    const promise = new OxAlphaExecutor(p).execute({ ...req, timeoutMs: 100, maxRetries: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(p.calls.length).toBe(2);
  });
  it("enforces the execution deadline", async () => {
    const p = provider(async () => { throw new ProviderError("PROVIDER_ERROR", "boom", true); });
    const promise = new OxAlphaExecutor(p).execute({ ...req, deadlineAt: Date.now() - 1 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(p.calls.length).toBe(0);
    expect(result.error).toMatch(/AI_DEADLINE_EXCEEDED/);
  });
  it("caps a hung call at the remaining deadline and never exceeds the agent deadline", async () => {
    const p = provider(() => new Promise<ModelResponse>(() => undefined));
    (p.execute as ReturnType<typeof vi.fn>).mockImplementation((r: { signal: AbortSignal; model: string }) => { p.calls.push(r.model); return new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))); });
    const start = Date.now();
    const promise = new OxAlphaExecutor(p).execute({ ...req, timeoutMs: 60_000, deadlineAt: start + 1_000 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(Date.now() - start).toBeLessThanOrEqual(AI_AGENT_DEADLINE_MS);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
  it("withDeadline rejects hung work and passes through fast work", async () => {
    const hung = withDeadline(new Promise<string>(() => undefined), Date.now() + 500, "stage");
    const assertion = expect(hung).rejects.toBeInstanceOf(AiDeadlineError);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    await expect(withDeadline(Promise.resolve("ok"), Date.now() + 500, "stage")).resolves.toBe("ok");
  });
});

describe("stage lease heartbeat and idempotent stages (F-010)", () => {
  beforeEach(() => { vi.useFakeTimers(); queryMock.mockReset(); executeMock.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("renews the stage lease periodically and stops when told", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const stop = startStageHeartbeat({ scanId: "s", organizationId: "o" }, "SEO_ANALYSIS", "owner");
    await vi.advanceTimersByTimeAsync(95_000);
    const renewals = queryMock.mock.calls.filter(([sql]) => String(sql).includes("UPDATE agent_stage_claims SET lease_until"));
    expect(renewals.length).toBe(3);
    expect(renewals[0][1]).toEqual(["s", "o", "SEO_ANALYSIS", "owner", 120_000]);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(queryMock.mock.calls.length).toBe(3);
  });

  it("does not re-execute stages that already completed, and reuses persisted findings", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SELECT intelligence_status")) return { rows: [{ intelligence_status: "PENDING" }] };
      if (text.includes("INSERT INTO agent_executions")) return { rows: [] };
      if (text.includes("INSERT INTO agent_stage_claims")) return { rows: [] }; // claim refused: already completed
      if (text.includes("SELECT status FROM agent_stage_claims")) return { rows: [{ status: "COMPLETED" }] };
      if (text.includes("FROM findings f")) return { rows: [] };
      return { rows: [] };
    });
    const { getOxAlphaExecutor } = await import("../ai/ox-alpha.js");
    expect(getOxAlphaExecutor()).not.toBeNull();
    const result = await runScanIntelligence({ scanId: "scan-1", organizationId: "org-1", websiteId: "web-1", target: "https://e.com", deterministicFindings: [] });
    const specialistCalls = executeMock.mock.calls.filter(([c]) => c.agentType !== "REPORT_SYNTHESIS");
    expect(specialistCalls).toHaveLength(0);
    expect(Object.values(result.agentResults).every((r) => r?.status === "SUCCESS")).toBe(true);
  });
});
