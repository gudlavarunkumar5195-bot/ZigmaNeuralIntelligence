import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P0-6: a missing or failing AI provider must never look like a successful
// AI assessment. Real PostgreSQL for every status the UI and API read; only
// the network edges are replaced (discovery crawl, model executor).
const { executeMock, discoveryMock, oxAlpha } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  discoveryMock: vi.fn(),
  oxAlpha: { available: true },
}));
vi.mock("../ai/agents/executor.js", () => ({ agentExecutor: { execute: executeMock } }));
vi.mock("../ai/agents/discovery.js", () => ({ runDiscovery: discoveryMock }));
vi.mock("../ai/ox-alpha.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/ox-alpha.js")>();
  return { ...actual, getOxAlphaExecutor: () => (oxAlpha.available ? ({} as ReturnType<typeof actual.getOxAlphaExecutor>) : null) };
});

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";
const AI_MODULES = ["SEO_ANALYSIS", "AEO_ANALYSIS", "SECURITY_ANALYSIS", "PERFORMANCE_ANALYSIS", "ACCESSIBILITY_ANALYSIS", "TECHNICAL_HEALTH_ANALYSIS", "REPORT_SYNTHESIS"];

describe.skipIf(!INTEGRATION)("P0-6 missing or failing AI provider (PostgreSQL)", () => {
  let db: typeof import("../db/client.js");
  let pipeline: typeof import("../ai/agents/scan-pipeline.js");
  let orgId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const newScan = async () => {
    const n = `aipf-${++seq}-${suffix}`;
    const websiteId = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, `https://${n}.example`, `${n}.example`])).rows[0].id;
    const scanId = (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'running','{seo}') RETURNING id", [websiteId, orgId])).rows[0].id;
    return { scanId, websiteId, input: { scanId, organizationId: orgId, websiteId, target: `https://${n}.example`, deterministicFindings: [] } };
  };
  const stored = async (scanId: string) => ({
    scan: (await db.query<{ intelligence_status: string; intelligence_error: string | null }>("SELECT intelligence_status, intelligence_error FROM scans WHERE id=$1", [scanId])).rows[0],
    report: (await db.query<{ status: string; error: string | null; synthesis_quality_status: string | null }>("SELECT status, error, synthesis_quality_status FROM reports WHERE scan_id=$1", [scanId])).rows[0],
    aiFindings: Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM findings WHERE scan_id=$1 AND module_name = ANY($2)", [scanId, AI_MODULES])).rows[0].n),
  });

  beforeAll(async () => {
    db = await import("../db/client.js");
    pipeline = await import("../ai/agents/scan-pipeline.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`AIPF ${suffix}`, `aipf-${suffix}`])).rows[0].id;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  beforeEach(() => {
    executeMock.mockReset();
    discoveryMock.mockReset();
    oxAlpha.available = true;
    discoveryMock.mockResolvedValue({ pages: [{ url: "https://x.example/" }], evidence: [{ evidenceId: "11111111-1111-4111-8111-111111111111" }], warnings: [] });
  });
  afterAll(async () => {
    if (!db) return;
    for (const t of ["agent_stage_claims", "agent_executions", "audit_log", "findings", "reports", "scans", "websites"])
      await db.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => undefined);
    await db.query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => undefined);
  });

  it("no provider configured: intelligence and report are FAILED with MODEL_UNAVAILABLE, no model call, no AI findings", async () => {
    oxAlpha.available = false;
    const { scanId, input } = await newScan();
    const result = await pipeline.runScanIntelligence(input);

    expect(result.status).toBe("unavailable");
    expect(result.reportResult).toBeNull();
    expect(Object.keys(result.agentResults)).toHaveLength(0);
    expect(executeMock).not.toHaveBeenCalled();
    const s = await stored(scanId);
    expect(s.scan.intelligence_status).toBe("FAILED");
    expect(s.scan.intelligence_error).toMatch(/^MODEL_UNAVAILABLE/);
    expect(s.report.status).toBe("FAILED");
    expect(s.report.synthesis_quality_status).toBeNull();
    expect(s.aiFindings).toBe(0);
  });

  it("provider fails on every call: every specialist FAILED, no synthesis, report FAILED, nothing marked ACCEPTED", async () => {
    executeMock.mockRejectedValue(new Error("PROVIDER_ERROR: upstream 503"));
    const { scanId, input } = await newScan();
    const result = await pipeline.runScanIntelligence(input);

    expect(result.status).toBe("failed");
    expect(result.reportResult).toBeNull();
    expect(Object.values(result.agentResults).every((r) => r?.status === "FAILED")).toBe(true);
    expect(Object.values(result.agentResults).every((r) => r?.findings.length === 0)).toBe(true);
    // Six specialists were attempted; synthesis never ran without a successful specialist.
    expect(executeMock).toHaveBeenCalledTimes(6);
    expect(executeMock.mock.calls.map(([req]) => req.agentType)).not.toContain("REPORT_SYNTHESIS");
    const s = await stored(scanId);
    expect(s.scan.intelligence_status).toBe("FAILED");
    expect(s.scan.intelligence_error).toMatch(/specialist agent\(s\) failed/);
    expect(s.report.status).toBe("FAILED");
    expect(s.report.synthesis_quality_status).toBeNull();
    expect(s.aiFindings).toBe(0);
  });
});
