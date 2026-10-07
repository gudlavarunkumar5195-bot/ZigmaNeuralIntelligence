import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

const UNKNOWN_UUID = "00000000-0000-4000-8000-0000000000ff";

describe.skipIf(!INTEGRATION)("HTTP RBAC and tenancy (real database)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "a");
    B = await seedOrg(h, "b");
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
    const { closePool } = await import("../db/client.js");
    await closePool();
  });

  const as = (role: "owner" | "admin" | "member" | "viewer", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });

  describe("organization resolution", () => {
    it("non-member of the requested org -> 403", async () => {
      const res = await h.request("GET", "/api/v1/websites", { token: A.users.owner.token, orgId: B.id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    });
    it("nonexistent org id -> 403", async () => {
      const res = await h.request("GET", "/api/v1/websites", { token: A.users.owner.token, orgId: UNKNOWN_UUID });
      expect(res.statusCode).toBe(403);
    });
    it("malformed org id -> 400 ORG_INVALID (not a 500 from the uuid cast)", async () => {
      const res = await h.request("GET", "/api/v1/websites", { token: A.users.owner.token, orgId: "not-a-uuid" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("ORG_INVALID");
    });
    it("membership is checked in the database, not trusted from JWT orgIds", async () => {
      const forged = h.mintToken({ id: A.users.viewer.id, email: A.users.viewer.email, orgIds: [A.id, B.id] });
      const res = await h.request("GET", "/api/v1/websites", { token: forged, orgId: B.id });
      expect(res.statusCode).toBe(403);
    });
    it("member can list own org websites", async () => {
      const res = await h.request("GET", "/api/v1/websites", as("viewer"));
      expect(res.statusCode).toBe(200);
      expect(res.json().data.map((w: { id: string }) => w.id)).toContain(A.websiteId);
    });
  });

  describe("RBAC on mutating routes", () => {
    // [description, method, url, payload, allowed roles]
    const cases: Array<[string, "POST" | "PATCH", string, () => unknown, string[]]> = [
      ["create website", "POST", "/api/v1/websites", () => ({}), ["owner", "admin", "member"]],
      ["qa-verify website", "POST", `/api/v1/websites/${UNKNOWN_UUID}/qa-verify`, () => ({}), ["owner", "admin"]],
      ["create scan", "POST", "/api/v1/scans", () => ({}), ["owner", "admin", "member"]],
      ["cancel scan", "POST", `/api/v1/scans/${UNKNOWN_UUID}/cancel`, () => ({}), ["owner", "admin", "member"]],
      ["create monitoring", "POST", "/api/v1/monitoring", () => ({}), ["owner", "admin", "member"]],
      ["update monitoring", "PATCH", `/api/v1/monitoring/${UNKNOWN_UUID}`, () => ({}), ["owner", "admin"]],
      ["pause monitoring", "POST", `/api/v1/monitoring/${UNKNOWN_UUID}/pause`, () => ({}), ["owner", "admin"]],
      ["create alert rule", "POST", `/api/v1/monitoring/${UNKNOWN_UUID}/rules`, () => ({}), ["owner", "admin"]],
      ["disable model", "POST", `/api/v1/models/${UNKNOWN_UUID}/disable`, () => ({}), ["owner", "admin"]],
      ["enable model", "POST", `/api/v1/models/${UNKNOWN_UUID}/enable`, () => ({}), ["owner", "admin"]],
      ["refresh model catalog", "POST", "/api/v1/models/catalog/refresh", () => ({}), ["owner", "admin"]],
      ["disable agent", "POST", "/api/v1/agents/seo/disable", () => ({}), ["owner", "admin"]],
      ["simulate agent", "POST", "/api/v1/agents/simulate", () => ({}), ["owner", "admin"]],
      ["set routing policy", "POST", "/api/v1/routing/policy", () => ({}), ["owner", "admin"]],
      ["simulate routing", "POST", "/api/v1/routing/simulate", () => ({}), ["owner", "admin"]],
    ];

    for (const [name, method, url, payload, allowed] of cases) {
      for (const role of ["viewer", "member", "admin", "owner"] as const) {
        const permitted = allowed.includes(role);
        it(`${name}: ${role} ${permitted ? "passes the role gate" : "-> 403 INSUFFICIENT_ROLE"}`, async () => {
          const res = await h.request(method, url, { ...as(role), payload: payload() });
          if (permitted) {
            // Past the gate: validation/not-found/etc. are fine, but never 401/403-by-role.
            expect(res.json()?.error?.code).not.toBe("INSUFFICIENT_ROLE");
            expect([401, 403].includes(res.statusCode) && res.json().error.code === "INSUFFICIENT_ROLE").toBe(false);
          } else {
            expect(res.statusCode).toBe(403);
            expect(res.json().error.code).toBe("INSUFFICIENT_ROLE");
          }
        });
      }
    }

    it("admin-only read routes (routing policy/decisions) reject viewer and member", async () => {
      for (const role of ["viewer", "member"] as const) {
        for (const url of ["/api/v1/routing/policy", "/api/v1/routing/decisions"]) {
          const res = await h.request("GET", url, as(role));
          expect(res.statusCode).toBe(403);
        }
      }
    });

    it("viewer can still read scans, monitoring, models and agents", async () => {
      for (const url of ["/api/v1/monitoring", `/api/v1/scans/${A.scanId}`, "/api/v1/models", "/api/v1/agents"]) {
        const res = await h.request("GET", url, as("viewer"));
        expect(res.statusCode, url).toBe(200);
      }
    });

    it("viewer cannot actually create a website or scan (no side effects)", async () => {
      const { query } = await import("../db/client.js");
      const before = (await query("SELECT 1 FROM scans WHERE org_id=$1", [A.id])).rowCount;
      await h.request("POST", "/api/v1/scans", { ...as("viewer"), payload: { websiteId: A.websiteId } });
      expect((await query("SELECT 1 FROM scans WHERE org_id=$1", [A.id])).rowCount).toBe(before);
    });
  });

  describe("cross-organization isolation", () => {
    it("org A cannot read org B website", async () => {
      const res = await h.request("GET", `/api/v1/websites/${B.websiteId}`, as("owner"));
      expect(res.statusCode).toBe(404);
    });
    it("org A cannot list org B website scans (no B rows leak)", async () => {
      const res = await h.request("GET", `/api/v1/websites/${B.websiteId}/scans`, as("owner"));
      expect([200, 404]).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.json().data).toEqual([]);
    });
    it("org A website listing excludes org B", async () => {
      const res = await h.request("GET", "/api/v1/websites", as("owner"));
      const ids = res.json().data.map((w: { id: string }) => w.id);
      expect(ids).not.toContain(B.websiteId);
    });
    for (const sub of ["", "/status", "/evidence", "/report", "/quality", "/findings"]) {
      it(`org A cannot read org B scan${sub || " (detail)"}`, async () => {
        const res = await h.request("GET", `/api/v1/scans/${B.scanId}${sub}`, as("owner"));
        expect(res.statusCode).toBe(404);
      });
    }
    it("org A cannot cancel org B scan", async () => {
      const res = await h.request("POST", `/api/v1/scans/${B.scanId}/cancel`, as("owner"));
      expect(res.statusCode).toBe(404);
    });
    it("org A cannot start a scan on org B website", async () => {
      const res = await h.request("POST", "/api/v1/scans", { ...as("owner"), payload: { websiteId: B.websiteId } });
      expect(res.statusCode).toBe(404);
    });
    it("org A cannot create monitoring for org B website", async () => {
      const res = await h.request("POST", "/api/v1/monitoring", { ...as("owner"), payload: { websiteId: B.websiteId, frequency: "daily" } });
      expect(res.statusCode).toBe(404);
    });
    it("org A cannot read or modify org B monitoring config", async () => {
      const get = await h.request("GET", `/api/v1/monitoring/${B.monitoringId}`, as("owner"));
      expect(get.statusCode).toBe(404);
      const patch = await h.request("PATCH", `/api/v1/monitoring/${B.monitoringId}`, { ...as("owner"), payload: { frequency: "weekly" } });
      expect(patch.statusCode).toBe(404);
      const { query } = await import("../db/client.js");
      const { rows } = await query<{ frequency: string; status: string }>("SELECT frequency, status FROM monitoring_configs WHERE id=$1", [B.monitoringId]);
      expect(rows[0]).toEqual({ frequency: "daily", status: "ACTIVE" });
    });
    it("org A cannot pause or read changes of org B monitoring", async () => {
      const pause = await h.request("POST", `/api/v1/monitoring/${B.monitoringId}/pause`, as("owner"));
      // Current behaviour: tenant-safe no-op reported as 200 {updated:false} (ideally 404).
      expect(pause.statusCode).toBe(200);
      expect(pause.json().data.updated).toBe(false);
      const { query } = await import("../db/client.js");
      expect((await query("SELECT status FROM monitoring_configs WHERE id=$1", [B.monitoringId])).rows[0].status).toBe("ACTIVE");
      const changes = await h.request("GET", `/api/v1/monitoring/${B.monitoringId}/changes`, as("owner"));
      expect([200, 404]).toContain(changes.statusCode);
      if (changes.statusCode === 200) expect(changes.json().data).toEqual([]);
    });
    it("org preferences: cannot read or write another org's preferences even as owner of own org", async () => {
      const get = await h.request("GET", `/api/v1/models/preferences/${B.id}`, as("owner"));
      expect(get.statusCode).toBe(403);
      const put = await h.request("PUT", `/api/v1/models/preferences/${B.id}`, { ...as("owner"), payload: { taskType: "seo" } });
      expect(put.statusCode).toBe(403);
    });
  });

  // F-008: global resources need a platform administrator in addition to the
  // tenant role. PLATFORM_ADMIN_USER_IDS is unset in this suite (fail closed).
  describe("global resources require a platform admin (F-008)", () => {
    const protectedRoutes: Array<[string, string, unknown]> = [
      ["POST", `/api/v1/models/${UNKNOWN_UUID}/disable`, { reason: "test" }],
      ["POST", `/api/v1/models/${UNKNOWN_UUID}/enable`, {}],
      ["POST", "/api/v1/models/catalog/refresh", {}],
      ["POST", "/api/v1/agents/seo/enable", {}],
      ["POST", "/api/v1/agents/seo/disable", {}],
      ["POST", "/api/v1/routing/policy", { scope: "global", freeOnly: true }],
    ];
    for (const [method, url, payload] of protectedRoutes) {
      for (const role of ["owner", "admin"] as const) {
        it(`${method} ${url}: org ${role} who is not a platform admin -> 403 PLATFORM_ADMIN_REQUIRED`, async () => {
          const res = await h.request(method as "POST", url, { ...as(role), payload });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
        });
      }
      it(`${method} ${url}: viewer still rejected by tenant role`, async () => {
        const res = await h.request(method as "POST", url, { ...as("viewer"), payload });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("INSUFFICIENT_ROLE");
      });
    }
    it("org admins can still set their own org model preferences", async () => {
      const res = await h.request("PUT", `/api/v1/models/preferences/${A.id}`, { ...as("admin"), payload: { taskType: "seo" } });
      expect(res.statusCode).toBe(200);
    });
  });
});
