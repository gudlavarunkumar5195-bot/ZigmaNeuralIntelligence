import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Platform admins, the credential account and the encryption key ring are set
// before the app (and therefore config) is first imported in this file.
const env = vi.hoisted(() => {
  const ids = { admin: crypto.randomUUID(), admin2: crypto.randomUUID() };
  process.env.PLATFORM_ADMIN_USER_IDS = `${ids.admin},${ids.admin2}`;
  process.env.INTEGRATION_ENCRYPTION_KEYS = `k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
  process.env.ADMIN_CREDENTIAL_ACCOUNT_EMAIL = `generated-${ids.admin.slice(0, 8)}@http-test.example`;
  delete process.env.OPENROUTER_API_KEY;
  return ids;
});

// OpenRouter is faked by key: the key text decides the provider's answer.
vi.mock("../platform/provider-http.js", async () => {
  const actual = await vi.importActual<typeof import("../platform/provider-http.js")>("../platform/provider-http.js");
  const answers: Record<string, number> = { valid: 200, bad: 401, quota: 402 };
  return {
    ...actual,
    providerRequest: vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      const key = init.headers.authorization.replace("Bearer ", "");
      const kind = (globalThis as { __orMode?: Record<string, string> }).__orMode?.[key] ?? key.split("-")[2];
      if (kind === "outage") return { status: 503, body: null };
      return { status: answers[kind] ?? 500, body: { data: { is_free_tier: true, limit: null, limit_remaining: null, usage: 0 } } };
    }),
  };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

const orMode = ((globalThis as { __orMode?: Record<string, string> }).__orMode = {} as Record<string, string>);

describe.skipIf(!INTEGRATION)("Admin Control Center (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let adminToken: string;
  const logs: string[] = [];
  const admin = () => ({ token: adminToken });

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    A = await seedOrg(h, "acc-a");
    B = await seedOrg(h, "acc-b");
    for (const [id, label] of [[env.admin, "one"], [env.admin2, "two"]]) {
      await db.query("INSERT INTO users (id, email, password_hash, full_name) VALUES ($1,$2,'!x',$3)", [id, `platform-${label}-${id}@http-test.example`, `Platform ${label}`]);
    }
    adminToken = h.mintToken({ id: env.admin, email: `platform-one-${env.admin}@http-test.example` });
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  });
  afterAll(async () => {
    await db?.query("DELETE FROM platform_credentials WHERE provider = 'openrouter'");
    await db?.query("DELETE FROM platform_integration_checks WHERE checked_by = ANY($1::uuid[])", [[env.admin, env.admin2]]);
    const generated = await db?.query<{ org_id: string }>("SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [process.env.ADMIN_CREDENTIAL_ACCOUNT_EMAIL]);
    await cleanupOrgs([A?.id, B?.id, ...(generated?.rows.map((r) => r.org_id) ?? [])].filter(Boolean) as string[]);
    await h?.close();
  });
  afterEach(() => {
    for (const k of Object.keys(orMode)) delete orMode[k];
  });

  describe("authorization", () => {
    it("denies unauthenticated callers, tenant owners and disabled admins on every admin route", async () => {
      const routes: Array<["GET" | "POST" | "PUT", string, unknown?]> = [
        ["GET", "/api/v1/admin/diagnostics"],
        ["GET", "/api/v1/admin/integrations"],
        ["PUT", "/api/v1/admin/integrations/openrouter/credential", { secret: "sk-or-valid-aaaa1111" }],
        ["GET", "/api/v1/admin/users"],
        ["POST", "/api/v1/admin/account-credentials", { email: process.env.ADMIN_CREDENTIAL_ACCOUNT_EMAIL }],
        ["GET", "/api/v1/admin/diagnostics/export"],
      ];
      for (const [method, url, payload] of routes) {
        expect((await h.request(method, url, { payload })).statusCode).toBe(401);
        const owner = await h.request(method, url, { token: A.users.owner.token, orgId: A.id, payload });
        expect(owner.statusCode).toBe(403);
        expect(owner.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
      }
      await db.query("UPDATE users SET active = FALSE WHERE id = $1", [env.admin2]);
      const disabled = await h.request("GET", "/api/v1/admin/users", { token: h.mintToken({ id: env.admin2, email: "x@http-test.example" }) });
      expect(disabled.json().error.code).toBe("ACCOUNT_DISABLED");
      await db.query("UPDATE users SET active = TRUE WHERE id = $1", [env.admin2]);
      // The UI flag comes from the same list.
      expect((await h.request("GET", "/api/v1/auth/me", admin())).json().data.isPlatformAdmin).toBe(true);
      expect((await h.request("GET", "/api/v1/auth/me", { token: A.users.owner.token })).json().data.isPlatformAdmin).toBe(false);
    });
  });

  describe("integration credentials", () => {
    const { resolveSecret } = { resolveSecret: async () => (await import("../platform/credential-store.js")).resolveSecret("openrouter") };
    const orInfo = async () => (await h.request("GET", "/api/v1/admin/integrations", admin())).json().data.find((i: { id: string }) => i.id === "openrouter");

    it("stores a validated key encrypted, activates AI, and never returns or logs it", async () => {
      expect((await orInfo()).credential).toMatchObject({ source: null, stored: false });
      const { getOxAlphaExecutor } = await import("../ai/ox-alpha.js");
      expect(getOxAlphaExecutor()).toBeNull();

      const secret = "sk-or-valid-0123456789abcdef1111";
      const r = await h.request("PUT", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { secret } });
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.json().data.result.status).toBe("valid");
      expect(r.json().data.integration).toMatchObject({ featureEnabled: true, credential: { source: "admin", stored: true, suffix: "1111", enabled: true, status: "valid" } });
      expect(r.body).not.toContain(secret);
      expect(getOxAlphaExecutor()).not.toBeNull();
      expect((await resolveSecret())?.secret).toBe(secret);

      const row = (await db.query<{ secret_enc: string; key_id: string }>("SELECT secret_enc, key_id FROM platform_credentials WHERE provider='openrouter'")).rows[0];
      expect(row.secret_enc).not.toContain(secret);
      expect(row.key_id).toBe("k1");
      const list = await h.request("GET", "/api/v1/admin/integrations", admin());
      expect(list.body).not.toContain(secret);
      const audits = await db.query<{ m: string }>("SELECT COALESCE(metadata::text,'') AS m FROM audit_log WHERE user_id = $1", [env.admin]);
      expect(audits.rows.some((a) => a.m.includes("sk-or-valid-0123"))).toBe(false);
      expect(logs.join("\n")).not.toContain(secret);
    });

    it("a rejected, over-quota or unverifiable replacement keeps the working key", async () => {
      for (const [secret, status, http] of [["sk-or-bad-zzzzzzzz2222", "invalid", 422], ["sk-or-quota-zzzzzz3333", "quota_exceeded", 422], ["sk-or-outage-zzzzz4444", "unavailable", 503]] as const) {
        const r = await h.request("PUT", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { secret } });
        expect(r.statusCode).toBe(http);
        expect(r.json().error).toMatchObject({ code: "CREDENTIAL_NOT_VERIFIED", details: { status, previousCredentialKept: true } });
        expect(r.body).not.toContain(secret);
        expect((await orInfo()).credential.suffix).toBe("1111");
        expect((await resolveSecret())?.secret).toBe("sk-or-valid-0123456789abcdef1111");
      }
      expect((await h.request("PUT", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { secret: "short" } })).json().error.code).toBe("CREDENTIAL_MALFORMED");
      expect((await h.request("PUT", "/api/v1/admin/integrations/postgres/credential", { ...admin(), payload: { secret: "whatever-long-enough" } })).json().error.code).toBe("NOT_ADMIN_MANAGED");
    });

    it("an outage keeps the stored key in use; a provider rejection stops it until it passes again", async () => {
      orMode["sk-or-valid-0123456789abcdef1111"] = "outage";
      const outage = (await h.request("POST", "/api/v1/admin/integrations/openrouter/test", admin())).json().data;
      expect(outage.result.status).toBe("unavailable");
      expect(outage.integration.featureEnabled).toBe(true);
      expect((await resolveSecret())).not.toBeNull();

      orMode["sk-or-valid-0123456789abcdef1111"] = "bad";
      const rejected = (await h.request("POST", "/api/v1/admin/integrations/openrouter/test", admin())).json().data;
      expect(rejected.result.status).toBe("invalid");
      expect(rejected.integration).toMatchObject({ featureEnabled: false, credential: { stored: true, status: "invalid" } });
      expect(await resolveSecret()).toBeNull();
      expect((await h.request("POST", "/api/v1/admin/integrations/openrouter/enable", admin())).json().error.code).toBe("CREDENTIAL_REJECTED");

      delete orMode["sk-or-valid-0123456789abcdef1111"];
      const back = (await h.request("POST", "/api/v1/admin/integrations/openrouter/test", admin())).json().data;
      expect(back.integration).toMatchObject({ featureEnabled: true, credential: { status: "valid" } });
      expect(back.integration.lastSuccessAt).not.toBeNull();
    });

    it("disable, enable, rotate and remove", async () => {
      expect((await h.request("POST", "/api/v1/admin/integrations/openrouter/disable", admin())).json().data.featureEnabled).toBe(false);
      expect(await resolveSecret()).toBeNull();
      expect((await h.request("POST", "/api/v1/admin/integrations/openrouter/enable", admin())).json().data.featureEnabled).toBe(true);
      const rotated = await h.request("PUT", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { secret: "sk-or-valid-rotatedkey5555" } });
      expect(rotated.json().data.integration.credential.suffix).toBe("5555");
      expect((await resolveSecret())?.secret).toBe("sk-or-valid-rotatedkey5555");
      expect((await h.request("DELETE", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: {} })).statusCode).toBe(400); // confirmation required
      const removed = await h.request("DELETE", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { confirm: true } });
      expect(removed.json().data).toMatchObject({ removed: true, integration: { featureEnabled: false, credential: { stored: false } } });
      expect(await resolveSecret()).toBeNull();
    });

    it("refuses to store anything without the encryption key ring", async () => {
      const saved = process.env.INTEGRATION_ENCRYPTION_KEYS;
      delete process.env.INTEGRATION_ENCRYPTION_KEYS;
      try {
        const r = await h.request("PUT", "/api/v1/admin/integrations/openrouter/credential", { ...admin(), payload: { secret: "sk-or-valid-nokeyring6666" } });
        expect(r.statusCode).toBe(503);
        expect(r.json().error.code).toBe("ENCRYPTION_NOT_CONFIGURED");
        expect((await db.query("SELECT 1 FROM platform_credentials WHERE provider='openrouter'")).rows).toHaveLength(0);
      } finally {
        process.env.INTEGRATION_ENCRYPTION_KEYS = saved;
      }
    });

    it("deployment-managed integrations report real check results, never assumed health", async () => {
      const google = (await h.request("POST", "/api/v1/admin/integrations/google_oauth/test", admin())).json().data;
      expect(google.result.status).toBe("not_configured");
      const pg = (await h.request("POST", "/api/v1/admin/integrations/postgres/test", admin())).json().data;
      expect(pg.result.status).toBe("valid");
      const enc = (await h.request("POST", "/api/v1/admin/integrations/encryption/test", admin())).json().data;
      expect(enc.result.status).toBe("valid");
      const email = (await h.request("POST", "/api/v1/admin/integrations/email/test", admin()));
      expect(email.json().error.code).toBe("NOT_TESTABLE");
      const list = (await h.request("GET", "/api/v1/admin/integrations", admin())).json().data;
      expect(list.find((i: { id: string }) => i.id === "email")).toMatchObject({ management: "unsupported", configured: false, featureEnabled: false });
      expect(list.find((i: { id: string }) => i.id === "postgres").lastCheck.status).toBe("valid");
    });
  });

  describe("users and access", () => {
    it("lists and searches users with memberships and platform-admin flags", async () => {
      const r = await h.request("GET", `/api/v1/admin/users?search=${encodeURIComponent(A.users.member.email)}`, admin());
      expect(r.json().data).toEqual([expect.objectContaining({ id: A.users.member.id, active: true, isPlatformAdmin: false, memberships: [expect.objectContaining({ orgId: A.id, role: "member" })] })]);
      expect(r.body).not.toMatch(/password_hash|!not-a-real-hash/);
      const page = await h.request("GET", "/api/v1/admin/users?limit=2", admin());
      expect(page.json().data).toHaveLength(2);
      expect(page.json().meta.nextCursor).toBeTruthy();
    });

    it("deactivation revokes sessions and cuts org access at once; activation restores it", async () => {
      const { createRefreshToken } = await import("../services/auth.service.js");
      await createRefreshToken(A.users.member.id);
      expect((await h.request("GET", "/api/v1/websites", { token: A.users.member.token, orgId: A.id })).statusCode).toBe(200);
      expect((await h.request("POST", `/api/v1/admin/users/${A.users.member.id}/deactivate`, { ...admin(), payload: {} })).statusCode).toBe(400);
      const off = await h.request("POST", `/api/v1/admin/users/${A.users.member.id}/deactivate`, { ...admin(), payload: { confirm: true } });
      expect(off.json().data.revokedSessions).toBe(1);
      expect((await h.request("GET", "/api/v1/websites", { token: A.users.member.token, orgId: A.id })).statusCode).toBe(403);
      await h.request("POST", `/api/v1/admin/users/${A.users.member.id}/activate`, { ...admin(), payload: { confirm: true } });
      expect((await h.request("GET", "/api/v1/websites", { token: A.users.member.token, orgId: A.id })).statusCode).toBe(200);
      const events = (await h.request("GET", `/api/v1/admin/users/${A.users.member.id}`, admin())).json().data.events.map((e: { action: string }) => e.action);
      expect(events).toEqual(expect.arrayContaining(["admin_user_deactivated", "admin_user_activated"]));
    });

    it("never lets an admin lock themselves or the platform out", async () => {
      const self = await h.request("POST", `/api/v1/admin/users/${env.admin}/deactivate`, { ...admin(), payload: { confirm: true } });
      expect(self.json().error.code).toBe("CANNOT_DEACTIVATE_SELF");
      // Defense in depth below the API: with the other admin inactive, the remaining one cannot be deactivated.
      const { setUserActive } = await import("../platform/users.js");
      await db.query("UPDATE users SET active = FALSE WHERE id = $1", [env.admin]);
      await expect(setUserActive(randomUUID(), env.admin2, false)).rejects.toMatchObject({ code: "LAST_PLATFORM_ADMIN" });
      await db.query("UPDATE users SET active = TRUE WHERE id = $1", [env.admin]);
    });

    it("role changes keep an owner in every organization and respect organization boundaries", async () => {
      const demote = (userId: string, orgId: string, role: string) => h.request("PATCH", `/api/v1/admin/users/${userId}/memberships/${orgId}`, { ...admin(), payload: { role, confirm: true } });
      expect((await demote(A.users.owner.id, A.id, "admin")).json().error.code).toBe("LAST_OWNER");
      expect((await demote(A.users.admin.id, A.id, "owner")).json().data).toEqual({ from: "admin", to: "owner" });
      expect((await demote(A.users.owner.id, A.id, "admin")).json().data).toEqual({ from: "owner", to: "admin" });
      // A user of org A has no membership in org B.
      expect((await demote(A.users.member.id, B.id, "admin")).json().error.code).toBe("MEMBERSHIP_NOT_FOUND");
      const audit = await db.query("SELECT org_id FROM audit_log WHERE action = 'admin_role_changed' AND resource_id = $1 AND result = 'success'", [A.users.owner.id]);
      expect(audit.rows[0].org_id).toBe(A.id);
    });

    it("session revocation, and password-reset emails refuse to run without an email provider", async () => {
      const { createRefreshToken } = await import("../services/auth.service.js");
      await createRefreshToken(B.users.viewer.id);
      await createRefreshToken(B.users.viewer.id);
      const r = await h.request("POST", `/api/v1/admin/users/${B.users.viewer.id}/revoke-sessions`, { ...admin(), payload: { confirm: true } });
      expect(r.json().data.revokedSessions).toBe(2);
      const reset = await h.request("POST", `/api/v1/admin/users/${B.users.viewer.id}/password-reset`, { ...admin(), payload: { confirm: true } });
      expect(reset.statusCode).toBe(503);
      expect(reset.json().error.code).toBe("EMAIL_NOT_CONFIGURED");
      expect((await db.query("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [B.users.viewer.id])).rows).toHaveLength(0);
    });
  });

  describe("password reset tokens", () => {
    it("single use, hashed at rest, expiring, and revoking every session", async () => {
      const auth = await import("../services/auth.service.js");
      const user = A.users.viewer;
      await auth.createRefreshToken(user.id);
      const raw = await auth.createPasswordResetToken(user.id, null);
      const stored = (await db.query<{ token_hash: string }>("SELECT token_hash FROM password_reset_tokens WHERE user_id = $1", [user.id])).rows[0];
      expect(stored.token_hash).not.toContain(raw);
      expect(stored.token_hash).toHaveLength(64);

      const tooLong = await h.request("POST", "/api/v1/auth/password-reset/confirm", { payload: { token: raw, password: "é".repeat(40) } });
      expect(tooLong.statusCode).toBe(400);
      const ok = await h.request("POST", "/api/v1/auth/password-reset/confirm", { payload: { token: raw, password: "New-password-123" } });
      expect(ok.statusCode).toBe(200);
      expect((await h.request("POST", "/api/v1/auth/login", { payload: { email: user.email, password: "New-password-123" } })).statusCode).toBe(200);
      const sessions = await db.query("SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
      expect(sessions.rows).toHaveLength(1); // only the login above
      const reuse = await h.request("POST", "/api/v1/auth/password-reset/confirm", { payload: { token: raw, password: "Another-pass-456" } });
      expect(reuse.json().error.code).toBe("RESET_TOKEN_INVALID");

      const expired = await auth.createPasswordResetToken(user.id, null, new Date(Date.now() - auth.PASSWORD_RESET_TTL_MS - 1000));
      expect((await h.request("POST", "/api/v1/auth/password-reset/confirm", { payload: { token: expired, password: "Another-pass-456" } })).json().error.code).toBe("RESET_TOKEN_INVALID");
      const events = await db.query<{ m: string }>("SELECT COALESCE(metadata::text,'') AS m FROM audit_log WHERE user_id = $1", [user.id]);
      expect(events.rows.some((e) => e.m.includes(raw) || e.m.includes("New-password-123"))).toBe(false);
      expect(logs.join("\n")).not.toContain(raw);
    });

    it("the request endpoint answers identically for known and unknown emails", async () => {
      const known = await h.request("POST", "/api/v1/auth/password-reset/request", { payload: { email: A.users.admin.email } });
      const unknown = await h.request("POST", "/api/v1/auth/password-reset/request", { payload: { email: `nobody-${randomUUID()}@http-test.example` } });
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
    });
  });

  describe("generate login credentials", () => {
    const email = () => process.env.ADMIN_CREDENTIAL_ACCOUNT_EMAIL!;
    const generate = (confirmReset = false, token = adminToken) => h.request("POST", "/api/v1/admin/account-credentials", { token, payload: { email: email(), confirmReset } });
    const ageGenerationEvents = () => db.query("UPDATE audit_log SET timestamp = timestamp - interval '1 minute' WHERE action = 'admin_credentials_generated'");

    it("only for the designated account, only for platform admins", async () => {
      const other = await h.request("POST", "/api/v1/admin/account-credentials", { ...admin(), payload: { email: A.users.owner.email } });
      expect(other.json().error.code).toBe("ACCOUNT_NOT_ALLOWED");
      expect((await generate(false, A.users.owner.token)).statusCode).toBe(403);
      expect((await h.request("GET", "/api/v1/admin/account-credentials", admin())).json().data).toMatchObject({ email: email(), exists: false });
    });

    it("creates the account through normal provisioning with a strong, bcrypt-hashed password shown once", async () => {
      const r = await generate();
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const { password, created, accountActive } = r.json().data;
      expect({ created, accountActive }).toEqual({ created: true, accountActive: true });
      expect(password).toMatch(/^[A-Za-z2-9!#%+\-=?@_]{20}$/);
      const user = (await db.query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = $1", [email()])).rows[0];
      expect(user.password_hash).toMatch(/^\$2[aby]\$12\$/);
      expect(user.password_hash).not.toContain(password);
      expect((await db.query("SELECT role FROM memberships WHERE user_id = $1", [user.id])).rows).toEqual([{ role: "owner" }]);
      expect((await h.request("POST", "/api/v1/auth/login", { payload: { email: email(), password } })).statusCode).toBe(200);
      const audits = await db.query<{ m: string }>("SELECT COALESCE(metadata::text,'') AS m FROM audit_log WHERE action = 'admin_credentials_generated'");
      expect(audits.rows.length).toBeGreaterThan(0);
      expect(audits.rows.some((a) => a.m.includes(password))).toBe(false);
      expect(logs.join("\n")).not.toContain(password);
    });

    it("refuses a double click, asks before resetting, then replaces the password and signs out sessions", async () => {
      expect((await generate(true)).json().error.code).toBe("RECENTLY_GENERATED");
      await ageGenerationEvents();
      const ask = await generate(false);
      expect(ask.statusCode).toBe(409);
      expect(ask.json().error).toMatchObject({ code: "CONFIRMATION_REQUIRED", details: { exists: true, active: true } });
      expect(ask.body).not.toMatch(/"password"/);

      const before = (await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [email()])).rows[0].password_hash;
      const r = await generate(true);
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ created: false, revokedSessions: 1 });
      const after = (await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [email()])).rows[0].password_hash;
      expect(after).not.toBe(before);
      expect((await h.request("POST", "/api/v1/auth/login", { payload: { email: email(), password: r.json().data.password } })).statusCode).toBe(200);
    });

    it("concurrent confirmed requests produce exactly one password", async () => {
      await ageGenerationEvents();
      const results = await Promise.all([generate(true), generate(true), generate(true)]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409, 409]);
      expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === "RECENTLY_GENERATED")).toBe(true);
    });
  });

  describe("diagnostics", () => {
    it("reports measured state: database latency, migrations, jobs, and a worker that is not running here", async () => {
      const d = (await h.request("GET", "/api/v1/admin/diagnostics", admin())).json().data;
      expect(d.database).toMatchObject({ status: "ok" });
      expect(typeof d.database.latencyMs).toBe("number");
      expect(d.migrations.status).toBe("up_to_date");
      expect(d.worker.status).toBe("not_running_in_this_process");
      expect(d.jobs.scans).toBeTypeOf("object");
      expect(d.configurationWarnings.map((w: { message: string }) => w.message).join(" ")).toMatch(/No email provider/);
    });

    it("shows recorded server errors without request details", async () => {
      const { recordServerError } = await import("../platform/error-log.js");
      recordServerError({ requestId: "req-diag-1", method: "GET", route: "/api/v1/scans/:id", statusCode: 500, errorClass: "TypeError" });
      const d = (await h.request("GET", "/api/v1/admin/diagnostics", admin())).json().data;
      expect(d.serverErrors.errors[0]).toMatchObject({ requestId: "req-diag-1", route: "/api/v1/scans/:id", errorClass: "TypeError" });
    });

    it("retries only eligible jobs, idempotently", async () => {
      const id = (await db.query<{ id: string }>("INSERT INTO analytics_outbox (org_id, target_table, status, attempts, last_error) VALUES ($1,'scan_events','DEAD',20,'boom') RETURNING id::text", [A.id])).rows[0].id;
      const first = await h.request("POST", `/api/v1/admin/diagnostics/jobs/analytics_outbox/${id}/retry`, admin());
      expect(first.json().data.result).toEqual({ requeued: true });
      expect((await db.query("SELECT status, attempts FROM analytics_outbox WHERE id = $1", [id])).rows[0]).toEqual({ status: "PENDING", attempts: 0 });
      expect((await h.request("POST", `/api/v1/admin/diagnostics/jobs/analytics_outbox/${id}/retry`, admin())).json().error.code).toBe("NOT_RETRYABLE");
      expect((await h.request("POST", `/api/v1/admin/diagnostics/jobs/gsc_sync/${randomUUID()}/retry`, admin())).json().error.code).toBe("NOT_RETRYABLE");
      expect((await h.request("POST", `/api/v1/admin/diagnostics/jobs/scan/${A.scanId}/retry`, admin())).statusCode).toBe(400);
      await db.query("DELETE FROM analytics_outbox WHERE id = $1", [id]);
    });

    it("the export redacts secrets, emails and identifiers", async () => {
      const secretish = `Bearer ${randomBytes(24).toString("hex")} for ${A.users.owner.email}`;
      await db.query("INSERT INTO scans (website_id, org_id, triggered_by, status, modules, error) VALUES ($1,$2,$3,'failed','{seo}',$4)", [A.websiteId, A.id, A.users.owner.id, secretish]);
      const live = (await h.request("GET", "/api/v1/admin/diagnostics", admin())).json().data;
      expect(JSON.stringify(live.failedJobs)).not.toContain(A.users.owner.email);
      const r = await h.request("GET", "/api/v1/admin/diagnostics/export", admin());
      expect(r.headers["content-disposition"]).toMatch(/attachment; filename="zigmaneural-diagnostics-/);
      expect(r.body).not.toContain(A.users.owner.email);
      expect(r.body).not.toContain(secretish.split(" ")[1]);
      expect(r.body).not.toContain(A.id);
      expect(r.body).not.toContain(process.env.INTEGRATION_ENCRYPTION_KEYS!.slice(3));
    });
  });
});
