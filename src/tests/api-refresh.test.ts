import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function storage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("apiFetch refresh behaviour", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: typeof import("../services/api");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "" } };
    sessionStorage.setItem("zn_token", "old");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("../services/api");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("concurrent 401s share one refresh call (single-use refresh token)", async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) { refreshCalls++; await Promise.resolve(); return json(200, { data: { token: "new" } }); }
      const auth = new Headers(init?.headers).get("Authorization");
      return auth === "Bearer new" ? json(200, { data: [] }) : json(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    });
    const [a, b] = await Promise.all([api.apiListWebsites(), api.apiListWebsites()]);
    expect(refreshCalls).toBe(1);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });

  it("a 403 after a successful refresh is surfaced, not turned into a logout", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) return json(200, { data: { token: "new" } });
      const auth = new Headers(init?.headers).get("Authorization");
      return auth === "Bearer new" ? json(403, { error: { code: "FORBIDDEN", message: "no" } }) : json(401, {});
    });
    const res = await api.apiListWebsites();
    expect(res.error?.code).toBe("FORBIDDEN");
    expect(sessionStorage.getItem("zn_token")).toBe("new");
    expect((globalThis as any).window.location.hash).toBe("");
  });

  it("logs out only when the retry is still 401", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/auth/refresh") ? json(401, {}) : json(401, {}));
    const res = await api.apiListWebsites();
    expect(res.error?.code).toBe("UNAUTHORIZED");
    expect(sessionStorage.getItem("zn_token")).toBeNull();
    expect((globalThis as any).window.location.hash).toBe("/login");
  });

  it("treats 204 as success and preserves null data", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await api.apiListWebsites()).error).toBeNull();
    fetchMock.mockResolvedValueOnce(json(200, { data: null }));
    expect((await api.apiListWebsites()).data).toBeNull();
  });

  it("passes pagination params and exposes response meta", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: [{ id: "w1" }], meta: { page: 2, pageSize: 100, offset: 100 } }));
    const res = await api.apiListWebsites({ page: 2, pageSize: 100 });
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://api.test/websites?page=2&pageSize=100");
    expect(res.meta).toEqual({ page: 2, pageSize: 100, offset: 100 });
  });

  it("no longer exports removed dead endpoints", () => {
    for (const name of ["apiGetMonitoringHistory", "subscribeToScanProgress", "apiUpdateRoutingPolicy", "apiPlanWorkflow", "apiGetMonitoringRules"]) {
      expect(name in api).toBe(false);
    }
  });
});

describe("apiFetch failure handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: typeof import("../services/api");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "#/search/rankings/history" } };
    sessionStorage.setItem("zn_token", "old");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("../services/api");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  // A fetch that only settles when its signal aborts.
  const hanging = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  it("times out a request that never answers, with a clear error", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const pending = api.apiListWebsites().catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await pending;
    expect(err).toBeInstanceOf(api.ApiCallError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("warns that a timed-out mutation may have been applied", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const pending = api.apiCreateScan("w1", ["seo"]).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).message).toMatch(/may still have been saved/);
  });

  it("reports network failures readably", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await api.apiListWebsites().catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toMatch(/Could not reach the server/);
  });

  it("carries the HTTP status and request id on errors", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "CONFLICT", message: "Already running" } }), { status: 409, headers: { "content-type": "application/json", "x-request-id": "req-1" } }));
    const res = await api.apiListWebsites();
    expect(res.error).toMatchObject({ code: "CONFLICT", message: "Already running", status: 409, requestId: "req-1" });
  });

  it("explains 5xx and 429 responses without a JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    expect((await api.apiListWebsites()).error).toMatchObject({ status: 502, message: expect.stringMatching(/HTTP 502/) });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    expect((await api.apiListWebsites()).error).toMatchObject({ status: 429, message: expect.stringMatching(/Too many requests/) });
  });

  it("never retries a failed mutation", async () => {
    fetchMock.mockResolvedValue(json(500, { error: { code: "INTERNAL", message: "boom" } }));
    const res = await api.apiCreateScan("w1", ["seo"]);
    expect(res.error?.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends the session when refresh fails: clears tab state and remembers the page", async () => {
    sessionStorage.setItem("zn_active_org_id", "org-1");
    fetchMock.mockResolvedValue(json(401, { error: { code: "UNAUTHORIZED", message: "x" } }));
    const res = await api.apiListWebsites();
    expect(res.error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(sessionStorage.getItem("zn_token")).toBeNull();
    expect(sessionStorage.getItem("zn_active_org_id")).toBeNull();
    expect((globalThis as any).window.location.hash).toBe("/login");
    expect(api.takeReturnPath()).toBe("/search/rankings/history");
  });

  it("refuses unsafe return paths", () => {
    api.rememberReturnPath("//evil.example/x");
    expect(api.takeReturnPath()).toBeNull();
    api.rememberReturnPath("/login");
    expect(api.takeReturnPath()).toBeNull();
  });

  it("downloads refresh an expired token like any other request", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) return json(200, { data: { token: "new" } });
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth !== "Bearer new") return json(401, {});
      return new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="content-pages.csv"' } });
    });
    const out = await api.apiContentExport("w1", "pages");
    expect("blob" in out && out.filename).toBe("content-pages.csv");
  });

  it("a download that cannot reach the server returns an error instead of throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const out = await api.apiContentExport("w1", "pages");
    expect("error" in out && out.error).toMatch(/Could not reach the server/);
  });
});

