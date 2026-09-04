import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("Phase 8 monitoring PostgreSQL integration", () => {
  let query: typeof import("../db/client.js").query;
  let orgId: string;
  let otherOrgId: string;
  let websiteId: string;
  let monitoringId: string;

  beforeAll(async () => {
    ({ query } = await import("../db/client.js"));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    orgId = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`Monitoring ${suffix}`, `monitoring-${suffix}`])).rows[0].id;
    otherOrgId = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`Other Monitoring ${suffix}`, `other-monitoring-${suffix}`])).rows[0].id;
    websiteId = (await query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, `https://monitoring-${suffix}.example`, `monitoring-${suffix}.example`])).rows[0].id;
    monitoringId = (await query<{ id: string }>("INSERT INTO monitoring_configs (org_id, website_id, frequency, next_run_at) VALUES ($1,$2,'daily',NOW()) RETURNING id", [orgId, websiteId])).rows[0].id;
  });

  afterAll(async () => {
    if (!query) return;
    await query("DELETE FROM organizations WHERE id IN ($1,$2)", [orgId, otherOrgId]);
  });

  it("keeps monitoring config tenant-scoped", async () => {
    const own = await query("SELECT id FROM monitoring_configs WHERE id=$1 AND org_id=$2", [monitoringId, orgId]);
    const other = await query("SELECT id FROM monitoring_configs WHERE id=$1 AND org_id=$2", [monitoringId, otherOrgId]);
    expect(own.rows).toHaveLength(1);
    expect(other.rows).toHaveLength(0);
  });

  it("allows only one concurrent due-job claim", async () => {
    const { claimDueMonitoring } = await import("../services/monitoring.service.js");
    const [first, second] = await Promise.all([claimDueMonitoring(orgId), claimDueMonitoring(orgId)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("does not create alert rules or runs for another tenant", async () => {
    const rules = await query("SELECT id FROM alert_rules WHERE org_id=$1", [otherOrgId]);
    const runs = await query("SELECT id FROM monitoring_runs WHERE org_id=$1", [otherOrgId]);
    expect(rules.rows).toHaveLength(0);
    expect(runs.rows).toHaveLength(0);
  });
});
