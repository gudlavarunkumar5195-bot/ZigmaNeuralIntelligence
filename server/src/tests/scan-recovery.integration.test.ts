import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("scan crash recovery + monitoring resilience (PostgreSQL)", () => {
  let query: typeof import("../db/client.js").query;
  let svc: typeof import("../services/scan.service.js");
  let mon: typeof import("../services/monitoring.service.js");
  let orgId: string;
  let otherOrgId: string;
  let websiteId: string;
  let otherWebsiteId: string;
  let cleanOrgId: string; // scans are wiped before each test that uses it
  let cleanWebsiteId: string;

  async function newScan(opts: { org?: string; website?: string; status?: string; leaseOffset?: string | null; attempts?: number; owner?: boolean }) {
    const org = opts.org ?? orgId;
    const site = opts.website ?? websiteId;
    const lease = opts.leaseOffset === undefined ? "NOW() - interval '5 minutes'" : opts.leaseOffset === null ? "NULL" : `NOW() + interval '${opts.leaseOffset}'`;
    const { rows } = await query<{ id: string }>(
      `INSERT INTO scans (website_id, org_id, status, modules, execution_attempts, execution_owner, execution_claimed_at, execution_lease_until, started_at)
       VALUES ($1,$2,$3,'{seo}',$4,${opts.owner === false ? "NULL" : "gen_random_uuid()"},NOW() - interval '10 minutes',${lease},NOW() - interval '10 minutes') RETURNING id`,
      [site, org, opts.status ?? "running", opts.attempts ?? 1],
    )
    await query("INSERT INTO scan_modules (scan_id, module_name, status) VALUES ($1,'seo','running')", [rows[0].id]);
    return rows[0].id;
  }
  const getScan = async (id: string) => (await query<any>("SELECT * FROM scans WHERE id=$1", [id])).rows[0];
  const events = async (id: string) => (await query<{ type: string }>("SELECT type FROM scan_events WHERE scan_id=$1 ORDER BY id", [id])).rows.map((r) => r.type);

  beforeAll(async () => {
    ({ query } = await import("../db/client.js"));
    svc = await import("../services/scan.service.js");
    mon = await import("../services/monitoring.service.js");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mkOrg = async (n: string) => (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`Recovery ${n} ${suffix}`, `recovery-${n}-${suffix}`])).rows[0].id;
    orgId = await mkOrg("a");
    otherOrgId = await mkOrg("b");
    const mkSite = async (org: string, n: string) => (await query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [org, `https://${n}-${suffix}.example`, `${n}-${suffix}.example`])).rows[0].id;
    websiteId = await mkSite(orgId, "a");
    otherWebsiteId = await mkSite(otherOrgId, "b");
    cleanOrgId = await mkOrg("c");
    cleanWebsiteId = await mkSite(cleanOrgId, "c");
  });

  afterAll(async () => {
    if (!query) return;
    for (const t of ["audit_log", "monitoring_runs", "monitoring_configs", "scans", "websites"]) await query(`DELETE FROM ${t} WHERE org_id IN ($1,$2,$3)`, [orgId, otherOrgId, cleanOrgId]).catch(() => undefined);
    await query("DELETE FROM organizations WHERE id IN ($1,$2,$3)", [orgId, otherOrgId, cleanOrgId]);
  });

  describe("sweeper", () => {
    it("requeues a RUNNING scan whose lease expired (crash simulation) and unblocks its module", async () => {
      const id = await newScan({ attempts: 1 });
      const res = await svc.recoverExpiredScanLeases({ orgId, maxAttempts: 3 });
      expect(res.requeued.map((r) => r.scanId)).toEqual([id]);
      const row = await getScan(id);
      expect(row).toMatchObject({ status: "queued", execution_owner: null, execution_lease_until: null, completed_at: null });
      const mod = (await query<any>("SELECT status, error FROM scan_modules WHERE scan_id=$1", [id])).rows[0];
      expect(mod.status).toBe("failed");
      expect(await events(id)).toContain("scan_requeued");
      // A worker can claim it again, which consumes another attempt.
      const claim = await svc.claimNextQueuedScan(orgId);
      expect(claim?.scanId).toBe(id);
      const claimed = await getScan(id);
      expect(claimed.status).toBe("running");
      expect(claimed.execution_attempts).toBe(2);
      expect(new Date(claimed.execution_lease_until).getTime()).toBeGreaterThan(Date.now());
    });

    it("fails a scan whose attempts are exhausted, with a clear error and event", async () => {
      const id = await newScan({ attempts: 3 });
      const res = await svc.recoverExpiredScanLeases({ orgId, maxAttempts: 3 });
      expect(res.failed.map((r) => r.scanId)).toEqual([id]);
      const row = await getScan(id);
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/lease expired.*3 attempt/);
      expect(row.completed_at).not.toBeNull();
      expect(row.execution_owner).toBeNull();
      expect(await events(id)).toContain("scan_failed");
    });

    it("recovers a legacy RUNNING scan that never obtained a lease", async () => {
      const id = await newScan({ leaseOffset: null, owner: false, attempts: 0 });
      const res = await svc.recoverExpiredScanLeases({ orgId });
      expect(res.requeued.map((r) => r.scanId)).toContain(id);
    });

    it("does not touch scans with a live lease, queued, or finished scans", async () => {
      const live = await newScan({ leaseOffset: "2 minutes" });
      const queued = await newScan({ status: "queued", leaseOffset: null, owner: false, attempts: 0 });
      const done = await newScan({ status: "completed", leaseOffset: "-5 minutes" });
      const res = await svc.recoverExpiredScanLeases({ orgId });
      expect([...res.requeued, ...res.failed].map((r) => r.scanId)).not.toEqual(expect.arrayContaining([live]));
      expect((await getScan(live)).status).toBe("running");
      expect((await getScan(live)).execution_owner).not.toBeNull();
      expect((await getScan(queued)).status).toBe("queued");
      expect((await getScan(done)).status).toBe("completed");
      expect(await events(live)).toEqual([]);
    });

    it("two concurrent sweepers never double-requeue", async () => {
      const ids = await Promise.all([newScan({}), newScan({}), newScan({})]);
      const [a, b] = await Promise.all([
        svc.recoverExpiredScanLeases({ orgId, maxAttempts: 5 }),
        svc.recoverExpiredScanLeases({ orgId, maxAttempts: 5 }),
      ]);
      const all = [...a.requeued, ...b.requeued].map((r) => r.scanId).filter((id) => ids.includes(id));
      expect(all.sort()).toEqual([...ids].sort());
      for (const id of ids) expect((await events(id)).filter((t) => t === "scan_requeued")).toHaveLength(1);
    });

    it("is tenant scoped when an org filter is given", async () => {
      const other = await newScan({ org: otherOrgId, website: otherWebsiteId });
      await svc.recoverExpiredScanLeases({ orgId });
      expect((await getScan(other)).status).toBe("running");
      const res = await svc.recoverExpiredScanLeases({ orgId: otherOrgId });
      expect(res.requeued).toEqual([{ scanId: other, orgId: otherOrgId }]);
    });

    it("a worker that lost its lease can no longer renew or complete", async () => {
      const id = await newScan({});
      const owner = (await getScan(id)).execution_owner as string;
      await svc.recoverExpiredScanLeases({ orgId });
      expect(await svc.renewScanExecution(id, orgId, owner)).toBe(false);
      // The guarded completion UPDATE used by runScan matches zero rows.
      const upd = await query(
        "UPDATE scans SET status='completed', completed_at=NOW() WHERE id=$1 AND org_id=$2 AND execution_owner=$3 AND execution_lease_until > NOW() AND status='running' RETURNING id",
        [id, orgId, owner],
      );
      expect(upd.rows).toHaveLength(0);
      expect((await getScan(id)).status).toBe("queued");
    });
  });

  describe("graceful shutdown", () => {
    beforeEach(async () => { await query("DELETE FROM scans WHERE org_id=$1", [cleanOrgId]); });
    it("requeues scans still owned by this process and hands the attempt back", async () => {
      const claim = await (async () => {
        const id = await newScan({ org: cleanOrgId, website: cleanWebsiteId, status: "queued", leaseOffset: null, owner: false, attempts: 0 });
        return { id, c: await svc.claimNextQueuedScan(cleanOrgId) };
      })();
      expect(claim.c?.scanId).toBe(claim.id);
      svc.startScanLeaseHeartbeat(claim.id, cleanOrgId, claim.c!.ownerId);
      const summary = await svc.stopScanWorker(0);
      expect(summary.requeued).toEqual([claim.id]);
      expect(svc.hasLostScanLease(claim.id)).toBe(true); // executor will abandon at next checkpoint
      svc.stopScanLeaseHeartbeat(claim.id);
      const row = await getScan(claim.id);
      expect(row).toMatchObject({ status: "queued", execution_owner: null, execution_attempts: 0 });
      expect(await events(claim.id)).toContain("scan_requeued");
    });

    it("fails (not requeues) a scan on shutdown when attempts are exhausted", async () => {
      const max = svc.maxExecutionAttempts();
      const id = await newScan({ org: cleanOrgId, website: cleanWebsiteId, leaseOffset: "2 minutes", attempts: max });
      const owner = (await getScan(id)).execution_owner as string;
      svc.startScanLeaseHeartbeat(id, cleanOrgId, owner);
      const summary = await svc.stopScanWorker(0);
      svc.stopScanLeaseHeartbeat(id);
      expect(summary.failed).toEqual([id]);
      expect((await getScan(id)).status).toBe("failed");
    });
  });

  describe("createScan transaction", () => {
    beforeEach(async () => { await query("DELETE FROM scans WHERE org_id=$1", [cleanOrgId]); });
    it("creates scan, modules and queued event atomically", async () => {
      const scan = await svc.createScan({ websiteId: cleanWebsiteId, orgId: cleanOrgId, triggeredBy: null, modules: ["seo", "ssl"] });
      const mods = await query("SELECT module_name FROM scan_modules WHERE scan_id=$1", [scan.id]);
      expect(mods.rows).toHaveLength(2);
      expect(await events(scan.id)).toEqual(["scan_queued"]);
    });

    it("rolls back the scan row when a later step fails", async () => {
      const before = (await query("SELECT id FROM scans WHERE org_id=$1", [cleanOrgId])).rows.length;
      await expect(svc.createScan({ websiteId: cleanWebsiteId, orgId: cleanOrgId, triggeredBy: null, modules: [null as unknown as string] })).rejects.toThrow();
      const after = (await query("SELECT id FROM scans WHERE org_id=$1", [cleanOrgId])).rows.length;
      expect(after).toBe(before);
    });
  });

  describe("F-016 monitoring survives cancelled/failed scans", () => {
    async function setup() {
      const { rows } = await query<{ id: string }>("INSERT INTO monitoring_configs (org_id, website_id, frequency, next_run_at) VALUES ($1,$2,'daily',NOW() + interval '1 day') ON CONFLICT (org_id, website_id) DO UPDATE SET status='ACTIVE', enabled=TRUE, next_run_at=NOW() + interval '1 day' RETURNING id", [orgId, websiteId]);
      const scanId = await newScan({ status: "cancelled", leaseOffset: null, owner: false });
      const run = await query<{ id: string }>("INSERT INTO monitoring_runs (monitoring_id, org_id, website_id, owner_id, scheduled_for, status, scan_id) VALUES ($1,$2,$3,gen_random_uuid(),NOW(),'RUNNING',$4) RETURNING id", [rows[0].id, orgId, websiteId, scanId]);
      return { monitoringId: rows[0].id, scanId, runId: run.rows[0].id };
    }

    it("a cancelled scan keeps the config ACTIVE and the next schedule fires", async () => {
      const { monitoringId, scanId, runId } = await setup();
      await mon.finalizeMonitoringRun(scanId, orgId, "cancelled");
      const cfg = (await query<any>("SELECT status, enabled, last_failure_at FROM monitoring_configs WHERE id=$1", [monitoringId])).rows[0];
      expect(cfg).toMatchObject({ status: "ACTIVE", enabled: true, last_failure_at: null });
      expect((await query<any>("SELECT status FROM monitoring_runs WHERE id=$1", [runId])).rows[0].status).toBe("CANCELLED");
      await query("UPDATE monitoring_configs SET next_run_at = NOW() - interval '1 minute' WHERE id=$1", [monitoringId]);
      const claim = await mon.claimDueMonitoring(orgId);
      expect(claim?.monitoringId).toBe(monitoringId);
    });

    it("a failed scan keeps the config ACTIVE and records the failure", async () => {
      const { monitoringId, scanId, runId } = await setup();
      await mon.finalizeMonitoringRun(scanId, orgId, "failed");
      const cfg = (await query<any>("SELECT status, last_failure_at FROM monitoring_configs WHERE id=$1", [monitoringId])).rows[0];
      expect(cfg.status).toBe("ACTIVE");
      expect(cfg.last_failure_at).not.toBeNull();
      expect((await query<any>("SELECT status FROM monitoring_runs WHERE id=$1", [runId])).rows[0].status).toBe("FAILED");
    });
  });
});
