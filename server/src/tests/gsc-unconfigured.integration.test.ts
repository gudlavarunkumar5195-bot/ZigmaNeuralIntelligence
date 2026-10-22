import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// With no Google OAuth or encryption settings, the integration must say so
// plainly (names of the missing settings, never values), make no Google call,
// and never pretend to be connected.
const { calls } = vi.hoisted(() => {
  for (const k of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "INTEGRATION_ENCRYPTION_KEYS"]) delete process.env[k];
  return { calls: { n: 0 } };
});
vi.mock("../integrations/google/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/google/http.js")>()),
  googleRequest: async () => {
    calls.n++;
    throw new Error("no network in tests");
  },
}));

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("Search Console without server configuration (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "gsc-off");
  });
  afterAll(async () => {
    if (A) await cleanupOrgs([A.id]);
    await h?.close();
  });

  it("reports not configured, refuses to start OAuth with a 503 naming the missing settings, and calls nothing", async () => {
    const auth = { token: A.users.owner.token, orgId: A.id };
    const list = await h.request("GET", "/api/v1/integrations", auth);
    expect(list.json()).toEqual({
      data: [],
      meta: { googleSearchConsole: { configured: false, missing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "INTEGRATION_ENCRYPTION_KEYS"] } },
    });
    const start = await h.request("POST", "/api/v1/integrations/google/oauth/start", { ...auth, payload: {} });
    expect(start.statusCode).toBe(503);
    expect(start.json().error).toMatchObject({ code: "INTEGRATION_NOT_CONFIGURED", missing: expect.arrayContaining(["GOOGLE_OAUTH_CLIENT_ID"]) });
    expect(start.headers["set-cookie"]).toBeUndefined();
    const status = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console`, auth);
    expect(status.json().data).toBeNull();
    const { allowedRange } = await import("../services/search-console.service.js");
    const day = allowedRange().max;
    const perf = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=${day}&to=${day}`, auth);
    expect(perf.json().error.code).toBe("SEARCH_CONSOLE_NOT_LINKED"); // never zeros or fake data
    const future = await h.request("GET", `/api/v1/websites/${A.websiteId}/search-console/performance?from=2099-01-01&to=2099-01-02`, auth);
    expect(future.json().error.code).toBe("INVALID_DATE_RANGE");
    const { processSearchConsoleTick } = await import("../services/search-console.service.js");
    await processSearchConsoleTick();
    expect(calls.n).toBe(0);
  });
});
