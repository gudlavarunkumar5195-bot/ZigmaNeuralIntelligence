import { beforeAll, afterAll, describe, expect, it } from "vitest";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("Phase 6.5 PostgreSQL reliability constraints", () => {
  let query: typeof import("../db/client.js").query;
  let orgId: string;
  let otherOrgId: string;
  let websiteId: string;
  let scanId: string;
  let findingA: string;
  let findingB: string;
  let evidenceId: string;

  beforeAll(async () => {
    ({ query } = await import("../db/client.js"));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    orgId = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Reliability ${suffix}`, `reliability-${suffix}`])).rows[0].id;
    otherOrgId = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Other ${suffix}`, `other-${suffix}`])).rows[0].id;
    websiteId = (await query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1, $2, $3, TRUE) RETURNING id", [orgId, `https://reliability-${suffix}.example`, `reliability-${suffix}.example`])).rows[0].id;
    scanId = (await query<{ id: string }>("INSERT INTO scans (website_id, org_id, modules) VALUES ($1, $2, ARRAY['seo']) RETURNING id", [websiteId, orgId])).rows[0].id;
    findingA = (await query<{ id: string }>("INSERT INTO findings (scan_id, website_id, org_id, module_name, category, severity, title, description) VALUES ($1,$2,$3,'SEO_ANALYSIS','seo','low','A','A') RETURNING id", [scanId, websiteId, orgId])).rows[0].id;
    findingB = (await query<{ id: string }>("INSERT INTO findings (scan_id, website_id, org_id, module_name, category, severity, title, description) VALUES ($1,$2,$3,'AEO_ANALYSIS','aiVisibility','low','B','B') RETURNING id", [scanId, websiteId, orgId])).rows[0].id;
    evidenceId = (await query<{ id: string }>("INSERT INTO evidence (finding_id, org_id, task_id, type, evidence_type, source_type, source_reference, observed_at, content_hash, metadata) VALUES (NULL,$1,$2,'integration','HTML_DOCUMENT','CRAWLER','integration',NOW(),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}') RETURNING id", [orgId, scanId])).rows[0].id;
  });

  afterAll(async () => {
    if (query) {
      await query("DELETE FROM evidence WHERE org_id IN ($1,$2)", [orgId, otherOrgId]);
      await query("DELETE FROM scans WHERE id=$1", [scanId]);
      await query("DELETE FROM organizations WHERE id IN ($1,$2)", [orgId, otherOrgId]);
    }
  });

  it("allows one evidence record to support multiple findings", async () => {
    await query("INSERT INTO finding_evidence (finding_id, evidence_id, org_id) VALUES ($1,$3,$2),($4,$3,$2)", [findingA, orgId, evidenceId, findingB]);
    const result = await query<{ count: string }>("SELECT COUNT(*) AS count FROM finding_evidence WHERE evidence_id=$1 AND org_id=$2", [evidenceId, orgId]);
    expect(result.rows[0].count).toBe("2");
  });

  it("rejects cross-tenant evidence relationships", async () => {
    await expect(query("INSERT INTO finding_evidence (finding_id, evidence_id, org_id) VALUES ($1,$2,$3)", [findingA, evidenceId, otherOrgId])).rejects.toThrow();
  });

  it("permits one scan owner and one specialist stage owner", async () => {
    const { claimScanExecution } = await import("../services/scan.service.js");
    const [ownerA, ownerB] = await Promise.all([claimScanExecution(scanId, orgId, "00000000-0000-0000-0000-000000000001"), claimScanExecution(scanId, orgId, "00000000-0000-0000-0000-000000000002")]);
    expect([ownerA, ownerB].filter(Boolean)).toHaveLength(1);
    const stageRows = await query("INSERT INTO agent_stage_claims (scan_id, org_id, stage_name, owner_id) VALUES ($1,$2,'SEO_ANALYSIS','00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING RETURNING stage_name", [scanId, orgId]);
    expect(stageRows.rows).toHaveLength(1);
  });
});
