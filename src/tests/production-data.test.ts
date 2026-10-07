import { describe, expect, it } from "vitest";

const productionModules = import.meta.glob("../{pages,components,services}/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" });
const source = Object.values(productionModules).join("\n");

describe("production data boundary", () => {
  it("does not retain the removed fixture module or its sample tenant", () => {
    expect(source).not.toContain("data/demo");
    expect(source.toLowerCase()).not.toContain("acmecorp.com");
  });

  it("does not carry the retired illustrative overview values", () => {
    for (const value of ["Overall Score 87", "Issues Found 23", "Pages Scanned 247"]) {
      expect(source).not.toContain(value);
    }
  });

  it("does not contain fabricated settings, team or security claims", () => {
    for (const value of [
      "Ava Thompson",
      "Miles Chen",
      "Nina Patel",
      "12 active",
      "2 pending",
      "Enabled for owners",
      "Retained 365 days",
      "200/min",
      "Rate limiting",
      "Growth",
      "US East + EU West",
      "Coming Soon",
      "Full implementation connects to backend services",
    ]) {
      expect(source).not.toContain(value);
    }
  });
});
