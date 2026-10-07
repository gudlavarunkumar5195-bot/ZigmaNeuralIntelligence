import { describe, expect, it } from "vitest";
import { isRecoverableModuleFailure, logicalKey, summarizeOverallScore } from "../services/scan.service.js";
import { intelligenceStatusFor, reportStatusFor } from "../ai/agents/lifecycle.js";

describe("Scan lifecycle summary", () => {
  it("does not make partial intelligence report-ready", () => {
    expect(intelligenceStatusFor({ status: "partial" })).toBe("PARTIAL");
    expect(reportStatusFor({ intelligenceStatus: "PARTIAL", qualityAccepted: true })).toBe("FAILED");
  });

  it("preserves cancelled intelligence as cancelled", () => {
    expect(intelligenceStatusFor({ status: "cancelled" })).toBe("CANCELLED");
    expect(reportStatusFor({ intelligenceStatus: "CANCELLED", qualityAccepted: true })).toBe("FAILED");
  });
  it("computes a weighted overall score from measured categories", () => {
    const summary = summarizeOverallScore([
      { category: "seo", score: 80, status: "scored", finding_count: 2, critical_count: 1 },
      { category: "security", score: 90, status: "scored", finding_count: 1, critical_count: 0 },
      { category: "performance", score: 70, status: "scored", finding_count: 3, critical_count: 1 },
      { category: "ssl", score: 100, status: "scored", finding_count: 0, critical_count: 0 },
      { category: "overall", score: null, status: "not_measured", finding_count: 0, critical_count: 0 },
    ]);

    expect(summary.score).toBe(84);
    expect(summary.status).toBe("scored");
    expect(summary.findingCount).toBeGreaterThanOrEqual(6);
    expect(summary.criticalCount).toBeGreaterThanOrEqual(2);
  });

  it("marks the overall result as partial when any measured category is incomplete", () => {
    const summary = summarizeOverallScore([
      { category: "seo", score: 80, status: "scored", finding_count: 2, critical_count: 1 },
      { category: "performance", score: null, status: "not_measured", finding_count: 0, critical_count: 0 },
      { category: "overall", score: null, status: "not_measured", finding_count: 0, critical_count: 0 },
    ]);

    expect(summary.score).toBe(80);
    expect(summary.status).toBe("partial");
  });

  it("marks the overall result as failed when a category fails", () => {
    const summary = summarizeOverallScore([
      { category: "seo", score: 80, status: "scored", finding_count: 1, critical_count: 0 },
      { category: "security", score: null, status: "failed", finding_count: 0, critical_count: 0 },
    ]);

    expect(summary.score).toBe(80);
    expect(summary.status).toBe("failed");
  });

  it("creates stable keys while keeping distinct observations separate", () => {
    const base = { moduleName: "seo", category: "seo", severity: "high", title: "Missing H1", affectedUrls: ["https://example.com"] };
    expect(logicalKey(base)).toBe(logicalKey({ ...base }));
    expect(logicalKey(base)).not.toBe(logicalKey({ ...base, affectedUrls: ["https://example.com/about"] }));
  });

  it("only retries recoverable scanner failures", () => {
    expect(isRecoverableModuleFailure("Request timed out")).toBe(true);
    expect(isRecoverableModuleFailure("ECONNRESET")).toBe(true);
    expect(isRecoverableModuleFailure("SSRF: private address")).toBe(false);
    expect(isRecoverableModuleFailure("Invalid URL")).toBe(false);
  });
});