describe("refresh resilience", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: typeof import("../services/api");
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "#/websites" } };
    sessionStorage.setItem("zn_token", "old");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("../services/api");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("keeps the session when the refresh call cannot reach the server", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) throw new TypeError("Failed to fetch");
      return json(401, {});
    });
    const err = await api.apiListWebsites().catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(sessionStorage.getItem("zn_token")).toBe("old");
    expect((globalThis as any).window.location.hash).toBe("#/websites");
  });

  it("treats a 5xx from refresh as unreachable, not as a sign-out", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith("/auth/refresh") ? json(503, {}) : json(401, {})));
    await api.apiListWebsites().catch(() => undefined);
    expect(sessionStorage.getItem("zn_token")).toBe("old");
  });

  it("forwards caller headers given as a Headers instance", async () => {
    fetchMock.mockResolvedValue(json(200, { data: { id: "s" } }));
    await api.apiStartCrawl("w1", {}, "key-1");
    const sent = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(sent.get("Idempotency-Key")).toBe("key-1");
    expect(sent.get("Authorization")).toBe("Bearer old");
  });
});

describe("session end with concurrent failures", () => {
  it("keeps the page to return to when several requests fail at once", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "#/search/backlinks" } };
    sessionStorage.setItem("zn_token", "old");
    vi.stubGlobal("fetch", vi.fn(async () => json(401, {})));
    const api = await import("../services/api");
    await Promise.all([api.apiListWebsites(), api.apiListAlerts(), api.apiGetMe()]);
    expect((globalThis as any).window.location.hash).toBe("/login");
    expect(api.takeReturnPath()).toBe("/search/backlinks");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

describe("withSignal", () => {
  it("aborts the request started inside it, and only that one", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "" } };
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }));
    const api = await import("../services/api");
    const controller = new AbortController();
    const inside = api.withSignal(controller.signal, () => api.apiListWebsites()).catch((e) => e);
    const outside = api.apiListAlerts().catch((e) => e);
    controller.abort();
    const err = await inside;
    expect(err.code).toBe("ABORTED");
    expect(signals[1].aborted).toBe(false); // the request started outside keeps running
    void outside;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

describe("refresh across tabs", () => {
  it("retries once when another tab has just rotated the shared refresh cookie", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = { location: { hash: "#/websites" } };
    sessionStorage.setItem("zn_token", "old");
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls++;
        return refreshCalls === 1 ? json(401, { error: { code: "REFRESH_TOKEN_ROTATED", message: "retry" } }) : json(200, { data: { token: "new" } });
      }
      return new Headers(init?.headers).get("Authorization") === "Bearer new" ? json(200, { data: [] }) : json(401, {});
    }));
    const api = await import("../services/api");
    const res = await api.apiListWebsites();
    expect(res.error).toBeNull();
    expect(refreshCalls).toBe(2);
    expect(sessionStorage.getItem("zn_token")).toBe("new");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
