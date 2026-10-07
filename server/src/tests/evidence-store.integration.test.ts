import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("evidence store PostgreSQL persistence", () => {
  let query: typeof import("../db/client.js").query;
  let collectEvidence: typeof import("../ai/evidence/store.js").collectEvidence;
  let orgId: string;
  const taskId = `evidence-store-${Date.now()}`;
  const input = () => ({ tenantId: orgId, taskId, evidenceType: "HTML_DOCUMENT", sourceType: "CRAWLER", sourceReference: "integration", observedAt: new Date().toISOString(), content: { a: 1 } });

  beforeAll(async () => {
    ({ query } = await import("../db/client.js"));
    ({ collectEvidence } = await import("../ai/evidence/store.js"));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    orgId = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`EvStore ${suffix}`, `evstore-${suffix}`])).rows[0].id;
  });

  afterAll(async () => {
    if (query) {
      await query("DELETE FROM evidence WHERE org_id=$1", [orgId]);
      await query("DELETE FROM organizations WHERE id=$1", [orgId]);
    }
  });

  it("persists type and evidence_type without a logical key", async () => {
    const rec = await collectEvidence(input());
    const { rows } = await query<{ type: string; evidence_type: string }>("SELECT type, evidence_type FROM evidence WHERE id=$1 AND org_id=$2", [rec.evidenceId, orgId]);
    expect(rows[0]).toEqual({ type: "HTML_DOCUMENT", evidence_type: "HTML_DOCUMENT" });
  });

  it("persists type via the logical-key upsert and keeps a single row on repeat", async () => {
    const first = await collectEvidence({ ...input(), logicalKey: "lk-int" });
    const second = await collectEvidence({ ...input(), logicalKey: "lk-int" });
    expect(second.evidenceId).toBe(first.evidenceId);
    const { rows } = await query<{ type: string; evidence_type: string }>("SELECT type, evidence_type FROM evidence WHERE org_id=$1 AND task_id=$2 AND logical_key='lk-int'", [orgId, taskId]);
    expect(rows).toEqual([{ type: "HTML_DOCUMENT", evidence_type: "HTML_DOCUMENT" }]);
  });
});
