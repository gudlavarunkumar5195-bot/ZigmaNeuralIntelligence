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
