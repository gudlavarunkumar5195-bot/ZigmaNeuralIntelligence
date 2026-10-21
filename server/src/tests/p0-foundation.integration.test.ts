import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Small AI limit so the concurrency test is meaningful; read when config loads.
process.env.AI_MAX_EXECUTIONS_PER_ORG_PER_DAY = "5";

// Pretend ClickHouse is configured so the outbox is exercised; no network.
const { chSend } = vi.hoisted(() => ({ chSend: vi.fn(async () => ({ status: 200, body: "" })) }));
vi.mock("../services/infrastructure.js", () => ({ isClickHouseConfigured: () => true, chRequest: chSend }));

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("P0 foundation guarantees (PostgreSQL)", () => {
  let db: typeof import("../db/client.js");
  let orgId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  const site = async () => {
    const n = `p0-${++seq}-${suffix}`;
    return (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, `https://${n}.example`, `${n}.example`])).rows[0].id;
  };

  beforeAll(async () => {
    db = await import("../db/client.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`P0 ${suffix}`, `p0-${suffix}`])).rows[0].id;
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => undefined);
    for (const t of ["analytics_outbox", "agent_executions", "scans", "websites"]) await db.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => undefined);
    await db.query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => undefined);
  });

  describe("P0-7 one active scan per website", () => {
    it("a double submit returns the same scan; concurrent submits create exactly one", async () => {
      const { createScan } = await import("../services/scan.service.js");
      const w = await site();
      const first = await createScan({ websiteId: w, orgId, triggeredBy: null, modules: ["seo"] });
      const again = await createScan({ websiteId: w, orgId, triggeredBy: null, modules: ["seo"] });
      expect(again.id).toBe(first.id);
      expect(again.deduplicated).toBe(true);
      await db.query("UPDATE scans SET status='completed' WHERE id=$1", [first.id]);

      const w2 = await site();
      const many = await Promise.all(Array.from({ length: 5 }, () => createScan({ websiteId: w2, orgId, triggeredBy: null, modules: ["seo"] })));
      expect(new Set(many.map((s) => s.id)).size).toBe(1);
      const { rows } = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM scans WHERE website_id=$1", [w2]);
      expect(rows[0].n).toBe("1");
      await db.query("UPDATE scans SET status='completed' WHERE website_id=$1", [w2]);
    });

    it("monitoring-style callers get a clear conflict instead of reusing another scan", async () => {
      const { createScan, ActiveScanExistsError } = await import("../services/scan.service.js");
      const w = await site();
      const first = await createScan({ websiteId: w, orgId, triggeredBy: null, modules: ["seo"] });
      await expect(createScan({ websiteId: w, orgId, triggeredBy: null, modules: ["ssl"], onActive: "reject" })).rejects.toBeInstanceOf(ActiveScanExistsError);
      await db.query("UPDATE scans SET status='completed' WHERE id=$1", [first.id]);
    });

    it("the database rejects a second active scan even when the app guard is bypassed", async () => {
      const w = await site();
      await db.query("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'queued','{seo}')", [w, orgId]);
      await expect(db.query("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'running','{seo}')", [w, orgId])).rejects.toMatchObject({ code: "23505" });
      // Finished scans do not count.
      await db.query("UPDATE scans SET status='completed' WHERE website_id=$1", [w]);
      await db.query("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'queued','{seo}')", [w, orgId]);
      await db.query("UPDATE scans SET status='completed' WHERE website_id=$1", [w]);
    });
  });

  describe("P0-6 atomic AI budget", () => {
    it("20 concurrent reservations with a limit of 5 record exactly 5 attempts", async () => {
      const { reserveOrgAiAttempt, AiBudgetError } = await import("../ai/budget.js");
      const w = await site();
      const scanId = (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'completed','{seo}') RETURNING id", [w, orgId])).rows[0].id;
      const insert = (tx: import("../db/client.js").Queryable) =>
        tx.query<{ id: string }>(
          "INSERT INTO agent_executions (scan_id, org_id, agent_type, task, status, attempt_number, execution_kind, started_at) VALUES ($1,$2,'TEST','t','running',1,'MODEL_ATTEMPT',NOW()) RETURNING id",
          [scanId, orgId],
        ).then((r) => r.rows[0].id);
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveOrgAiAttempt(orgId, insert)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(15);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(AiBudgetError);
      const { rows } = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM agent_executions WHERE org_id=$1 AND execution_kind='MODEL_ATTEMPT'", [orgId]);
      expect(rows[0].n).toBe("5");
    });
  });

  describe("durable analytics outbox", () => {
    it("an event commits or rolls back with its transaction, then dispatches exactly once", async () => {
      const events = await import("../analytics/events.js");
      await db.query("DELETE FROM analytics_outbox WHERE org_id=$1", [orgId]);
      await expect(db.withTransaction(async (tx) => {
        await events.enqueueAnalyticsEvent(tx, { table: "scan_events", orgId, row: { status: "rolled-back" } });
        throw new Error("business write failed");
      })).rejects.toThrow("business write failed");
      await db.withTransaction((tx) => events.enqueueAnalyticsEvent(tx, { table: "scan_events", orgId, row: { status: "committed", organization_id: "spoofed" } }));
      const pending = await db.query<{ payload: { status: string } }>("SELECT payload FROM analytics_outbox WHERE org_id=$1 AND status='PENDING'", [orgId]);
      expect(pending.rows.map((r) => r.payload.status)).toEqual(["committed"]);

      chSend.mockClear();
      // Other tests' rows may be pending too; dispatch until ours is delivered.
      for (let i = 0; i < 5; i++) await events.dispatchOutbox(chSend);
      const sent = chSend.mock.calls.map((c) => String((c as unknown[])[0])).join("\n");
      expect(sent).toContain('"status":"committed"');
      expect(sent).toContain(`"organization_id":"${orgId}"`);
      expect(sent).not.toContain('"organization_id":"spoofed"');
      const after = await db.query<{ status: string }>("SELECT status FROM analytics_outbox WHERE org_id=$1", [orgId]);
      expect(after.rows.map((r) => r.status)).toEqual(["DISPATCHED"]);
      chSend.mockClear();
      await events.dispatchOutbox(chSend);
      expect(chSend.mock.calls.map((c) => String((c as unknown[])[0])).join("\n")).not.toContain('"status":"committed"');
    });

    it("a ClickHouse outage leaves events PENDING with backoff (nothing lost)", async () => {
      const events = await import("../analytics/events.js");
      await db.query("DELETE FROM analytics_outbox WHERE org_id=$1", [orgId]);
      await db.withTransaction((tx) => events.enqueueAnalyticsEvent(tx, { table: "scan_findings", orgId, row: { severity: "high" } }));
      await events.dispatchOutbox(async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); });
      const { rows } = await db.query<{ status: string; attempts: number; future: boolean }>("SELECT status, attempts, next_attempt_at > NOW() AS future FROM analytics_outbox WHERE org_id=$1", [orgId]);
      expect(rows).toEqual([{ status: "PENDING", attempts: 1, future: true }]);
    });
  });
});
