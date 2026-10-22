import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Google Search Console integration end to end: real Fastify app, real
// PostgreSQL, a programmable fake Google (no network, no credentials).
const { google } = vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.example.com/api/v1/integrations/google/oauth/callback";
  process.env.APP_PUBLIC_URL = "https://app.example.com";
  process.env.INTEGRATION_ENCRYPTION_KEYS = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.GSC_INITIAL_LOOKBACK_DAYS = "3";
  process.env.GSC_REVISIT_DAYS = "1";
  process.env.GSC_MAX_REQUESTS_PER_MINUTE = "600";
  type Res = { status: number; headers?: Record<string, string>; body: unknown };
  const g = {
    refreshToken: "1//refresh-token-secret",
    grantedScope: "openid email https://www.googleapis.com/auth/webmasters.readonly",
    refreshFails: false,
    sub: "google-sub-1",
    email: "owner@gmail.example",
    sites: [] as Array<{ siteUrl: string; permissionLevel: string }>,
    /** (siteUrl, body) -> response; default: no rows. */
    analytics: ((_site: string, _body: Record<string, unknown>): Res => ({ status: 200, body: { rows: [] } })) as (site: string, body: Record<string, unknown>) => Res,
    revoked: [] as string[],
    analyticsCalls: 0,
  };
  return { google: g };
});

