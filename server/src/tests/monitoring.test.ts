import { describe, expect, it } from "vitest";
import { compareSnapshots, changeSignature, nextRunAt, validateSnapshot } from "../services/monitoring.service.js";

describe("Phase 8 deterministic monitoring", () => {
  it("calculates explicit daily, weekly, and monthly schedules", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    expect(nextRunAt("daily", base).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(nextRunAt("weekly", base).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(nextRunAt("monthly", base).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("detects URL, metadata, finding, and score changes without an LLM", () => {
    const before = { scanId: "old", pages: [{ url: "https://example.test/old", title: "Old", status: 200 }, { url: "https://example.test", title: "Home", status: 200 }], findings: [{ id: "f1", key: "seo:seo:high:/", domain: "seo", severity: "high", evidenceIds: ["e1"] }], scores: [{ category: "seo", score: 90 }] };
    const after = { scanId: "new", pages: [{ url: "https://example.test/new", title: "New", status: 200 }, { url: "https://example.test", title: "Home changed", status: 500 }], findings: [{ id: "f2", key: "security:security:critical:/", domain: "security", severity: "critical", evidenceIds: ["e2"] }], scores: [{ category: "seo", score: 60 }] };
    const changes = compareSnapshots(before, after);
    expect(changes.map((change) => change.changeType)).toEqual(expect.arrayContaining(["URL_ADDED", "URL_REMOVED", "TITLE_CHANGED", "STATUS_CHANGED", "FINDING_INTRODUCED", "FINDING_RESOLVED", "SCORE_CHANGED"]));
    expect(changes.every((change) => typeof change.impact === "string")).toBe(true);
  });

  it("produces stable alert signatures for duplicate changes", () => {
    const value = { changeType: "FINDING_INTRODUCED", domain: "security", affectedUrls: ["https://example.test"], findingIds: ["f1"] };
    expect(changeSignature(value)).toBe(changeSignature({ ...value }));
  });

  it("detects structural page changes and rejects incomplete baselines", () => {
    const before = { scanId: "old", pages: [{ url: "https://example.test", redirectLocation: "/home", responseHeaders: { etag: "a" }, headings: ["Home"], structuredData: ["Article"], hreflang: ["en"] }], findings: [], scores: [{ category: "seo", score: 90 }] };
    const after = { ...before, scanId: "new", pages: [{ url: "https://example.test", redirectLocation: "/new-home", responseHeaders: { etag: "b" }, headings: ["New home"], structuredData: ["Product"], hreflang: ["en", "fr"] }] };
    expect(compareSnapshots(before, after).map((change) => change.changeType)).toEqual(expect.arrayContaining(["REDIRECTLOCATION_CHANGED", "RESPONSEHEADERS_CHANGED", "HEADINGS_CHANGED", "STRUCTUREDDATA_CHANGED", "HREFLANG_CHANGED"]));
    expect(validateSnapshot({ scanId: "x", pages: [], findings: [], scores: [] }).valid).toBe(false);
  });
});
