import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "test",
    QA_VERIFICATION_BYPASS_ENABLED: true,
    QA_AUTHORIZED_EMAILS: "qa@example.com",
    QA_ALLOW_PRODUCTION_BYPASS: false,
  },
}));

import { canonicalizeQaDomain, isQaBypassAuthorized, QA_CANONICAL_DOMAIN } from "../services/website.service.js";

describe("QA verification policy", () => {
  it("normalizes only the approved domain", () => {
    expect(canonicalizeQaDomain("https://zigmaneural.com/")).toBe(QA_CANONICAL_DOMAIN);
    expect(canonicalizeQaDomain("www.zigmaneural.com")).toBe(QA_CANONICAL_DOMAIN);
    expect(canonicalizeQaDomain("https://not-approved.example")).toBeNull();
  });

  it("requires the explicit QA email and admin role", () => {
    expect(isQaBypassAuthorized("qa@example.com", "owner")).toBe(true);
    expect(isQaBypassAuthorized("qa@example.com", "member")).toBe(false);
    expect(isQaBypassAuthorized("other@example.com", "admin")).toBe(false);
  });

  it("cannot be enabled in production by the normal QA flag", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({ config: { NODE_ENV: "production", QA_VERIFICATION_BYPASS_ENABLED: true, QA_AUTHORIZED_EMAILS: "qa@example.com", QA_ALLOW_PRODUCTION_BYPASS: false } }));
    const { isQaBypassAuthorized: productionPolicy } = await import("../services/website.service.js");
    expect(productionPolicy("qa@example.com", "owner")).toBe(false);
  });
});