vi.mock("../integrations/google/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integrations/google/http.js")>();
  const reply = (r: { status: number; headers?: Record<string, string>; body: unknown }) => ({ status: r.status, headers: new Headers(r.headers ?? {}), body: r.body });
  return {
    ...actual,
    googleRequest: async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
        const p = new URLSearchParams(init.body ?? "");
        if (p.get("grant_type") === "authorization_code") {
          if (p.get("code") === "bad-code") return reply({ status: 400, body: { error: "invalid_grant" } });
          if (!p.get("code_verifier")) return reply({ status: 400, body: { error: "invalid_request" } });
          return reply({ status: 200, body: { access_token: "ya29.access", expires_in: 3599, refresh_token: google.refreshToken, scope: google.grantedScope, token_type: "Bearer" } });
        }
        if (google.refreshFails) return reply({ status: 400, body: { error: "invalid_grant" } });
        return reply({ status: 200, body: { access_token: "ya29.refreshed", expires_in: 3599, scope: google.grantedScope } });
      }
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") {
        google.revoked.push(new URLSearchParams(init.body ?? "").get("token") ?? "");
        return reply({ status: 200, body: {} });
      }
      if (u.hostname === "openidconnect.googleapis.com") return reply({ status: 200, body: { sub: google.sub, email: google.email, email_verified: true } });
      if (u.pathname === "/webmasters/v3/sites") return reply({ status: 200, body: { siteEntry: google.sites } });
      const m = /^\/webmasters\/v3\/sites\/(.+)\/searchAnalytics\/query$/.exec(u.pathname);
      if (m) {
        google.analyticsCalls++;
        return reply(google.analytics(decodeURIComponent(m[1]), JSON.parse(init.body ?? "{}")));
      }
      return reply({ status: 404, body: {} });
    },
  };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("Google Search Console integration (PostgreSQL + HTTP, fake Google)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let gsc: typeof import("../services/search-console.service.js");
  let integrations: typeof import("../services/integrations.service.js");
  let siteA: string;
  let integrationId: string;
  let yesterday: string;
  const as = (role: "owner" | "admin" | "member" | "viewer", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });

  /** POST start, then GET callback with the cookie the start set. Returns the redirect target. */
  async function connect(opts: { role?: "owner" | "admin"; org?: SeededOrg; code?: string; error?: string; withCookie?: boolean; mutateState?: (s: string) => string } = {}) {
    const org = opts.org ?? A;
    const start = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as(opts.role ?? "owner", org), payload: { returnTo: "/settings/integrations" } });
    expect(start.statusCode).toBe(200);
    const auth = new URL(start.json().data.authorizationUrl);
    const setCookie = String(start.headers["set-cookie"]);
    const cookie = setCookie.split(";")[0];
    const state = (opts.mutateState ?? ((s) => s))(auth.searchParams.get("state")!);
    const q = new URLSearchParams({ state, ...(opts.error ? { error: opts.error } : { code: opts.code ?? "good-code" }) });
    const cb = await h.app.inject({ method: "GET", url: `/api/v1/integrations/google/oauth/callback?${q}`, headers: opts.withCookie === false ? {} : { cookie } });
    return { start, setCookie, state, callback: cb, location: new URL(String(cb.headers.location).replace("/#", "/")) };
  }
  const runAllSlices = async () => {
    for (let i = 0; i < 50; i++) {
      const job = await gsc.claimSyncJob();
      if (!job) return;
      await gsc.runSyncSlice(job, { deadline: Date.now() + 60_000 });
    }
  };
  const rowsFor = (siteUrl: string, body: Record<string, unknown>) => {
    const dims = body.dimensions as string[];
    const day = body.startDate as string;
    if (body.startRow !== 0) return { status: 200, body: { rows: [] } };
    if (dims.length === 1) return { status: 200, body: { rows: [{ keys: [day], clicks: 10, impressions: 100, ctr: 0.1, position: 4 }] } };
    const values: Record<string, string[]> = { query: ["shoes", "red shoes"], page: [`${siteUrl}a`], country: ["usa", "ind"], device: ["MOBILE"], searchAppearance: [] };
    return { status: 200, body: { rows: (values[dims[1]] ?? []).map((v, i) => ({ keys: [day, v], clicks: 5 - i, impressions: 50, ctr: (5 - i) / 50, position: 3 + i })) } };
  };
  const count = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "gsc-a");
    B = await seedOrg(h, "gsc-b");
    db = await import("../db/client.js");
    gsc = await import("../services/search-console.service.js");
    integrations = await import("../services/integrations.service.js");
    siteA = (await db.query<{ url: string }>("SELECT url FROM websites WHERE id=$1", [A.websiteId])).rows[0].url;
    yesterday = gsc.allowedRange().max;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
  });
  beforeEach(() => {
    google.refreshFails = false;
    google.grantedScope = "openid email https://www.googleapis.com/auth/webmasters.readonly";
    google.analytics = rowsFor;
    integrations.resetTokenCache();
  });

  describe("OAuth", () => {
    it("only owners/admins can start; the cookie is httpOnly, Lax and scoped to the callback", async () => {
      for (const role of ["member", "viewer"] as const) {
        expect((await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as(role), payload: {} })).statusCode).toBe(403);
      }
      const r = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as("admin"), payload: { returnTo: "https://evil.example/" } });
      expect(r.statusCode).toBe(400); // returnTo is an allowlisted app path only
      const ok = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as("admin"), payload: {} });
      const cookie = String(ok.headers["set-cookie"]);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/integrations\/google\/oauth\/callback/);
      // Only hashes are stored.
      const state = new URL(ok.json().data.authorizationUrl).searchParams.get("state")!;
      expect(await count("SELECT COUNT(*)::text AS n FROM oauth_states WHERE state_hash = $1", [state])).toBe(0);
    });

    it("rejects a callback from another browser, a forged or replayed state, and an expired state", async () => {
      const noCookie = await connect({ withCookie: false });
      expect(noCookie.location.searchParams.get("reason")).toBe("browser_mismatch");
      const forged = await connect({ mutateState: (s) => `${s}x` });
      expect(forged.location.searchParams.get("reason")).toBe("invalid_state");

      const first = await connect();
      expect(first.location.searchParams.get("gsc")).toBe("connected");
      const replay = await h.app.inject({ method: "GET", url: `/api/v1/integrations/google/oauth/callback?state=${first.state}&code=good-code`, headers: { cookie: first.setCookie.split(";")[0] } });
      expect(new URL(String(replay.headers.location).replace("/#", "/")).searchParams.get("reason")).toBe("invalid_state");

      const start = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as("owner"), payload: {} });
      const state = new URL(start.json().data.authorizationUrl).searchParams.get("state")!;
      await db.query("UPDATE oauth_states SET expires_at = NOW() - interval '1 minute' WHERE org_id = $1 AND used_at IS NULL", [A.id]);
      const expired = await h.app.inject({ method: "GET", url: `/api/v1/integrations/google/oauth/callback?state=${state}&code=good-code`, headers: { cookie: String(start.headers["set-cookie"]).split(";")[0] } });
      expect(new URL(String(expired.headers.location).replace("/#", "/")).searchParams.get("reason")).toBe("invalid_state");
    });

    it("redirects only to the configured app URL, with no token or code in it, whatever the request's Host", async () => {
      const r = await connect();
      expect(String(r.callback.headers.location).startsWith("https://app.example.com/#/settings/integrations?")).toBe(true);
      expect(String(r.callback.headers.location)).not.toMatch(/code|token|ya29|1\/\//);
      expect(r.callback.statusCode).toBe(303);
      expect(r.callback.headers["cache-control"]).toBe("no-store");
      const evil = await h.app.inject({ method: "GET", url: "/api/v1/integrations/google/oauth/callback?state=x", headers: { host: "evil.example" } });
      expect(String(evil.headers.location).startsWith("https://app.example.com/")).toBe(true);
    });

    it("reports cancellation, a denied Search Console scope (and revokes what was granted), and a failed code exchange", async () => {
      expect((await connect({ error: "access_denied" })).location.searchParams.get("gsc")).toBe("cancelled");
      expect((await connect({ error: "something<script>" })).location.searchParams.get("reason")).toBe("google_error");
      google.grantedScope = "openid email";
      const before = google.revoked.length;
      expect((await connect()).location.searchParams.get("reason")).toBe("scope_denied");
      expect(google.revoked.length).toBe(before + 1);
      expect((await connect({ code: "bad-code" })).location.searchParams.get("reason")).toBe("invalid_grant");
    });

    it("refuses the callback if the user lost their admin role during the flow", async () => {
      const start = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...as("admin"), payload: {} });
      await db.query("UPDATE memberships SET role = 'member' WHERE user_id = $1 AND org_id = $2", [A.users.admin.id, A.id]);
      const state = new URL(start.json().data.authorizationUrl).searchParams.get("state")!;
      const cb = await h.app.inject({ method: "GET", url: `/api/v1/integrations/google/oauth/callback?state=${state}&code=good-code`, headers: { cookie: String(start.headers["set-cookie"]).split(";")[0] } });
      expect(new URL(String(cb.headers.location).replace("/#", "/")).searchParams.get("reason")).toBe("forbidden");
      await db.query("UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND org_id = $2", [A.users.admin.id, A.id]);
    });

    it("stores the refresh token encrypted, one row per Google account, and never returns secrets", async () => {
      const row = (await db.query<{ id: string; refresh_token_enc: string; key_id: string; account_email: string; scopes: string[] }>(
        "SELECT id, refresh_token_enc, key_id, account_email, scopes FROM integrations WHERE org_id = $1", [A.id],
      )).rows;
      expect(row).toHaveLength(1); // reconnecting the same account updated the same row
      integrationId = row[0].id;
      expect(row[0].refresh_token_enc).not.toContain(google.refreshToken);
      expect(row[0].refresh_token_enc.startsWith("k1.")).toBe(true);
      expect(row[0].account_email).toBe("owner@gmail.example");
      const list = await h.request("GET", "/api/v1/integrations", as("viewer"));
      expect(list.statusCode).toBe(200);
      const text = list.body;
      for (const secret of [google.refreshToken, "ya29", "refresh_token", "client-secret", "test-client-secret"]) expect(text).not.toContain(secret);
      expect(list.json().data[0]).toMatchObject({ id: integrationId, account_email: "owner@gmail.example", status: "active" });
      expect(list.json().meta.googleSearchConsole).toEqual({ configured: true, missing: [] });
    });
  });

  describe("properties and linking", () => {
    it("lists properties from Google with their type and whether data is readable", async () => {
      const domain = new URL(siteA).hostname;
      google.sites = [
        { siteUrl: `sc-domain:${domain}`, permissionLevel: "siteOwner" },
        { siteUrl: `${siteA.replace(/\/?$/, "/")}`, permissionLevel: "siteUnverifiedUser" },
        { siteUrl: "https://other.example/", permissionLevel: "siteFullUser" },
      ];
      const r = await h.request("GET", `/api/v1/integrations/${integrationId}/properties`, as("admin"));
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toEqual(expect.arrayContaining([
        expect.objectContaining({ siteUrl: `sc-domain:${domain}`, propertyType: "domain", canReadData: true }),
        expect.objectContaining({ propertyType: "url_prefix", canReadData: false }),
      ]));
      expect((await h.request("GET", `/api/v1/integrations/${integrationId}/properties`, as("member"))).statusCode).toBe(403);
    });

    it("refuses a property that does not cover the website, one without data access, and unverified websites", async () => {
      const put = (siteUrl: string, websiteId = A.websiteId) => h.request("PUT", `/api/v1/websites/${websiteId}/search-console`, { ...as("owner"), payload: { integrationId, siteUrl } });
      expect((await put("https://other.example/")).json().error.code).toBe("PROPERTY_MISMATCH");
      expect((await put(`${siteA.replace(/\/?$/, "/")}`)).json().error.code).toBe("PROPERTY_ACCESS_DENIED");
      expect((await put("not-a-property")).json().error.code).toBe("INVALID_PROPERTY");
      const unverified = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,FALSE) RETURNING id", [A.id, `https://unverified-${Date.now()}.example`, "unverified.example"])).rows[0].id;
      expect((await put("sc-domain:unverified.example", unverified)).json().error.code).toBe("WEBSITE_NOT_VERIFIED");
      expect((await h.request("PUT", `/api/v1/websites/${A.websiteId}/search-console`, { ...as("member"), payload: { integrationId, siteUrl: "x" } })).statusCode).toBe(403);
    });

    it("links the property and queues the initial historical sync (one unit per dimension set per day)", async () => {
      const domain = new URL(siteA).hostname;
      const r = await h.request("PUT", `/api/v1/websites/${A.websiteId}/search-console`, { ...as("owner"), payload: { integrationId, siteUrl: `sc-domain:${domain}` } });
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ propertyType: "domain", permissionLevel: "siteOwner", job: { deduplicated: false, job: { kind: "initial", status: "queued", date_to: yesterday } } });
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_sync_units u JOIN gsc_sync_jobs j ON j.id=u.job_id WHERE j.org_id=$1", [A.id])).toBe(3 * 6);
      const status = (await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console`, as("viewer"))).json();
      expect(status.data).toMatchObject({ property: { site_url: `sc-domain:${domain}`, status: "active" }, integration: { account_email: "owner@gmail.example" }, activeJob: { kind: "initial" } });
      expect(status.meta.websiteVerified).toBe(true);
    });
  });

  describe("tenant isolation", () => {
    it("another organization gets 404 for every website, integration and job route", async () => {
      const foreign = as("owner", B);
      const jobId = (await db.query<{ id: string }>("SELECT id FROM gsc_sync_jobs WHERE org_id=$1 LIMIT 1", [A.id])).rows[0].id;
      for (const [method, url, payload] of [
        ["GET", `/api/v1/websites/${A.websiteId}/search-console`, undefined],
        ["PUT", `/api/v1/websites/${A.websiteId}/search-console`, { integrationId, siteUrl: "sc-domain:x.example" }],
        ["DELETE", `/api/v1/websites/${A.websiteId}/search-console`, undefined],
        ["POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, {}],
        ["GET", `/api/v1/websites/${A.websiteId}/search-console/sync-jobs`, undefined],
        ["POST", `/api/v1/websites/${A.websiteId}/search-console/sync-jobs/${jobId}/cancel`, undefined],
        ["GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${yesterday}&to=${yesterday}`, undefined],
        ["GET", `/api/v1/websites/${A.websiteId}/search-console/top/query?from=${yesterday}&to=${yesterday}`, undefined],
        ["GET", `/api/v1/integrations/${integrationId}/properties`, undefined],
        ["DELETE", `/api/v1/integrations/${integrationId}`, undefined],
      ] as const) {
        const res = await h.request(method, url, { ...foreign, payload });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      // B cannot attach A's Google connection to its own website.
      const steal = await h.request("PUT", `/api/v1/websites/${B.websiteId}/search-console`, { ...foreign, payload: { integrationId, siteUrl: "sc-domain:x.example" } });
      expect(steal.json().error.code).toBe("INTEGRATION_NOT_FOUND");
      expect((await h.request("GET", "/api/v1/integrations", foreign)).json().data).toEqual([]);
    });
  });

  describe("sync engine", () => {
    it("ingests every unit, records coverage and data state, and a re-run is idempotent", async () => {
      google.analytics = (site, body) => {
        const r = rowsFor(site, body);
        return { ...r, body: { ...(r.body as object), metadata: { first_incomplete_date: yesterday } } };
      };
      await runAllSlices();
      const job = (await db.query("SELECT status, units_done, units_failed FROM gsc_sync_jobs WHERE org_id=$1 AND kind='initial'", [A.id])).rows[0];
      expect(job).toEqual({ status: "completed", units_done: 18, units_failed: 0 });
      const totalRows = await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1", [A.id]);
      expect(totalRows).toBe(3 * (1 + 2 + 1 + 2 + 1 + 0));
      expect((await db.query("SELECT DISTINCT data_state FROM gsc_search_daily WHERE org_id=$1 AND day=$2", [A.id, yesterday])).rows).toEqual([{ data_state: "fresh" }]);
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_coverage WHERE org_id=$1", [A.id])).toBe(18);
      const prop = (await db.query("SELECT to_char(last_synced_through,'YYYY-MM-DD') AS d, last_sync_success_at FROM gsc_properties WHERE org_id=$1", [A.id])).rows[0];
      expect(prop.d).toBe(yesterday);
      expect(prop.last_sync_success_at).toBeTruthy();

      const again = await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: gsc.addDays(yesterday, -2), to: yesterday } });
      expect(again.statusCode).toBe(202);
      await runAllSlices();
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1", [A.id])).toBe(totalRows);
    });

    it("never wipes stored data with an empty answer or a failed request", async () => {
      const before = await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1", [A.id]);
      google.analytics = () => ({ status: 200, body: { rows: [] } });
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: yesterday, to: yesterday } });
      await runAllSlices();
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1", [A.id])).toBe(before);
      expect((await db.query("SELECT outcome FROM gsc_coverage WHERE org_id=$1 AND day=$2 AND dimension_set='query'", [A.id, yesterday])).rows[0].outcome).toBe("kept_previous");

      google.analytics = () => ({ status: 400, body: { error: { message: "bad" } } });
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: yesterday, to: yesterday } });
      await runAllSlices();
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1", [A.id])).toBe(before);
      const last = (await db.query("SELECT id, status, units_failed, error_code FROM gsc_sync_jobs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1", [A.id])).rows[0];
      expect(last).toMatchObject({ status: "failed", units_failed: 6, error_code: "ALL_FETCHES_FAILED" });
      const failures = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/sync-jobs/${last.id}/failures`, as("viewer"));
      expect(failures.json().data).toHaveLength(6);
      expect(failures.json().data[0]).toMatchObject({ error_code: "BAD_REQUEST" });
    });

    it("pages by 25,000 rows and marks a day truncated at Google's 50,000-row limit", async () => {
      google.analytics = (_site, body) => {
        const dims = body.dimensions as string[];
        if (dims[1] !== "query") return { status: 200, body: { rows: [] } };
        const start = Number(body.startRow);
        return { status: 200, body: { rows: Array.from({ length: 25_000 }, (_, i) => ({ keys: [body.startDate, `q${start + i}`], clicks: 0, impressions: 1, ctr: 0, position: 9 })) } };
      };
      const day = gsc.addDays(yesterday, -10);
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: day, to: day } });
      await runAllSlices();
      expect((await db.query("SELECT outcome, row_count FROM gsc_coverage WHERE org_id=$1 AND day=$2 AND dimension_set='query'", [A.id, day])).rows[0]).toEqual({ outcome: "truncated", row_count: 50_000 });
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE org_id=$1 AND day=$2 AND dimension_set='query'", [A.id, day])).toBe(50_000);
    }, 60_000);

    it("concurrent sync requests create one job; queued jobs can be cancelled", async () => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: {} })));
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 202]);
      expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(1);
      expect(await count("SELECT COUNT(*)::text AS n FROM gsc_sync_jobs WHERE org_id=$1 AND status IN ('queued','running')", [A.id])).toBe(1);
      const id = responses[0].json().data.id;
      const cancel = await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync-jobs/${id}/cancel`, as("member"));
      expect(cancel.json().data).toMatchObject({ status: "cancelled" });
      expect((await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync-jobs/${id}/cancel`, as("member"))).json().error.code).toBe("SYNC_NOT_ACTIVE");
      expect((await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("viewer"), payload: {} })).statusCode).toBe(403);
      const bad = await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: "2000-01-01", to: "2000-01-02" } });
      expect(bad.json().error.code).toBe("DATE_RANGE_UNAVAILABLE");
    });

    it("a worker that dies mid-job is replaced: the lease expires and the next worker resumes from the checkpoint", async () => {
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: gsc.addDays(yesterday, -1), to: yesterday } });
      const job = (await gsc.claimSyncJob())!;
      // Process two units, then "crash" (no release; lease left to expire).
      let clock = 0;
      await gsc.runSyncSlice(job, { deadline: 2, now: () => clock++ });
      await db.query("UPDATE gsc_sync_jobs SET status='running', lease_owner=gen_random_uuid(), lease_until=NOW() - interval '1 second' WHERE id=$1", [job.id]);
      const done = await count("SELECT COUNT(*)::text AS n FROM gsc_sync_units WHERE job_id=$1 AND status='done'", [job.id]);
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThan(12);
      const callsBefore = google.analyticsCalls;
      await runAllSlices();
      const final = (await db.query("SELECT status, units_done, claims FROM gsc_sync_jobs WHERE id=$1", [job.id])).rows[0];
      expect(final).toMatchObject({ status: "completed", units_done: 12 });
      expect(final.claims).toBeGreaterThanOrEqual(2);
      // Completed units were not fetched again.
      expect(google.analyticsCalls - callsBefore).toBe(12 - done);
    });

    it("quota: the job pauses (re-queued later) instead of failing", async () => {
      google.analytics = () => ({ status: 429, headers: { "retry-after": "900" }, body: {} });
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: yesterday, to: yesterday } });
      const job = (await gsc.claimSyncJob())!;
      expect(await gsc.runSyncSlice(job, { deadline: Date.now() + 60_000 })).toBe("paused");
      const row = (await db.query("SELECT status, quota_pauses, units_failed, run_after > NOW() + interval '14 minutes' AS later FROM gsc_sync_jobs WHERE id=$1", [job.id])).rows[0];
      expect(row).toEqual({ status: "queued", quota_pauses: 1, units_failed: 0, later: true });
      expect(await gsc.claimSyncJob()).toBeNull(); // not before run_after
      await db.query("UPDATE gsc_sync_jobs SET status='cancelled' WHERE id=$1", [job.id]);
    });

    it("lost Google property access marks the link; a revoked refresh token asks for reauthorization", async () => {
      google.analytics = () => ({ status: 403, body: { error: { message: "User does not have sufficient permission", errors: [{ reason: "forbidden" }] } } });
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: yesterday, to: yesterday } });
      await runAllSlices();
      expect((await db.query("SELECT status FROM gsc_properties WHERE org_id=$1", [A.id])).rows[0].status).toBe("access_lost");
      expect((await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: {} })).json().error.code).toBe("PROPERTY_ACCESS_LOST");
      await db.query("UPDATE gsc_properties SET status='active' WHERE org_id=$1", [A.id]);

      // Access revoked at Google: the API rejects the cached access token, and
      // the forced refresh is refused (invalid_grant).
      google.refreshFails = true;
      google.analytics = () => ({ status: 401, body: { error: { message: "Invalid Credentials" } } });
      await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: { from: yesterday, to: yesterday } });
      await runAllSlices();
      expect((await db.query("SELECT status FROM integrations WHERE id=$1", [integrationId])).rows[0].status).toBe("reauth_required");
      const last = (await db.query("SELECT status, error_code FROM gsc_sync_jobs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1", [A.id])).rows[0];
      expect(last).toEqual({ status: "failed", error_code: "INTEGRATION_REAUTH_REQUIRED" });
      expect((await h.request("POST", `/api/v1/websites/${A.websiteId}/search-console/sync`, { ...as("member"), payload: {} })).json().error.code).toBe("INTEGRATION_REAUTH_REQUIRED");
      // Reconnecting the same Google account restores the same integration.
      google.refreshFails = false;
      expect((await connect()).location.searchParams.get("gsc")).toBe("connected");
      expect((await db.query("SELECT id, status FROM integrations WHERE org_id=$1", [A.id])).rows).toEqual([{ id: integrationId, status: "active" }]);
    });
  });

  describe("analytics from persisted data", () => {
    it("separates missing days, real zeros and rows Google did not return; compares two ranges", async () => {
      const from = gsc.addDays(yesterday, -4);
      // Day yesterday-3: fetched, Google returned no total row -> real zero.
      await db.query(
        `INSERT INTO gsc_coverage (property_id, org_id, dimension_set, day, outcome, row_count, data_state)
         SELECT id, org_id, 'total', $2::date, 'complete', 0, 'final' FROM gsc_properties WHERE org_id=$1 ON CONFLICT DO NOTHING`,
        [A.id, gsc.addDays(yesterday, -3)],
      );
      const r = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${from}&to=${yesterday}&compareFrom=${gsc.addDays(from, -5)}&compareTo=${gsc.addDays(from, -1)}`, as("viewer"));
      expect(r.statusCode).toBe(200);
      const { current, previous, comparison } = r.json().data;
      const byDate = Object.fromEntries(current.series.map((s: { date: string }) => [s.date, s]));
      expect(byDate[from]).toMatchObject({ state: "missing", clicks: null });
      expect(byDate[gsc.addDays(yesterday, -3)]).toMatchObject({ state: "complete", clicks: 0, impressions: 0 });
      expect(byDate[yesterday]).toMatchObject({ clicks: 10, impressions: 100 });
      expect(current.totals).toMatchObject({ clicks: 30, impressions: 300, ctr: 0.1, position: 4 });
      expect(current.coverage).toMatchObject({ days: 5, daysMissing: 1 });
      expect(previous.totals.clicks).toBeNull(); // nothing synced there: unknown, not zero
      expect(comparison.clicks).toEqual({ change: null, changePct: null });
      expect(r.json().meta).toMatchObject({ source: "google_search_console", searchType: "web" });

      const filtered = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${gsc.addDays(yesterday, -2)}&to=${yesterday}&query=red%20shoes`, as("viewer"));
      expect(filtered.json().data.current.totals).toMatchObject({ clicks: 12, impressions: 150 });
      const unknownQuery = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${yesterday}&to=${yesterday}&query=never-seen`, as("viewer"));
      expect(unknownQuery.json().data.current.series[0]).toMatchObject({ state: "not_returned", clicks: null });
    });

    it("validates dimensions, filters and ranges", async () => {
      const get = (qs: string) => h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/${qs}`, as("viewer"));
      expect((await get(`performance?from=${yesterday}&to=${yesterday}&query=a&page=b`)).json().error.code).toBe("UNSUPPORTED_DIMENSIONS");
      expect((await get(`top/hour?from=${yesterday}&to=${yesterday}`)).json().error.code).toBe("UNSUPPORTED_DIMENSIONS");
      expect((await get(`performance?from=${yesterday}&to=${gsc.addDays(yesterday, -1)}`)).json().error.code).toBe("INVALID_DATE_RANGE");
      expect((await get(`performance?from=2001-01-01&to=2001-01-02`)).json().error.code).toBe("INVALID_DATE_RANGE");
      expect((await get(`performance?from=2030-02-30&to=2030-03-01`)).statusCode).toBe(400);
      expect((await get(`performance?from=${yesterday}&to=${yesterday}&device=PHONE`)).statusCode).toBe(400);
      expect((await get(`top/query?from=${yesterday}&to=${yesterday}&sort=bogus`)).statusCode).toBe(400);
      expect((await get(`top/query?from=${yesterday}&to=${yesterday}&cursor=nope`)).statusCode).toBe(400);
    });

    it("top queries/pages/countries aggregate with stable keyset pagination, sorting and search", async () => {
      const from = gsc.addDays(yesterday, -2);
      const get = (qs: string) => h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/top/query?from=${from}&to=${yesterday}&${qs}`, as("viewer"));
      const firstRes = await get("limit=1");
      if (firstRes.statusCode !== 200) throw new Error(firstRes.body);
      const first = firstRes.json();
      expect(first.data).toEqual([expect.objectContaining({ key: "shoes", clicks: 15, impressions: 150, daysWithRows: 3 })]);
      const second = (await get(`limit=1&cursor=${encodeURIComponent(first.meta.nextCursor)}`)).json();
      expect(second.data.map((r: { key: string }) => r.key)).toEqual(["red shoes"]);
      expect(second.meta.nextCursor).toBeNull();
      // The cursor is tied to its sort.
      expect((await get(`limit=1&sort=impressions&cursor=${encodeURIComponent(first.meta.nextCursor)}`)).statusCode).toBe(400);
      expect((await get("sort=position&order=asc")).json().data.map((r: { key: string }) => r.key)).toEqual(["shoes", "red shoes"]);
      expect((await get("search=red")).json().data.map((r: { key: string }) => r.key)).toEqual(["red shoes"]);
      const countries = (await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/top/country?from=${from}&to=${yesterday}`, as("viewer"))).json();
      expect(countries.data.map((r: { key: string }) => r.key)).toEqual(["usa", "ind"]);
      expect(countries.meta.coverage.days).toBe(3);
    });
  });

  describe("disconnect", () => {
    it("revokes at Google and deletes the credential, the property link, jobs and stored data", async () => {
      const revokedBefore = google.revoked.length;
      expect((await h.request("DELETE", `/api/v1/integrations/${integrationId}`, as("member"))).statusCode).toBe(403);
      const r = await h.request("DELETE", `/api/v1/integrations/${integrationId}`, as("owner"));
      expect(r.json().data).toEqual({ revokedAtGoogle: true });
      expect(google.revoked.slice(revokedBefore)).toEqual([google.refreshToken]);
      for (const table of ["integrations", "gsc_properties", "gsc_sync_jobs", "gsc_coverage", "gsc_search_daily"]) {
        expect(await count(`SELECT COUNT(*)::text AS n FROM ${table} WHERE org_id=$1`, [A.id]), table).toBe(0);
      }
      const after = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${yesterday}&to=${yesterday}`, as("viewer"));
      expect(after.json().error.code).toBe("SEARCH_CONSOLE_NOT_LINKED");
    });
  });
});
