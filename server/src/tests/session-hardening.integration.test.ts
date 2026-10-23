import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { INTEGRATION, createHarness, type Harness } from "./helpers/http.js";

/** Phase 10 session hardening against a real database. */
describe.skipIf(!INTEGRATION)("session hardening (real database)", () => {
  let h: Harness;
  let userId: string;
  const email = `session-${Date.now()}@http-test.example`;

  beforeAll(async () => {
    h = await createHarness();
    const { query } = await import("../db/client.js");
    userId = (await query<{ id: string }>("INSERT INTO users (email, password_hash, full_name) VALUES ($1, '!x', 'Session test') RETURNING id", [email])).rows[0].id;
  });
  afterAll(async () => {
    const { query, closePool } = await import("../db/client.js");
    await query("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await h.close();
    await closePool();
  });

  const refresh = (raw: string) => h.request("POST", "/api/v1/auth/refresh", { headers: { cookie: `zn_refresh=${raw}` } });

  it("a just-rotated refresh token (second tab) gets a retryable 401 and does NOT revoke the session", async () => {
    const { createRefreshToken } = await import("../services/auth.service.js");
    const original = await createRefreshToken(userId);
    const first = await refresh(original);
    expect(first.statusCode).toBe(200);
    const rotated = /zn_refresh=([^;]+)/.exec(String(first.headers["set-cookie"]))![1];

    const late = await refresh(original); // the other tab, a moment later
    expect(late.statusCode).toBe(401);
    expect(late.json().error.code).toBe("REFRESH_TOKEN_ROTATED");
    expect((await refresh(rotated)).statusCode).toBe(200); // the current cookie still works
  });

  it("reuse of an old revoked token is still treated as theft and revokes every session", async () => {
    const { createRefreshToken } = await import("../services/auth.service.js");
    const { query } = await import("../db/client.js");
    const stolen = await createRefreshToken(userId);
    const first = await refresh(stolen);
    const current = /zn_refresh=([^;]+)/.exec(String(first.headers["set-cookie"]))![1];
    // Age the rotation beyond the grace window.
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NOT NULL", [userId]);

    const replay = await refresh(stolen);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("INVALID_REFRESH_TOKEN");
    expect((await refresh(current)).statusCode).toBe(401); // the legitimate session was revoked too
  });

  it("/auth/me refuses a still-valid access token of a deactivated user", async () => {
    const { query } = await import("../db/client.js");
    const token = h.mintToken({ id: userId, email });
    expect((await h.request("GET", "/api/v1/auth/me", { token })).statusCode).toBe(200);
    await query("UPDATE users SET active = FALSE WHERE id = $1", [userId]);
    expect((await h.request("GET", "/api/v1/auth/me", { token })).statusCode).toBe(401);
    await query("UPDATE users SET active = TRUE WHERE id = $1", [userId]);
  });

  it("accepts only HS256 access tokens", async () => {
    // Same secret, different HMAC algorithm: must be rejected now that HS256 is pinned.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "HS512", typ: "JWT" });
    const body = b64({ sub: userId, email, orgIds: [], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
    const sig = createHmac("sha512", process.env.JWT_SECRET!).update(`${head}.${body}`).digest("base64url");
    expect((await h.request("GET", "/api/v1/auth/me", { token: `${head}.${body}.${sig}` })).statusCode).toBe(401);
  });
});
