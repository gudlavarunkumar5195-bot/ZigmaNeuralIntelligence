import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the Search Console integration building blocks. Google is
// never called: the HTTP module is replaced by a programmable fake.
const { google } = vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.example.com/api/v1/integrations/google/oauth/callback";
  process.env.INTEGRATION_ENCRYPTION_KEYS = `k1:${Buffer.alloc(32, 1).toString("base64")}`;
  return { google: { calls: [] as Array<{ url: string; init: Record<string, unknown> }>, handler: (async () => ({ status: 200, headers: new Headers(), body: {} })) as (url: string, init: Record<string, unknown>) => Promise<{ status: number; headers: Headers; body: unknown }> } };
});
vi.mock("../integrations/google/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integrations/google/http.js")>();
  return {
    ...actual,
    googleRequest: async (url: string, init: Record<string, unknown>) => {
      google.calls.push({ url, init });
      return google.handler(url, init);
    },
  };
});

import { decryptSecret, EncryptionUnavailableError, encryptSecret, parseKeyRing } from "../integrations/crypto.js";
import { validateGoogleIntegrationConfig, validateProductionSecurityConfig } from "../config-security.js";
import { buildAuthorizationUrl, googleOAuthStatus, OAUTH_SCOPES, pkceChallenge, refreshAccessToken, RefreshTokenRevokedError } from "../integrations/google/oauth.js";
import { GoogleNetworkError } from "../integrations/google/http.js";
import { GscApiError, GscClient, Pacer, propertyCoversWebsite, propertyType, QUOTA_BACKOFF_MS } from "../integrations/google/search-console.js";

const key = (n: number) => Buffer.alloc(32, n).toString("base64");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => ({ status, headers: new Headers(headers), body });

describe("credential encryption (AES-256-GCM, versioned keys)", () => {
  const ring = parseKeyRing(`k1:${key(1)},k2:${key(2)}`)!;

  it("round-trips, uses the active key and binds ciphertext to its row", () => {
    const { ciphertext, keyId } = encryptSecret(ring, "1//refresh-token", "integration:org-a:i1");
    expect(keyId).toBe("k2"); // last listed is active by default
    expect(ciphertext).not.toContain("refresh");
    expect(ciphertext.split(".")).toHaveLength(4);
    expect(decryptSecret(ring, ciphertext, "integration:org-a:i1")).toBe("1//refresh-token");
    // Copying the value to another org's row does not decrypt.
    expect(() => decryptSecret(ring, ciphertext, "integration:org-b:i1")).toThrow();
    // Two encryptions of the same value differ (random IV).
    expect(encryptSecret(ring, "x", "a").ciphertext).not.toBe(encryptSecret(ring, "x", "a").ciphertext);
  });

  it("rotation: old ciphertexts decrypt while their key is listed, and fail clearly once it is removed", () => {
    const old = encryptSecret(parseKeyRing(`k1:${key(1)}`)!, "secret", "aad").ciphertext;
    expect(decryptSecret(ring, old, "aad")).toBe("secret");
    expect(() => decryptSecret(parseKeyRing(`k2:${key(2)}`)!, old, "aad")).toThrow(EncryptionUnavailableError);
  });

  it("rejects malformed key configuration and fails closed when no key is configured", () => {
    expect(parseKeyRing(undefined)).toBeNull();
    expect(() => parseKeyRing("k1:short")).toThrow(/32 bytes/);
    expect(() => parseKeyRing(`nokey${key(1)}`)).toThrow(/<id>:<base64 key>/);
    expect(() => parseKeyRing(`k1:${key(1)},k1:${key(2)}`)).toThrow(/duplicate/);
    expect(() => parseKeyRing(`k1:${key(1)}`, "k9")).toThrow(/not in INTEGRATION_ENCRYPTION_KEYS/);
    expect(() => encryptSecret(null, "x", "a")).toThrow(EncryptionUnavailableError);
    expect(() => decryptSecret(ring, "k2.bad", "a")).toThrow(/Malformed/);
  });
});

