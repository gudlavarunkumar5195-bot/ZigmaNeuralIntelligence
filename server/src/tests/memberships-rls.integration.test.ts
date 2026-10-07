import { describe, expect, it } from "vitest";
import { INTEGRATION } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("memberships least privilege (integration)", () => {
  it("no FOR ALL/INSERT/UPDATE/DELETE policy on memberships remains", async () => {
    const { query } = await import("../db/client.js");
    const { rows } = await query<{ cmd: string }>("SELECT cmd FROM pg_policies WHERE tablename = 'memberships'");
    expect(rows.every((r) => r.cmd === "SELECT")).toBe(true);
    // The replacement SELECT policy only exists where the Supabase `authenticated`
    // role exists (plain PostgreSQL test containers may not have it).
    const roles = await query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = 'authenticated'");
    if (roles.rows.length > 0) expect(rows.length).toBeGreaterThan(0);
  });
  it("disabled users are rejected by requireOrgMember immediately", async () => {
    const { createHarness, seedOrg, cleanupOrgs } = await import("./helpers/http.js");
    const { query } = await import("../db/client.js");
    const h = await createHarness();
    const org = await seedOrg(h, "disabled");
    try {
      const u = org.users.member;
      expect((await h.request("GET", "/api/v1/websites", { token: u.token, orgId: org.id })).statusCode).toBe(200);
      await query("UPDATE users SET active = FALSE WHERE id = $1", [u.id]);
      expect((await h.request("GET", "/api/v1/websites", { token: u.token, orgId: org.id })).statusCode).toBe(403);
    } finally {
      await cleanupOrgs([org.id]);
      await h.close();
    }
  });
});
