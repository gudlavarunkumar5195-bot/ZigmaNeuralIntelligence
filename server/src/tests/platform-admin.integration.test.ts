import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

const UNKNOWN_UUID = "00000000-0000-4000-8000-0000000000ff";

// Set before the app (and therefore config) is first imported in this file.
const PLATFORM_ADMIN_ID = randomUUID();
process.env.PLATFORM_ADMIN_USER_IDS = PLATFORM_ADMIN_ID;

describe.skipIf(!INTEGRATION)("platform admin access to global resources (real database)", () => {
  let h: Harness;
  let A: SeededOrg;
  let adminToken: string;

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "pa");
    const { query } = await import("../db/client.js");
    const email = `platform-${PLATFORM_ADMIN_ID}@http-test.example`;
    await query("INSERT INTO users (id, email, password_hash, full_name) VALUES ($1,$2,'!x','Platform Admin')", [PLATFORM_ADMIN_ID, email]);
    await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')", [PLATFORM_ADMIN_ID, A.id]);
    adminToken = h.mintToken({ id: PLATFORM_ADMIN_ID, email, orgIds: [A.id] });
  });
  afterAll(async () => {
    if (A) await cleanupOrgs([A.id]);
    await h?.close();
    const { closePool } = await import("../db/client.js");
    await closePool();
  });

  it("a listed platform admin passes the platform gate on every protected route", async () => {
    const routes: Array<[string, unknown]> = [
      [`/api/v1/models/${UNKNOWN_UUID}/disable`, { reason: "test" }],
      [`/api/v1/models/${UNKNOWN_UUID}/enable`, {}],
      ["/api/v1/models/catalog/refresh", {}],
    ];
    for (const [url, payload] of routes) {
      const res = await h.request("POST", url, { token: adminToken, orgId: A.id, payload });
      expect(res.json().error?.code).not.toBe("PLATFORM_ADMIN_REQUIRED");
      expect(res.statusCode).not.toBe(403);
    }
    // unknown model id -> 404 proves the handler ran
    const disable = await h.request("POST", `/api/v1/models/${UNKNOWN_UUID}/disable`, { token: adminToken, orgId: A.id, payload: { reason: "t" } });
    expect(disable.statusCode).toBe(404);
  });

  it("a platform admin can toggle a global agent", async () => {
    const off = await h.request("POST", "/api/v1/agents/DISCOVERY/disable", { token: adminToken, orgId: A.id, payload: {} });
    expect(off.statusCode).toBe(200);
    const on = await h.request("POST", "/api/v1/agents/DISCOVERY/enable", { token: adminToken, orgId: A.id, payload: {} });
    expect(on.statusCode).toBe(200);
  });

  it("a platform admin reaches the agent handler (unknown agent -> 404, not 403)", async () => {
    const res = await h.request("POST", "/api/v1/agents/NOPE/disable", { token: adminToken, orgId: A.id, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("an org owner who is not listed is still rejected", async () => {
    const res = await h.request("POST", "/api/v1/agents/DISCOVERY/disable", { token: A.users.owner.token, orgId: A.id, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
  });

  it("platform admin status does not bypass the tenant role/membership checks", async () => {
    const { id: otherOrg } = await seedOrg(h, "pa-other");
    const res = await h.request("POST", "/api/v1/agents/DISCOVERY/disable", { token: adminToken, orgId: otherOrg, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    await cleanupOrgs([otherOrg]);
  });
});
