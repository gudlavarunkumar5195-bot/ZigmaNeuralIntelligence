import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("routing policy tenancy and integrity (F-007)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let q: typeof import("../db/client.js")["query"];
  let update: typeof import("../ai/router/routing-policy.js")["updateActivePolicy"];

  const activeGlobal = async () => (await q<{ id: string; version: number }>("SELECT id, version FROM routing_policies WHERE org_id IS NULL AND is_active=TRUE")).rows;
  const orgRows = async (org: string) => (await q<{ id: string; version: number; is_active: boolean; free_only: boolean }>("SELECT id, version, is_active, free_only FROM routing_policies WHERE org_id=$1 ORDER BY version", [org])).rows;

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "rp-a");
    B = await seedOrg(h, "rp-b");
    q = (await import("../db/client.js")).query;
    update = (await import("../ai/router/routing-policy.js")).updateActivePolicy;
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
    await (await import("../db/client.js")).closePool();
  });

  it("org A update leaves the global default active and org B untouched; versions are per org", async () => {
    const globalBefore = await activeGlobal();
    expect(globalBefore).toHaveLength(1);

    const r1 = await h.request("POST", "/api/v1/routing/policy", { token: A.users.owner.token, orgId: A.id, payload: { freeOnly: true } });
    expect(r1.statusCode).toBe(200);
    const r2 = await h.request("POST", "/api/v1/routing/policy", { token: A.users.admin.token, orgId: A.id, payload: { maxAttempts: 3 } });
    expect(r2.statusCode).toBe(200);

    expect(await activeGlobal()).toEqual(globalBefore);
    expect(await orgRows(B.id)).toEqual([]);
    const rows = await orgRows(A.id);
    expect(rows.map((r) => [r.version, r.is_active])).toEqual([[1, false], [2, true]]);
    expect(rows[1].free_only).toBe(true); // inherited from org's previous policy

    const bRes = await h.request("POST", "/api/v1/routing/policy", { token: B.users.owner.token, orgId: B.id, payload: {} });
    expect(bRes.json().data.version).toBe(1);
    const { getActivePolicy } = await import("../ai/router/routing-policy.js");
    expect((await getActivePolicy(A.id)).version).toBe(2);
    expect((await getActivePolicy(B.id)).freeOnly).toBe(false);
  });

  it("concurrent updates never leave two active rows", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => update({ description: `c${i}` }, A.users.owner.id, A.id)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = await orgRows(A.id);
    expect(rows.filter((r) => r.is_active)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.version)).size).toBe(rows.length);
  });

  it("the database refuses a second active policy in the same scope", async () => {
    await expect(
      q("INSERT INTO routing_policies (org_id, version, is_active) VALUES ($1, 9999, TRUE)", [A.id]),
    ).rejects.toThrow(/routing_policies_one_active_per_org/);
    await expect(
      q("INSERT INTO routing_policies (org_id, version, is_active) VALUES (NULL, 9999, TRUE)"),
    ).rejects.toThrow(/routing_policies_one_active_global/);
  });

  it("rolls back deactivate+insert when the audit write fails", async () => {
    const before = await orgRows(B.id);
    const fn = `zn_fail_audit_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
    await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='routing_policy_updated' AND NEW.org_id='${B.id}' THEN RAISE EXCEPTION 'audit blocked'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(update({ freeOnly: true }, B.users.owner.id, B.id)).rejects.toThrow(/audit blocked/);
    } finally {
      await q(`DROP TRIGGER ${fn} ON audit_log`);
      await q(`DROP FUNCTION ${fn}()`);
    }
    expect(await orgRows(B.id)).toEqual(before);
  });

  it("global scope update: platform admin required (unset env fails closed)", async () => {
    const res = await h.request("POST", "/api/v1/routing/policy", { token: A.users.owner.token, orgId: A.id, payload: { scope: "global", freeOnly: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
    expect(await activeGlobal()).toHaveLength(1);
  });

  it("a platform-scope update replaces only the global row, keeps one active, and org policies are unaffected", async () => {
    const orgBefore = await orgRows(A.id);
    const globalBefore = (await q<{ version: number }>("SELECT MAX(version) v FROM routing_policies WHERE org_id IS NULL")).rows[0].v;
    // Restore after: run in a transaction-like manner by re-deriving the same values.
    const p = await update({ description: "global change test" }, A.users.owner.id, undefined);
    expect(p.orgId).toBeNull();
    expect(p.version).toBe(globalBefore + 1);
    expect(await activeGlobal()).toHaveLength(1);
    expect(await orgRows(A.id)).toEqual(orgBefore);
    // Leave no trace in the shared global scope.
    await q("DELETE FROM audit_log WHERE resource_id=$1", [p.id]).catch(() => undefined);
    await q("UPDATE routing_policies SET is_active=FALSE WHERE id=$1", [p.id]);
    await q("UPDATE routing_policies SET is_active=TRUE WHERE org_id IS NULL AND version=$1", [globalBefore]);
    await q("DELETE FROM routing_policies WHERE id=$1", [p.id]);
  });
});
