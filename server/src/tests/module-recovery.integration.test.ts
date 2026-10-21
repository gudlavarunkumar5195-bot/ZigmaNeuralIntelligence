import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P0-5 failure injection: the worker "dies" inside a module's commit
// transaction (after its findings were inserted), the lease expires, the
// sweeper requeues the scan and a new worker finishes it. Deterministic
// scanners, no AI: the commit/recovery path is what is under test.
const { seoRunner, securityRunner, crash } = vi.hoisted(() => ({
  seoRunner: vi.fn(),
  securityRunner: vi.fn(),
  crash: { armed: false, fired: 0 },
}));
vi.mock("../scanner/seo.js", () => ({ runSEOScanner: seoRunner }));
vi.mock("../scanner/security.js", () => ({ runSecurityScanner: securityRunner }));
vi.mock("../ai/agents/scan-pipeline.js", () => ({
  runScanIntelligence: async () => ({ status: "UNAVAILABLE", discoveryCount: 0 }),
}));
// The analytics outbox write is the last statement of the module commit,
// after every finding row was inserted: failing it there models a crash
// between "findings written" and "module marked complete".
vi.mock("../analytics/events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics/events.js")>();
  return {
    ...actual,
    isClickHouseConfigured: () => true,
    enqueueAnalyticsEvent: async (...args: Parameters<typeof actual.enqueueAnalyticsEvent>) => {
      if (crash.armed) {
        crash.armed = false;
        crash.fired++;
        throw new Error("simulated worker crash during module commit");
      }
      // Nothing is dispatched in tests; the outbox row itself is not under test.
      void args;
    },
  };
});

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

const finding = (category: string, title: string) => ({
  category, severity: "medium" as const, title, description: "d", recommendation: "r",
  affectedUrls: ["https://x.example/"], evidence: [{ type: "html_element", url: "https://x.example/", observedValue: title, tool: `${category}_scanner` }],
});
const completed = (moduleName: string, findings: ReturnType<typeof finding>[]) =>
  async () => ({ moduleName, status: "completed", durationMs: 1, findings });

