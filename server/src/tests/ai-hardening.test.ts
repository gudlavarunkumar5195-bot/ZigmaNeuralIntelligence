import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { OX_ALPHA_MODEL: "primary", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 3, OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096, OPENROUTER_API_KEY: "k", SCANNER_MAX_PAGES: 200, SCANNER_MAX_SCAN_DURATION_MS: 300_000, AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: 3 } }));
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => {}) }));
const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../scanner/fetch.js", () => ({ safeFetch: safeFetchMock }));
const collectMock = vi.hoisted(() => vi.fn());
vi.mock("../ai/evidence/store.js", () => ({ collectEvidence: collectMock, findScanEvidence: vi.fn(async () => []) }));

import { OxAlphaExecutor, extractJson } from "../ai/ox-alpha.js";
import { OpenRouterProvider } from "../ai/providers/openrouter.js";
import { fetchOpenRouterCatalog } from "../ai/catalog.service.js";
import { loadScoringData } from "../ai/router/index.js";
import { runDiscovery, AI_DISCOVERY_MAX_PAGES } from "../ai/agents/discovery.js";
import { assertOrgAiBudget, AiBudgetError } from "../ai/budget.js";
import { AiAbortedError, raceAbort } from "../ai/limits.js";
import type { ModelProvider, ModelResponse } from "../ai/provider.js";

const resp = (content: string, finishReason: ModelResponse["finishReason"] = "stop"): ModelResponse => ({ executionId: "x", model: "m", provider: "mock", content, finishReason, usage: null, durationMs: 1 });
const req = { messages: [{ role: "user" as const, content: "hi" }], requireJson: true };
const fake = (impl: (call: number, model: string) => Promise<ModelResponse>): ModelProvider & { calls: number } => {
  const p = { name: "mock", calls: 0, isAvailable: async () => true, execute: vi.fn(async (r: { model: string }) => { p.calls++; return impl(p.calls, r.model); }) };
  return p as unknown as ModelProvider & { calls: number };
};

beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [{ id: "db", count: "0" }] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("A1 abort semantics in OxAlphaExecutor", () => {
  it("makes no provider call when already aborted", async () => {
    const p = fake(async () => resp("{}"));
    const ac = new AbortController(); ac.abort();
    const r = await new OxAlphaExecutor(p).execute({ ...req, signal: ac.signal });
    expect(p.calls).toBe(0);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^AI_ABORTED/);
  });
  it("stops without retry or further calls when aborted mid-attempt", async () => {
    const ac = new AbortController();
    const p = fake(async () => { ac.abort(); throw Object.assign(new Error("x"), { name: "AbortError" }); });
    const r = await new OxAlphaExecutor(p).execute({ ...req, signal: ac.signal, fallbackModels: ["f"] });
    expect(p.calls).toBe(1);
    expect(r.error).toMatch(/^AI_ABORTED/);
    expect(r.attempts).toBe(1);
  });
  it("raceAbort rejects with AiAbortedError", async () => {
    const ac = new AbortController();
    const pending = raceAbort(new Promise<string>(() => undefined), ac.signal, "stage");
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AiAbortedError);
  });
});

describe("A4 JSON extraction and truncation", () => {
  it("extracts fenced and prose-wrapped JSON", () => {
    expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractJson("```\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(extractJson("Here you go: {\"a\":3} thanks")).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("accepts fenced output in the executor on the first attempt", async () => {
    const p = fake(async () => resp("```json\n{\"status\":\"SUCCESS\"}\n```"));
    const r = await new OxAlphaExecutor(p).execute(req);
    expect(r.success).toBe(true);
    expect(r.parsedJson).toEqual({ status: "SUCCESS" });
    expect(p.calls).toBe(1);
  });
  it("treats finishReason length as non-retryable truncation (no same-model retry)", async () => {
    const p = fake(async () => resp("{\"a\":", "length"));
    const r = await new OxAlphaExecutor(p).execute(req);
    expect(p.calls).toBe(1);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/AI_OUTPUT_TRUNCATED/);
  });
});

describe("A7 per-org daily budget", () => {
  it("throws BUDGET_EXCEEDED at the limit and passes below it", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    await expect(assertOrgAiBudget("org-1")).rejects.toBeInstanceOf(AiBudgetError);
    queryMock.mockResolvedValueOnce({ rows: [{ count: "2" }] });
    await expect(assertOrgAiBudget("org-1")).resolves.toBeUndefined();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/org_id=\$1/);
    expect(queryMock.mock.calls[0][1]).toEqual(["org-1"]);
  });
  it("executor makes no provider call once the org budget is exhausted", async () => {
    queryMock.mockImplementation(async (sql: string) => String(sql).includes("COUNT(*)") ? { rows: [{ count: "3" }] } : { rows: [{ id: "db" }] });
    const p = fake(async () => resp("{}"));
    const r = await new OxAlphaExecutor(p).execute({ ...req, orgId: "org-1", scanId: "scan-1" });
    expect(p.calls).toBe(0);
    expect(r.error).toMatch(/^BUDGET_EXCEEDED/);
  });
});

