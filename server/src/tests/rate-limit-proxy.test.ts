import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowCounter, normalizeEmailForKey, parseTrustProxy } from "../http/trust-proxy.js";

describe("parseTrustProxy", () => {
  it("defaults to not trusting", () => {
    for (const v of [undefined, "", " ", "false", "FALSE", "0"]) expect(parseTrustProxy(v)).toBe(false);
  });
  it("accepts hop counts and IP/CIDR lists", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("10.0.0.0/8, 2001:db8::/32,127.0.0.1")).toEqual(["10.0.0.0/8", "2001:db8::/32", "127.0.0.1"]);
    expect(parseTrustProxy("loopback")).toEqual(["loopback"]);
  });
  it("rejects blanket true and malformed values", () => {
    for (const v of ["true", "TRUE", "yes", "6", "-1", "1.5", "10.0.0.0/33", "10.0.0.0/8/1", "1.1.1.1,", "not-an-ip", "::/129"])
      expect(() => parseTrustProxy(v), v).toThrow();
  });
  it("normalises email keys", () => {
    expect(normalizeEmailForKey("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(normalizeEmailForKey(undefined)).toBe("");
    expect(normalizeEmailForKey({})).toBe("");
  });
});

// Login with a missing password returns 400 before touching the database but
// is still counted by the rate limiter (limit: 10 per ip|email per 15 minutes).
async function appWith(trustProxy: string | undefined) {
  vi.resetModules();
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  const { buildApp } = await import("../app.js");
  const app = await buildApp();
  await app.ready();
  return app;
}

async function login(app: Awaited<ReturnType<typeof appWith>>, xff: string | undefined, email = "victim@example.com") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: "10.1.1.1",
    headers: xff ? { "x-forwarded-for": xff } : {},
    payload: { email },
  });
}

describe("rate limiting behind a proxy (F-012)", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
    vi.resetModules();
  });

  it("ignores X-Forwarded-For when proxy trust is not configured", async () => {
    const app = await appWith(undefined);
    try {
      for (let i = 0; i < 10; i++) expect((await login(app, `203.0.113.${i + 1}`)).statusCode).toBe(400);
      // Rotating the spoofed header did not mint new buckets.
      expect((await login(app, "198.51.100.77")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("honours the forwarded client address when trusted, with separate buckets", async () => {
    const app = await appWith("1");
    try {
      for (let i = 0; i < 10; i++) expect((await login(app, "203.0.113.1")).statusCode).toBe(400);
      expect((await login(app, "203.0.113.1")).statusCode).toBe(429);
      // A different client behind the same proxy is unaffected.
      expect((await login(app, "203.0.113.2")).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("with one trusted hop a client-supplied left-most entry cannot change the key", async () => {
    const app = await appWith("1");
    try {
      for (let i = 0; i < 10; i++) expect((await login(app, `9.9.9.${i + 1}, 203.0.113.5`)).statusCode).toBe(400);
      expect((await login(app, "8.8.8.8, 203.0.113.5")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("with a CIDR list only listed peers are trusted proxies", async () => {
    const app = await appWith("10.0.0.0/8");
    try {
      const from = (remoteAddress: string, xff: string) =>
        app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress, headers: { "x-forwarded-for": xff }, payload: { email: "c@example.com" } });
      // Untrusted peer: header ignored, one shared bucket per socket address.
      for (let i = 0; i < 10; i++) expect((await from("192.168.5.5", `1.2.3.${i + 1}`)).statusCode).toBe(400);
      expect((await from("192.168.5.5", "1.2.3.99")).statusCode).toBe(429);
      // Trusted peer: forwarded addresses form distinct buckets.
      for (let i = 0; i < 10; i++) expect((await from("10.1.1.1", "7.7.7.7")).statusCode).toBe(400);
      expect((await from("10.1.1.1", "7.7.7.7")).statusCode).toBe(429);
      expect((await from("10.1.1.1", "7.7.7.8")).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("keys auth limits on IP plus normalised email", async () => {
    const app = await appWith(undefined);
    try {
      for (let i = 0; i < 10; i++) expect((await login(app, undefined, i % 2 ? "A@Example.com " : "a@example.com")).statusCode).toBe(400);
      expect((await login(app, undefined, "a@example.com")).statusCode).toBe(429);
      // Same IP, other account: separate bucket.
      expect((await login(app, undefined, "b@example.com")).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("bounds email rotation from one IP with a per-IP ceiling", async () => {
    const app = await appWith(undefined);
    try {
      for (let i = 0; i < 50; i++) expect((await login(app, undefined, `user${i}@example.com`)).statusCode).toBe(400);
      expect((await login(app, undefined, "user-new@example.com")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe("createFixedWindowCounter", () => {
  it("allows max hits per window then resets", () => {
    let t = 0;
    const c = createFixedWindowCounter(2, 1000, () => t);
    expect([c.hit("a"), c.hit("a"), c.hit("a"), c.hit("b")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(c.hit("a")).toBe(true);
  });
});