describe.skipIf(!INTEGRATION)("P0-5 crash between findings insert and module completion (PostgreSQL)", () => {
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/scan.service.js");
  let orgId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const newScan = async (modules: string[]) => {
    const n = `mr-${++seq}-${suffix}`;
    const w = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, `https://${n}.example`, `${n}.example`])).rows[0].id;
    return (await svc.createScan({ websiteId: w, orgId, triggeredBy: null, modules })).id;
  };
  const count = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0].n);
  const state = async (scanId: string) => ({
    scan: (await db.query<{ status: string }>("SELECT status FROM scans WHERE id=$1", [scanId])).rows[0].status,
    modules: Object.fromEntries((await db.query<{ module_name: string; status: string }>("SELECT module_name, status FROM scan_modules WHERE scan_id=$1 ORDER BY module_name", [scanId])).rows.map((r) => [r.module_name, r.status])),
    findings: Object.fromEntries((await db.query<{ category: string; n: string }>("SELECT category, COUNT(*)::text AS n FROM findings WHERE scan_id=$1 GROUP BY category", [scanId])).rows.map((r) => [r.category, Number(r.n)])),
    evidenceLinks: await count("SELECT COUNT(*)::text AS n FROM finding_evidence fe JOIN findings f ON f.id=fe.finding_id WHERE f.scan_id=$1", [scanId]),
  });
  /** What the process sees after it died: the lease is never renewed again. */
  const crashAndExpireLease = async (scanId: string) => {
    // runScan's own `finally` releases the lease on a thrown error; a killed
    // process cannot, so put the scan back the way a dead worker leaves it.
    await db.query(
      "UPDATE scans SET status='running', execution_owner=gen_random_uuid(), execution_lease_until=NOW() - interval '1 minute' WHERE id=$1",
      [scanId],
    );
  };
  const recoverAndRerun = async (scanId: string) => {
    const swept = await svc.recoverExpiredScanLeases({ orgId });
    expect(swept.requeued.map((r) => r.scanId)).toContain(scanId);
    const claimed = await svc.claimNextQueuedScan(orgId);
    expect(claimed?.scanId).toBe(scanId);
    await svc.runScan(scanId, claimed!.ownerId);
  };

  beforeAll(async () => {
    db = await import("../db/client.js");
    svc = await import("../services/scan.service.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`MR ${suffix}`, `mr-${suffix}`])).rows[0].id;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  beforeEach(() => {
    seoRunner.mockReset();
    securityRunner.mockReset();
    crash.armed = false;
    crash.fired = 0;
  });
  afterAll(async () => {
    if (!db) return;
    for (const t of ["audit_log", "analytics_outbox", "finding_evidence", "evidence", "findings", "scan_scores", "reports", "scans", "websites"])
      await db.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => undefined);
    await db.query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => undefined);
  });

  it("a crash after the findings insert rolls the module back; the retried module writes the exact finding count", async () => {
    const scanId = await newScan(["seo"]);
    seoRunner.mockImplementation(async () => {
      crash.armed = true;
      return completed("seo", [finding("seo", "A"), finding("seo", "B"), finding("seo", "C")])();
    });
    await expect(svc.runScan(scanId)).rejects.toThrow(/simulated worker crash/);
    expect(crash.fired).toBe(1);
    await crashAndExpireLease(scanId);

    const afterCrash = await state(scanId);
    expect(afterCrash.findings).toEqual({});
    expect(afterCrash.evidenceLinks).toBe(0);
    expect(afterCrash.modules.seo).not.toBe("completed");

    seoRunner.mockImplementation(completed("seo", [finding("seo", "A"), finding("seo", "B"), finding("seo", "C")]));
    await recoverAndRerun(scanId);
    const s = await state(scanId);
    expect(s).toMatchObject({ scan: "completed", modules: { seo: "completed" }, findings: { seo: 3 }, evidenceLinks: 3 });
    expect(seoRunner).toHaveBeenCalledTimes(2);
  });

  it("a crash in a later module keeps the earlier committed module and its findings; recovery does not re-run or duplicate them", async () => {
    const scanId = await newScan(["seo", "security"]);
    seoRunner.mockImplementation(completed("seo", [finding("seo", "A"), finding("seo", "B")]));
    securityRunner.mockImplementation(async () => {
      crash.armed = true;
      return completed("security", [finding("security", "X")])();
    });
    await expect(svc.runScan(scanId)).rejects.toThrow(/simulated worker crash/);
    await crashAndExpireLease(scanId);
    const afterCrash = await state(scanId);
    expect(afterCrash.modules.seo).toBe("completed");
    expect(afterCrash.modules.security).not.toBe("completed");
    expect(afterCrash.findings).toEqual({ seo: 2 });

    securityRunner.mockImplementation(completed("security", [finding("security", "X")]));
    await recoverAndRerun(scanId);
    const s = await state(scanId);
    expect(s).toMatchObject({
      scan: "completed",
      modules: { seo: "completed", security: "completed" },
      findings: { seo: 2, security: 1 },
      evidenceLinks: 3,
    });
    expect(seoRunner).toHaveBeenCalledTimes(1);
    expect(securityRunner).toHaveBeenCalledTimes(2);
  });

  it("re-running an already committed module (duplicate delivery) does not duplicate findings", async () => {
    const scanId = await newScan(["seo"]);
    seoRunner.mockImplementation(completed("seo", [finding("seo", "A"), finding("seo", "B")]));
    await svc.runScan(scanId);
    expect((await state(scanId)).findings).toEqual({ seo: 2 });

    // Force the same module to execute again for the same scan, as a
    // duplicate job delivery would: the logical-key upsert keeps one row per
    // finding.
    await db.query("UPDATE scan_modules SET status='failed', retry_count=0 WHERE scan_id=$1", [scanId]);
    await db.query("UPDATE scans SET status='queued', completed_at=NULL WHERE id=$1", [scanId]);
    const claimed = await svc.claimNextQueuedScan(orgId);
    expect(claimed?.scanId).toBe(scanId);
    await svc.runScan(scanId, claimed!.ownerId);

    expect(seoRunner).toHaveBeenCalledTimes(2);
    const s = await state(scanId);
    expect(s.findings).toEqual({ seo: 2 });
    expect(s.evidenceLinks).toBe(2);
    expect(await count("SELECT COUNT(DISTINCT logical_key)::text AS n FROM findings WHERE scan_id=$1", [scanId])).toBe(2);
  });
});
