import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED, scrubBrowserBreadcrumb, scrubBrowserEvent, scrubUrl } from "../observability/scrub";

vi.stubGlobal("__APP_VERSION__", "1.0.0");

describe("frontend Sentry settings", () => {
  afterEach(() => vi.resetModules());

  it("is a no-op without VITE_SENTRY_DSN", async () => {
    const mod = await import("../observability/sentry");
    expect(mod.readFrontendSentrySettings({})).toBeNull();
    expect(mod.initFrontendSentry({ MODE: "production" })).toBe(false);
    expect(mod.isFrontendSentryEnabled()).toBe(false);
  });

  it("rejects malformed DSNs and applies defaults", async () => {
    const mod = await import("../observability/sentry");
    expect(mod.readFrontendSentrySettings({ VITE_SENTRY_DSN: "nope" })).toBeNull();
    expect(mod.readFrontendSentrySettings({ VITE_SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/2", MODE: "production" })).toEqual({
      dsn: "https://abc@o1.ingest.us.sentry.io/2",
      environment: "production",
      release: "zigma-web@1.0.0",
      tracesSampleRate: 0.05,
      replay: false,
    });
    expect(
      mod.readFrontendSentrySettings({ VITE_SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/2", VITE_SENTRY_TRACES_SAMPLE_RATE: "7", VITE_SENTRY_REPLAY: "on" }),
    ).toMatchObject({ tracesSampleRate: 1, replay: true });
  });
});

describe("frontend scrubbing", () => {
  it("drops credential-bearing query strings and fragments", () => {
    expect(scrubUrl("https://app.test/reset-password?token=abc123")).toBe(`https://app.test/reset-password?${REDACTED}`);
    expect(scrubUrl("https://app.test/callback?code=x&state=y")).toBe(`https://app.test/callback?${REDACTED}`);
    expect(scrubUrl("https://app.test/#access_token=abc")).toBe(`https://app.test/#${REDACTED}`);
    expect(scrubUrl("https://app.test/#/verify?token=abc")).toBe(`https://app.test/#/verify?${REDACTED}`);
    expect(scrubUrl("https://app.test/websites?page=2#/dashboard")).toBe("https://app.test/websites?page=2#/dashboard");
  });

  it("never sends bodies, cookies, auth headers or user PII", () => {
    const out = scrubBrowserEvent({
      message: "failed with Bearer abcdefghijkl",
      request: { url: "https://app.test/x?token=1", data: { password: "p" }, cookies: { a: "b" }, headers: { Authorization: "Bearer zzzzzzzzzz", "User-Agent": "ua" } },
      user: { id: "u1", email: "a@b.test", ip_address: "1.2.3.4" },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("abcdefghijkl");
    expect(json).not.toContain("zzzzzzzzzz");
    expect(json).not.toContain("a@b.test");
    expect(json).not.toContain('"p"');
    expect(out.request).toEqual({ url: `https://app.test/x?${REDACTED}`, headers: { "User-Agent": "ua" } });
    expect(out.user).toEqual({ id: "u1" });
  });

  it("scrubs navigation and fetch breadcrumbs", () => {
    const nav = scrubBrowserBreadcrumb({ category: "navigation", data: { from: "/login", to: "/reset?token=abc" } });
    expect(nav.data.to).toBe(`/reset?${REDACTED}`);
    const fetchCrumb = scrubBrowserBreadcrumb({ category: "fetch", data: { url: "/api/v1/x?api_key=1", request_body: "{}", response_body: "{}" } });
    expect(fetchCrumb.data).toEqual({ url: `/api/v1/x?${REDACTED}`, request_body: REDACTED, response_body: REDACTED });
  });
});