describe("production configuration for Google OAuth", () => {
  const base = { NODE_ENV: "production", DB_SSL_REJECT_UNAUTHORIZED: "true", JWT_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7", COOKIE_SECRET: "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3", CORS_ORIGIN: "https://app.example.com" };
  it("is optional, but once started must be complete, https and encrypted", () => {
    expect(() => validateProductionSecurityConfig({ ...base })).not.toThrow();
    expect(() => validateGoogleIntegrationConfig({ GOOGLE_OAUTH_CLIENT_ID: "x" })).toThrow(/missing GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI/);
    const full = { GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y", GOOGLE_OAUTH_REDIRECT_URI: "http://app.example.com/cb" };
    expect(() => validateGoogleIntegrationConfig(full)).toThrow(/https/);
    expect(() => validateGoogleIntegrationConfig({ ...full, GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.com/cb" })).toThrow(/INTEGRATION_ENCRYPTION_KEYS/);
    expect(() => validateGoogleIntegrationConfig({ ...full, GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.com/cb", INTEGRATION_ENCRYPTION_KEYS: "k1:bad" })).toThrow(/32 bytes/);
    expect(() => validateGoogleIntegrationConfig({ ...full, GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.com/cb", INTEGRATION_ENCRYPTION_KEYS: `k1:${key(3)}` })).not.toThrow();
  });

  it("reports which settings are missing by name, never by value", () => {
    expect(googleOAuthStatus({})).toEqual({ configured: false, missing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "INTEGRATION_ENCRYPTION_KEYS"] });
    expect(googleOAuthStatus().configured).toBe(true);
  });
});

describe("OAuth authorization URL and token refresh", () => {
  beforeEach(() => { google.calls.length = 0; });

  it("asks for read-only Search Console access, offline refresh, consent, PKCE S256 and the state", () => {
    const url = new URL(buildAuthorizationUrl({ state: "st4te", codeVerifier: "v".repeat(64) }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      client_id: "client-id.apps.googleusercontent.com", response_type: "code", access_type: "offline", prompt: "consent",
      state: "st4te", code_challenge_method: "S256", code_challenge: pkceChallenge("v".repeat(64)),
      redirect_uri: "https://app.example.com/api/v1/integrations/google/oauth/callback",
    });
    expect(p.scope.split(" ")).toEqual(OAUTH_SCOPES);
    expect(p.scope).toContain("webmasters.readonly");
    expect(p.scope).not.toMatch(/auth\/webmasters( |$)/); // never the read-write scope
  });

  it("treats invalid_grant on refresh as revoked (reauthorize), other failures as errors", async () => {
    google.handler = json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    await expect(refreshAccessToken("r")).rejects.toBeInstanceOf(RefreshTokenRevokedError);
    google.handler = json(200, { access_token: "ya29.x", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/webmasters.readonly" });
    const t = await refreshAccessToken("r", 1_000_000);
    expect(t).toMatchObject({ accessToken: "ya29.x", expiresAt: 1_000_000 + (3599 - 60) * 1000 });
    const body = new URLSearchParams(String(google.calls.at(-1)!.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
  });
});

describe("Search Console client: retries, errors, quota and pacing", () => {
  const sleeps: number[] = [];
  const tokens = { calls: [] as boolean[], async get(force = false) { this.calls.push(force); return force ? "fresh-token" : "old-token"; } };
  const client = () => new GscClient(tokens, { key: "i1", pacer: new Pacer(6_000, () => 0, async () => undefined), sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, maxAttempts: 3 });
  beforeEach(() => { google.calls.length = 0; sleeps.length = 0; tokens.calls.length = 0; });

  it("lists sites with their permission level", async () => {
    google.handler = json(200, { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://example.com/", permissionLevel: "siteUnverifiedUser" }, { bogus: true }] });
    expect(await client().listSites()).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://example.com/", permissionLevel: "siteUnverifiedUser" }]);
  });

  it("401: refreshes the token once and retries; a second 401 means reauthorization", async () => {
    let n = 0;
    google.handler = async () => (++n === 1 ? { status: 401, headers: new Headers(), body: {} } : { status: 200, headers: new Headers(), body: { rows: [] } });
    await client().searchAnalytics("sc-domain:example.com", { startDate: "2030-01-01", endDate: "2030-01-01", dimensions: ["date"] });
    expect(tokens.calls).toEqual([false, true]);
    expect(String((google.calls[1].init.headers as Record<string, string>).authorization)).toBe("Bearer fresh-token");
    google.handler = json(401, {});
    await expect(client().listSites()).rejects.toMatchObject({ kind: "auth" });
  });

  it("403 without a quota reason is a permission problem; with one it is quota", async () => {
    google.handler = json(403, { error: { message: "User does not have sufficient permission for site", errors: [{ reason: "forbidden" }] } });
    await expect(client().listSites()).rejects.toMatchObject({ kind: "permission", status: 403 });
    google.handler = json(403, { error: { message: "Quota exceeded", errors: [{ reason: "quotaExceeded" }] } });
    await expect(client().listSites()).rejects.toMatchObject({ kind: "quota", retryAfterMs: QUOTA_BACKOFF_MS });
    expect(google.calls).toHaveLength(2); // quota is not retried in a tight loop
  });

  it("429 honours Retry-After; 400 is not retried", async () => {
    google.handler = json(429, {}, { "retry-after": "120" });
    await expect(client().listSites()).rejects.toMatchObject({ kind: "quota", retryAfterMs: 120_000 });
    google.calls.length = 0;
    google.handler = json(400, { error: { message: "Invalid dimension combination" } });
    await expect(client().listSites()).rejects.toMatchObject({ kind: "bad_request" });
    expect(google.calls).toHaveLength(1);
  });

  it("5xx and timeouts retry with bounded exponential backoff, then give up as transient", async () => {
    google.handler = json(503, {});
    await expect(client().listSites()).rejects.toMatchObject({ kind: "transient", status: 503 });
    expect(google.calls).toHaveLength(3);
    expect(sleeps).toEqual([750, 1500]); // 1s and 2s with jitter factor 0.75
    google.calls.length = 0;
    sleeps.length = 0;
    let n = 0;
    google.handler = async () => {
      if (++n < 3) throw new GoogleNetworkError("Google request timed out after 30000ms", true);
      return { status: 200, headers: new Headers(), body: { siteEntry: [] } };
    };
    await expect(client().listSites()).resolves.toEqual([]);
    expect(sleeps).toHaveLength(2);
    expect(new GscClient(tokens, { key: "x", random: () => 1 }).backoffMs(10)).toBe(10_000); // capped
  });

  it("paces requests per integration", async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = new Pacer(60, () => clock, async (ms) => { waits.push(ms); clock += ms; });
    await pacer.wait("a");
    await pacer.wait("a");
    await pacer.wait("b");
    await pacer.wait("a");
    expect(waits).toEqual([1_000, 1_000]); // 60/min = 1 s apart for "a"; "b" is independent
  });

  it("parses Search Analytics rows and the first incomplete date", async () => {
    google.handler = json(200, { rows: [{ keys: ["2030-01-01", "shoes"], clicks: 3, impressions: 10, ctr: 0.3, position: 2.5 }], metadata: { first_incomplete_date: "2030-01-02" } });
    const r = await client().searchAnalytics("https://example.com/", { startDate: "2030-01-01", endDate: "2030-01-01", dimensions: ["date", "query"], dataState: "all" });
    expect(r).toEqual({ rows: [{ keys: ["2030-01-01", "shoes"], clicks: 3, impressions: 10, ctr: 0.3, position: 2.5 }], firstIncompleteDate: "2030-01-02" });
    expect(google.calls[0].url).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query");
  });

  it("is a GscApiError subclass for callers", () => {
    expect(new GscApiError("quota", "x", 429)).toBeInstanceOf(Error);
  });
});

describe("property types and website matching", () => {
  it("recognizes domain and URL-prefix properties", () => {
    expect(propertyType("sc-domain:example.com")).toBe("domain");
    expect(propertyType("https://www.example.com/")).toBe("url_prefix");
    expect(propertyType("https://example.com/blog/")).toBe("url_prefix");
    expect(propertyType("https://example.com")).toBeNull(); // Search Console prefixes end with /
    expect(propertyType("ftp://example.com/")).toBeNull();
    expect(propertyType("sc-domain:")).toBeNull();
  });

  it("domain properties cover the host and subdomains; URL prefixes are exact about scheme, host, port and path", () => {
    expect(propertyCoversWebsite("sc-domain:example.com", "https://www.example.com/")).toBe(true);
    expect(propertyCoversWebsite("sc-domain:example.com", "http://shop.example.com/x")).toBe(true);
    expect(propertyCoversWebsite("sc-domain:example.com", "https://notexample.com/")).toBe(false);
    expect(propertyCoversWebsite("sc-domain:example.com", "https://example.com.evil.test/")).toBe(false);
    expect(propertyCoversWebsite("https://example.com/", "https://example.com/")).toBe(true);
    expect(propertyCoversWebsite("https://example.com/", "https://example.com/shop")).toBe(true);
    expect(propertyCoversWebsite("https://example.com/", "http://example.com/")).toBe(false);
    expect(propertyCoversWebsite("https://example.com/", "https://www.example.com/")).toBe(false);
    expect(propertyCoversWebsite("https://example.com/blog/", "https://example.com/")).toBe(false);
    expect(propertyCoversWebsite("https://example.com/blog/", "https://example.com/blog")).toBe(true);
    expect(propertyCoversWebsite("https://example.com:8443/", "https://example.com/")).toBe(false);
    expect(propertyCoversWebsite("https://example.com/", "not a url")).toBe(false);
  });
});