describe("A5 body consumption", () => {
  it("OpenRouter provider cancels the body on 429 and 500", async () => {
    for (const status of [429, 500]) {
      const cancel = vi.fn(async () => undefined);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, headers: new Headers(), body: { cancel } })));
      await expect(new OpenRouterProvider("k").execute({ executionId: "e", correlationId: "c", model: "m", messages: [] })).rejects.toMatchObject({ httpStatus: status });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    vi.unstubAllGlobals();
  });
  it("catalog keeps the abort timer armed until the body is read and cancels error bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, body: { cancel } })));
    await expect(fetchOpenRouterCatalog()).rejects.toThrow(/HTTP 500/);
    expect(cancel).toHaveBeenCalled();

    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return { ok: true, status: 200, json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" })))) };
    }));
    const pending = fetchOpenRouterCatalog();
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(signal?.aborted).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("A6 router logs swallowed failures but still falls back", () => {
  it("returns empty maps and logs a structured warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryMock.mockRejectedValue(new Error("db down"));
    const [rel, bench] = await loadScoringData(["m1"]);
    expect(rel.size).toBe(0);
    expect(bench.size).toBe(0);
    const logged = JSON.parse(String(warn.mock.calls[0][0]));
    expect(logged).toMatchObject({ event: "router.reliability_benchmark_load_failed", error: "db down" });
  });
});

describe("A2/A3 discovery", () => {
  const page = (n: number, headers: Record<string, string> = {}) => ({ ok: true, status: 200, headers, body: `<html><title>p${n}</title><a href="/p${n + 1}">n</a></html>`, finalUrl: `https://e.com/p${n}`, durationMs: 1, contentType: "text/html", redirectCount: 0 });
  beforeEach(() => { safeFetchMock.mockReset(); collectMock.mockReset(); collectMock.mockImplementation(async (i: unknown) => ({ evidenceId: `ev-${collectMock.mock.calls.length}`, input: i })); });

  it("redacts secret headers before evidence is stored and preserves security headers", async () => {
    safeFetchMock.mockResolvedValue(page(1, { "set-cookie": "sid=abc", Authorization: "Bearer x", "x-api-key": "k", "strict-transport-security": "max-age=1", "content-security-policy": "default-src 'self'" }));
    const r = await runDiscovery({ scanId: "s", organizationId: "o", websiteId: "w", target: "https://e.com/p1", maxPages: 1 });
    const stored = collectMock.mock.calls[0][0].content.headers;
    expect(Object.keys(stored).sort()).toEqual(["content-security-policy", "strict-transport-security"]);
    expect(JSON.stringify(collectMock.mock.calls)).not.toMatch(/sid=abc|Bearer x/);
    expect(r.pages[0].headers).not.toHaveProperty("set-cookie");
  });
  it("stops at the overall time budget with a warning", async () => {
    let t = 1_000;
    safeFetchMock.mockImplementation(async (url: string) => { t += 400; return page(Number(url.match(/p(\d+)/)![1])); });
    const r = await runDiscovery({ scanId: "s", organizationId: "o", websiteId: "w", target: "https://e.com/p1", maxDurationMs: 1_000, now: () => t });
    expect(r.pages.length).toBe(3);
    expect(r.warnings.some((w) => /time budget/.test(w))).toBe(true);
  });
  it("hard-caps the AI crawl at 25 pages even when SCANNER_MAX_PAGES is 200", async () => {
    safeFetchMock.mockImplementation(async (url: string) => page(Number(url.match(/p(\d+)/)![1])));
    const r = await runDiscovery({ scanId: "s", organizationId: "o", websiteId: "w", target: "https://e.com/p1" });
    expect(r.pages.length).toBe(AI_DISCOVERY_MAX_PAGES);
    expect(safeFetchMock.mock.calls.length).toBe(AI_DISCOVERY_MAX_PAGES);
  });
  it("stops when aborted", async () => {
    safeFetchMock.mockImplementation(async (url: string) => page(Number(url.match(/p(\d+)/)![1])));
    const ac = new AbortController();
    collectMock.mockImplementation(async () => { ac.abort(); return { evidenceId: "e" }; });
    const r = await runDiscovery({ scanId: "s", organizationId: "o", websiteId: "w", target: "https://e.com/p1", signal: ac.signal });
    expect(r.pages.length).toBe(1);
    expect(r.warnings.join()).toMatch(/aborted/);
  });
});
