import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/http.js";

// These tests never reach the database: auth/org checks short-circuit first.
describe("HTTP auth (no database)", () => {
  let h: Harness;
  const fakeUser = { id: "00000000-0000-4000-8000-000000000001", email: "u@example.com" };
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/api/v1/websites"], ["POST", "/api/v1/websites"], ["GET", "/api/v1/scans/00000000-0000-4000-8000-000000000002"],
    ["POST", "/api/v1/scans"], ["POST", "/api/v1/scans/00000000-0000-4000-8000-000000000002/cancel"],
    ["GET", "/api/v1/monitoring"], ["POST", "/api/v1/monitoring"], ["GET", "/api/v1/models"],
    ["POST", "/api/v1/models/catalog/refresh"], ["GET", "/api/v1/agents"], ["POST", "/api/v1/agents/simulate"],
    ["GET", "/api/v1/routing/policy"], ["POST", "/api/v1/routing/policy"],
  ];

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h?.close(); });

  it.each(protectedRoutes)("%s %s without a token -> 401", async (method, url) => {
    const res = await h.request(method as "GET", url);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed token", async () => {
    const res = await h.request("GET", "/api/v1/websites", { token: "not.a.jwt", orgId: "x" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const { default: Fastify } = await import("fastify");
    const other = Fastify();
    await other.register((await import("@fastify/jwt")).default, { secret: "some-other-secret-value-0123456789abcdef" });
    const token = other.jwt.sign({ sub: fakeUser.id, email: fakeUser.email, orgIds: [] });
    await other.close();
    const res = await h.request("GET", "/api/v1/websites", { token, orgId: "x" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = h.mintToken(fakeUser, { expiresIn: "-10s" });
    const res = await h.request("GET", "/api/v1/websites", { token, orgId: "x" });
    expect(res.statusCode).toBe(401);
  });

  it("authenticated request without an organization -> 400 ORG_REQUIRED", async () => {
    const res = await h.request("GET", "/api/v1/websites", { token: h.mintToken(fakeUser) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ORG_REQUIRED");
  });

  it("unknown API route -> 404 JSON", async () => {
    const res = await h.request("GET", "/api/v1/does-not-exist");
    expect(res.statusCode).toBe(404);
  });

  it("login/register validation errors -> 400 without touching the database", async () => {
    const bad = await h.request("POST", "/api/v1/auth/login", { payload: { email: "nope" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
    const reg = await h.request("POST", "/api/v1/auth/register", { payload: { email: "a@b.co", password: "short", orgName: "x" } });
    expect(reg.statusCode).toBe(400);
  });

  it("sets security headers", async () => {
    const res = await h.request("GET", "/api/v1/websites");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("static serving and probes (no database)", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h?.close(); });

  it("missing hashed asset -> 404 JSON, never the SPA shell", async () => {
    const res = await h.request("GET", "/assets/Overview-STALEHASH.js");
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("dotfile probes -> 404", async () => {
    const res = await h.request("GET", "/.env");
    expect(res.statusCode).toBe(404);
  });

  it("/health is not rate limited", async () => {
    const res = await h.request("GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});
