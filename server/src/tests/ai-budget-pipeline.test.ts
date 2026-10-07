import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { OX_ALPHA_MODEL: "primary", OX_ALPHA_TIMEOUT_MS: 5_000, OX_ALPHA_MAX_RETRIES: 3, OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096, OPENROUTER_API_KEY: "k", AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: 2 } }));
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({ query: queryMock }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => {}) }));
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("../ai/agents/executor.js", () => ({ agentExecutor: { execute: executeMock } }));
const discoveryMock = vi.hoisted(() => vi.fn());
vi.mock("../ai/agents/discovery.js", () => ({ runDiscovery: discoveryMock }));
vi.mock("../ai/evidence/store.js", () => ({ findScanEvidence: vi.fn(async () => []), findEvidence: vi.fn(async () => []) }));
vi.mock("../services/cross-domain.service.js", () => ({ buildCrossDomainFinding: vi.fn(() => null), buildProposal: vi.fn(), persistCrossDomainFinding: vi.fn(), persistRemediationProposal: vi.fn() }));

import { runScanIntelligence } from "../ai/agents/scan-pipeline.js";

const input = { scanId: "scan-1", organizationId: "org-1", websiteId: "web-1", target: "https://e.com", deterministicFindings: [] };
let used = 0;
beforeEach(() => {
  used = 0;
  queryMock.mockReset(); executeMock.mockReset(); discoveryMock.mockReset();
  discoveryMock.mockResolvedValue({ pages: [{ url: "https://e.com" }], evidence: [{ evidenceId: "11111111-1111-4111-8111-111111111111" }], warnings: [] });
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("SELECT intelligence_status")) return { rows: [{ intelligence_status: "PENDING" }] };
    if (text.includes("COUNT(*)")) return { rows: [{ count: String(used) }] };
    if (text.includes("INSERT INTO agent_stage_claims")) return { rows: [{ stage_name: "x" }] };
    if (text.includes("SELECT status FROM scans")) return { rows: [{ status: "running" }] };
    return { rows: [] };
  });
});

describe("runScanIntelligence budget (A7)", () => {
  it("fails cleanly with BUDGET_EXCEEDED and makes no discovery or model calls", async () => {
    used = 2;
    const r = await runScanIntelligence(input);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^BUDGET_EXCEEDED/);
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql, args]) => String(sql).includes("UPDATE scans SET intelligence_status = 'FAILED'") && String((args as string[])[2]).startsWith("BUDGET_EXCEEDED"))).toBe(true);
    const countCall = queryMock.mock.calls.find(([sql]) => String(sql).includes("COUNT(*)"))!;
    expect(countCall[1]).toEqual(["org-1"]);
  });
});

describe("runScanIntelligence abort (A1)", () => {
  it("makes no specialist or synthesis calls when aborted before specialists", async () => {
    const ac = new AbortController();
    discoveryMock.mockImplementation(async () => { ac.abort(); return { pages: [{ url: "u" }], evidence: [{ evidenceId: "e" }], warnings: [] }; });
    const r = await runScanIntelligence({ ...input, signal: ac.signal });
    expect(r.error).toMatch(/^AI_ABORTED/);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("aborts in-flight specialists, passes the signal down, skips synthesis and does not overwrite scan status", async () => {
    const ac = new AbortController();
    executeMock.mockImplementation((ctx: { signal: AbortSignal }) => {
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      queueMicrotask(() => ac.abort());
      return new Promise(() => undefined); // never settles: only abort can end the stage
    });
    const r = await runScanIntelligence({ ...input, signal: ac.signal });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^AI_ABORTED/);
    expect(executeMock.mock.calls.every(([c]) => c.agentType !== "REPORT_SYNTHESIS")).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("SET intelligence_status = $3"))).toBe(false);
  });
  it("honours the polled isAborted callback", async () => {
    let aborted = false;
    executeMock.mockImplementation(() => { setTimeout(() => { aborted = true; }, 0); return new Promise(() => undefined); });
    const r = await runScanIntelligence({ ...input, isAborted: () => aborted, abortPollMs: 5 });
    expect(r.error).toMatch(/^AI_ABORTED/);
  });
});
