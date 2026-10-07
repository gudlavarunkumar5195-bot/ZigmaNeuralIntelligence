import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHarness, type Harness } from "./helpers/http.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  login: vi.fn(),
  consume: vi.fn(),
  revoke: vi.fn(),
  addWebsite: vi.fn(),
}));

vi.mock("../db/client.js", async (orig) => ({
  ...(await orig<typeof import("../db/client.js")>()),
  query: mocks.query,
  withTransaction: mocks.withTransaction,
}));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../services/website.service.js", async (orig) => ({
  ...(await orig<typeof import("../services/website.service.js")>()),
  addWebsite: mocks.addWebsite,
}));

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const PG_LEAK = "connect ECONNREFUSED 10.1.2.3:5432";
const pgError = () => Object.assign(new Error(PG_LEAK), { code: "ECONNREFUSED" });

describe("migration 026 (static)", () => {
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/026_memberships_least_privilege.sql", import.meta.url)), "utf8").replace(/--.*$/gm, "");
  it("drops the permissive FOR ALL policy and never recreates it", () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS memberships_org_membership ON memberships/);
    expect(sql).not.toMatch(/CREATE POLICY memberships_org_membership/);
    expect(sql).not.toMatch(/FOR ALL/i);
  });
  it("creates only a SELECT policy and revokes writes, guarded by role existence", () => {
    expect(sql).toMatch(/CREATE POLICY \w+ ON memberships FOR SELECT TO authenticated/);
    expect(sql).not.toMatch(/WITH CHECK/i);
    for (const t of ["memberships", "organizations"]) {
      expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM authenticated`));
      expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM anon`));
    }
    expect(sql.match(/pg_roles/g)?.length).toBe(2);
  });
  it("supabase_setup.sql is deprecated and raises", () => {
    const setup = readFileSync(fileURLToPath(new URL("../db/supabase_setup.sql", import.meta.url)), "utf8");
    expect(setup).toMatch(/RAISE EXCEPTION 'DEPRECATED/);
    expect(setup).not.toMatch(/CREATE TABLE/i);
  });
});

