import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRequestHeaders, getActiveOrgId } from "../services/api";
import { resolveAuthRedirect, isSessionRoute } from "../services/auth";

function createSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    length: store.size,
  };
}

describe("tenant request context", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      value: createSessionStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("attaches x-org-id when an active org is configured", () => {
    sessionStorage.setItem("zn_active_org_id", "org-123");

    const headers = buildRequestHeaders({ Authorization: "Bearer token" });

    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("x-org-id")).toBe("org-123");
  });

  it("falls back to the first org in the signed JWT", () => {
    const payload = btoa(JSON.stringify({ orgIds: ["org-1", "org-2"] }));
    sessionStorage.setItem("zn_token", `header.${payload}.signature`);

    expect(getActiveOrgId()).toBe("org-1");
  });

  it("redirects unauthenticated users away from protected routes", () => {
    expect(isSessionRoute("/login")).toBe(true);
    expect(isSessionRoute("/")).toBe(false);
    expect(resolveAuthRedirect("/", "" )).toBe("/login");
  });
});
