import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Deterministic scanner + no AI: the module commit path is what is under test.
const { seoRunner } = vi.hoisted(() => ({ seoRunner: vi.fn() }));
vi.mock("../scanner/seo.js", () => ({ runSEOScanner: seoRunner }));
vi.mock("../ai/agents/scan-pipeline.js", () => ({
  runScanIntelligence: async () => ({ status: "UNAVAILABLE", discoveryCount: 0 }),
}));

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

const finding = (title: string) => ({
  category: "seo", severity: "medium" as const, title, description: "d", recommendation: "r",
  affectedUrls: ["https://x.example/"], evidence: [{ type: "html_element", url: "https://x.example/", observedValue: "v", tool: "seo_scanner" }],
});

describe.skipIf(!INTEGRATION)("P0-5 module findings and status commit atomically (PostgreSQL)", () => {
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/scan.service.js");
  let orgId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  const newScan = async () => {
    const n = `mc-${++seq}-${suffix}`;
    const w = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, `https://${n}.example`, `${n}.example`])).rows[0].id;
    return (await svc.createScan({ websiteId: w, orgId, triggeredBy: null, modules: ["seo"] })).id;
  };
  const state = async (scanId: string) => ({
    findings: Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM findings WHERE scan_id=$1", [scanId])).rows[0].n),
    module: (await db.query<{ status: string }>("SELECT status FROM scan_modules WHERE scan_id=$1 AND module_name='seo'", [scanId])).rows[0].status,
    evidenceLinks: Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM finding_evidence fe JOIN findings f ON f.id=fe.finding_id WHERE f.scan_id=$1", [scanId])).rows[0].n),
  });

  beforeAll(async () => {
    db = await import("../db/client.js");
    svc = await import("../services/scan.service.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`MC ${suffix}`, `mc-${suffix}`])).rows[0].id;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    if (!db) return;
    for (const t of ["audit_log", "finding_evidence", "evidence", "findings", "scan_scores", "reports", "scans", "websites"])
      await db.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => undefined);
    await db.query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => undefined);
  });

  it("commits findings, evidence and the completed status together", async () => {
    const scanId = await newScan();
    seoRunner.mockImplementation(async () => ({ moduleName: "seo", status: "completed", durationMs: 1, findings: [finding("A"), finding("B")] }));
    await svc.runScan(scanId);
    expect(await state(scanId)).toEqual({ findings: 2, module: "completed", evidenceLinks: 2 });
  });

  it("writes nothing when the worker loses ownership mid-module, and the module stays re-runnable", async () => {
    const scanId = await newScan();
    seoRunner.mockImplementation(async () => {
      // Another worker takes over the scan (lease expired + reclaimed).
      await db.query("UPDATE scans SET execution_owner = gen_random_uuid() WHERE id=$1", [scanId]);
      return { moduleName: "seo", status: "completed", durationMs: 1, findings: [finding("A"), finding("B"), finding("C")] };
    });
    await svc.runScan(scanId);
    const s = await state(scanId);
    expect(s.findings).toBe(0);
    expect(s.evidenceLinks).toBe(0);
    expect(s.module).not.toBe("completed");
  });
});