describe("auth.service login", () => {
  beforeEach(() => { mocks.query.mockReset(); vi.restoreAllMocks(); });
  const validFormat = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;

  it("unknown email compares against a valid 60-char bcrypt hash", async () => {
    const { login } = await import("../services/auth.service.js");
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const spy = vi.spyOn(bcrypt, "compare");
    await expect(login({ email: "x@y.com", password: "pw" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const hash = spy.mock.calls[0][1] as string;
    expect(hash).toHaveLength(60);
    expect(hash).toMatch(validFormat);
  });

  it("wrong password calls compare against the stored hash; disabled+wrong password is generic", async () => {
    const { login } = await import("../services/auth.service.js");
    const real = bcrypt.hashSync("right", 4);
    const spy = vi.spyOn(bcrypt, "compare");
    mocks.query.mockResolvedValueOnce({ rows: [{ id: USER, password_hash: real, full_name: null, active: false }] });
    await expect(login({ email: "x@y.com", password: "wrong" })).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(spy).toHaveBeenCalledWith("wrong", real);
  });

  it("disabled account with the correct password reveals ACCOUNT_DISABLED", async () => {
    const { login } = await import("../services/auth.service.js");
    mocks.query.mockResolvedValueOnce({ rows: [{ id: USER, password_hash: bcrypt.hashSync("right", 4), full_name: null, active: false }] });
    await expect(login({ email: "x@y.com", password: "right" })).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });
});

describe("auth.service refresh rotation", () => {
  function fakeClient(script: (sql: string) => { rows: unknown[] }) {
    const calls: string[] = [];
    const client = { query: vi.fn(async (sql: string) => { calls.push(sql); return script(sql); }) };
    mocks.withTransaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client));
    return calls;
  }

  it("revokes old token and inserts the new one on the same transaction client", async () => {
    const { consumeRefreshToken } = await import("../services/auth.service.js");
    const calls = fakeClient((sql) => {
      if (sql.includes("RETURNING user_id")) return { rows: [{ user_id: USER }] };
      if (sql.includes("FROM users")) return { rows: [{ email: "a@b.c", active: true }] };
      if (sql.includes("FROM memberships")) return { rows: [{ org_id: ORG }] };
      return { rows: [] };
    });
    const res = await consumeRefreshToken("raw");
    expect(res.newRefreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(res.orgIds).toEqual([ORG]);
    expect(calls.some((c) => c.includes("INSERT INTO refresh_tokens"))).toBe(true);
  });

  it("replay of a revoked token revokes all of the user's tokens and fails", async () => {
    const { consumeRefreshToken } = await import("../services/auth.service.js");
    const calls = fakeClient((sql) => {
      if (sql.includes("RETURNING user_id")) return { rows: [] };
      if (sql.includes("SELECT user_id, revoked_at")) return { rows: [{ user_id: USER, revoked_at: "2020-01-01" }] };
      return { rows: [] };
    });
    await expect(consumeRefreshToken("raw")).rejects.toMatchObject({ statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
    expect(calls.some((c) => /UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE user_id = \$1/.test(c))).toBe(true);
    expect(calls.some((c) => c.includes("INSERT INTO refresh_tokens"))).toBe(false);
  });

  it("unknown token does not trigger mass revocation", async () => {
    const { consumeRefreshToken } = await import("../services/auth.service.js");
    const calls = fakeClient(() => ({ rows: [] }));
    await expect(consumeRefreshToken("raw")).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
    expect(calls.some((c) => /WHERE user_id = \$1/.test(c))).toBe(false);
  });
});

describe("website.service markVerified", () => {
  it("scopes the UPDATE by org_id", async () => {
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    const { markVerified } = await import("../services/website.service.js");
    await markVerified("w1", "o1");
    expect(mocks.query.mock.calls[0][0]).toMatch(/id = \$1 AND org_id = \$2/);
    expect(mocks.query.mock.calls[0][1]).toEqual(["w1", "o1"]);
  });
});

describe("HTTP hardening (mocked services, no database)", () => {
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    vi.doMock("../services/auth.service.js", async (orig) => ({
      ...(await orig<typeof import("../services/auth.service.js")>()),
      login: mocks.login, consumeRefreshToken: mocks.consume, revokeRefreshToken: mocks.revoke,
    }));
    h = await createHarness();
    token = h.mintToken({ id: USER, email: "u@example.com", orgIds: [ORG] });
  });
  afterAll(async () => { await h?.close(); });
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.query.mockResolvedValue({ rows: [{ role: "owner" }] });
  });

  it("login does not leak driver errors", async () => {
    mocks.login.mockRejectedValue(pgError());
    const res = await h.request("POST", "/api/v1/auth/login", { payload: { email: "a@b.com", password: "x" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("10.1.2.3");
  });

  it("login still passes through app errors", async () => {
    mocks.login.mockRejectedValue(Object.assign(new Error("Account is disabled"), { statusCode: 403, code: "ACCOUNT_DISABLED" }));
    const res = await h.request("POST", "/api/v1/auth/login", { payload: { email: "a@b.com", password: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ACCOUNT_DISABLED");
  });

  it("refresh does not leak driver errors", async () => {
    mocks.consume.mockRejectedValue(pgError());
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { zn_refresh: "abc" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("POST /websites does not leak driver errors", async () => {
    mocks.addWebsite.mockRejectedValue(pgError());
    const res = await h.request("POST", "/api/v1/websites", { token, orgId: ORG, payload: { url: "https://example.com" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("logout works from the refresh cookie alone and revokes it", async () => {
    mocks.revoke.mockResolvedValue(USER);
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { zn_refresh: "abc" } });
    expect(res.statusCode).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith("abc");
    expect(String(res.headers["set-cookie"])).toMatch(/zn_refresh=;/);
  });

  it("logout is idempotent without a cookie", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("requireOrgMember joins users.active; disabled user gets 403", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await h.request("GET", "/api/v1/websites", { token, orgId: ORG });
    expect(res.statusCode).toBe(403);
    expect(mocks.query.mock.calls[0][0]).toMatch(/u\.active = TRUE/);
  });

  const bad = "not-a-uuid";
  it.each([
    `/api/v1/websites/${bad}`, `/api/v1/websites/${bad}/scans`,
    `/api/v1/ai/evidence/${bad}`, `/api/v1/ai/evidence/${bad}/lineage`, `/api/v1/ai/tasks/${bad}/evidence`,
    `/api/v1/ai/findings/${bad}/evidence`, `/api/v1/ai/tasks/${bad}/quality`, `/api/v1/ai/executions/${bad}/quality`,
    `/api/v1/ai/quality/${bad}`, `/api/v1/ai/tasks/${bad}/regeneration`, `/api/v1/ai/regeneration/${bad}`,
    `/api/v1/ai/instruction-plans/${bad}`, `/api/v1/models/${bad}`, `/api/v1/routing/decisions/${bad}`,
    `/api/v1/reports/${bad}`, `/api/v1/${bad}/cross-domain`, `/api/v1/${bad}/remediation`,
  ])("GET %s -> 400 VALIDATION_ERROR without DB access", async (url) => {
    const res = await h.request("GET", url, { token, orgId: ORG });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([`/api/v1/remediation/${bad}/approve`, `/api/v1/remediation/${bad}/reject`, `/api/v1/websites/${bad}/verify`, `/api/v1/models/${bad}/enable`])(
    "POST %s -> 400 without DB access", async (url) => {
      const res = await h.request("POST", url, { token, orgId: ORG, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled();
    });
});
