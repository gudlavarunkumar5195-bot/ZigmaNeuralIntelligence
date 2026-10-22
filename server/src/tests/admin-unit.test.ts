import { describe, expect, it, vi } from "vitest";

// Provider validation is tested against a fake network module: no real call.
const net = vi.hoisted(() => ({ next: null as null | { status: number; body?: unknown } | "timeout" | "network" }));
vi.mock("../platform/provider-http.js", async () => {
  const actual = await vi.importActual<typeof import("../platform/provider-http.js")>("../platform/provider-http.js");
  return {
    ...actual,
    providerRequest: vi.fn(async () => {
      if (net.next === "timeout") throw new actual.ProviderNetworkError("Request timed out after 10000ms", true);
      if (net.next === "network") throw new actual.ProviderNetworkError("Network error reaching the provider", false);
      return { status: net.next!.status, body: net.next!.body ?? null };
    }),
  };
});

import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, parseKeyRing } from "../integrations/crypto.js";
import { redact } from "../platform/diagnostics.js";
import { validateOpenRouterKey } from "../platform/integrations.js";
import { generatePassword, passwordWithinBcryptLimit } from "../services/auth.service.js";
import { providerRequest } from "../platform/provider-http.js";
import { errorHandler } from "../middleware/error.js";
import { recentServerErrors } from "../platform/error-log.js";

describe("OpenRouter credential validation distinguishes failure kinds", () => {
  const cases: Array<[typeof net.next, string]> = [
    [{ status: 200, body: { data: { is_free_tier: true, limit: null, limit_remaining: null, usage: 0 } } }, "valid"],
    [{ status: 401 }, "invalid"],
    [{ status: 402 }, "quota_exceeded"],
    [{ status: 403 }, "permission_denied"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 503 }, "unavailable"],
    [{ status: 418 }, "error"],
    ["timeout", "timeout"],
    ["network", "unavailable"],
  ];
  it.each(cases)("%j → %s", async (response, status) => {
    net.next = response;
    const r = await validateOpenRouterKey("sk-or-test-key-0000");
    expect(r.status).toBe(status);
    expect(r.message).not.toContain("sk-or-test-key-0000");
  });

  it("uses the no-cost key endpoint, never a model call", async () => {
    net.next = { status: 200, body: { data: {} } };
    await validateOpenRouterKey("sk-or-test-key-0000");
    expect(vi.mocked(providerRequest)).toHaveBeenLastCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ method: "GET" }));
  });

  it("an accepted key's details contain only numbers and flags from the provider", async () => {
    net.next = { status: 200, body: { data: { is_free_tier: false, limit: 10, limit_remaining: 4.5, usage: "x", label: "secret label" } } };
    const r = await validateOpenRouterKey("sk-or-test-key-0000");
    expect(r.details).toEqual({ freeTier: false, creditLimit: 10, creditRemaining: 4.5, usage: null });
  });
});

describe("credential encryption", () => {
  const ring = parseKeyRing(`k1:${randomBytes(32).toString("base64")}`);
  it("rejects tampered ciphertext and ciphertext moved to another record", () => {
    const { ciphertext } = encryptSecret(ring, "sk-or-secret", "platform:openrouter");
    expect(ciphertext).not.toContain("sk-or-secret");
    expect(decryptSecret(ring, ciphertext, "platform:openrouter")).toBe("sk-or-secret");
    const [k, iv, tag, data] = ciphertext.split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret(ring, [k, iv, tag, flipped.toString("base64url")].join("."), "platform:openrouter")).toThrow();
    expect(() => decryptSecret(ring, ciphertext, "platform:other")).toThrow();
  });
  it("uses a fresh IV for every encryption", () => {
    const a = encryptSecret(ring, "same", "x").ciphertext.split(".")[1];
    const b = encryptSecret(ring, "same", "x").ciphertext.split(".")[1];
    expect(a).not.toBe(b);
  });
});

describe("generated passwords", () => {
  it("are 20 characters from the CSPRNG with every class, and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).toMatch(/[!#%+\-=?@_]/);
      expect(p).not.toMatch(/[0O1lI]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
  it("bcrypt's 72-byte limit is enforced instead of silent truncation", () => {
    expect(passwordWithinBcryptLimit("a".repeat(72))).toBe(true);
    expect(passwordWithinBcryptLimit("a".repeat(73))).toBe(false);
    expect(passwordWithinBcryptLimit("é".repeat(37))).toBe(false); // 74 bytes
  });
});

describe("diagnostic redaction", () => {
  it("removes credentials, tokens, connection passwords and email addresses", () => {
    const out = redact(
      "fetch failed: Bearer abc.def-ghi for jane@example.com via postgresql://app:hunter2@db.internal/x ?token=t0k3n&x=1 sk-or-v1-abcdefghijkl " + "A".repeat(48),
      1000,
    )!;
    expect(out).not.toMatch(/abc\.def|jane@example\.com|hunter2|t0k3n|sk-or-v1-abcdefghijkl|A{48}/);
    expect(out).toContain("[email]");
    expect(out).toContain("x=1");
  });
  it("bounds length", () => {
    expect(redact("ab ".repeat(200), 10)).toBe("ab ab ab a…");
    expect(redact(null)).toBeNull();
  });
});

describe("central error handler", () => {
  const fakeReply = () => {
    const r = { code: 0, body: null as unknown, status(c: number) { r.code = c; return r; }, send(b: unknown) { r.body = b; return r; } };
    return r;
  };
  const req = { id: "req-1", method: "GET", url: "/api/v1/x?token=secret", routeOptions: { url: "/api/v1/x" }, log: { warn: () => undefined, error: () => undefined } };
  it("gives rate-limit responses a stable code", () => {
    const reply = fakeReply();
    errorHandler(Object.assign(new Error("Rate limit exceeded, retry in 15 minutes"), { statusCode: 429 }) as never, req as never, reply as never);
    expect(reply.code).toBe(429);
    expect(reply.body).toMatchObject({ error: { code: "RATE_LIMITED", requestId: "req-1" } });
  });
  it("hides 5xx details and records only the route pattern and error class", () => {
    const reply = fakeReply();
    errorHandler(Object.assign(new Error("db password=hunter2 failed"), { statusCode: 500 }) as never, req as never, reply as never);
    expect(JSON.stringify(reply.body)).not.toContain("hunter2");
    const last = recentServerErrors().errors[0];
    expect(last).toMatchObject({ requestId: "req-1", route: "/api/v1/x", statusCode: 500, errorClass: "Error" });
    expect(JSON.stringify(last)).not.toMatch(/hunter2|token=secret/);
  });
});
