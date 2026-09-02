import { describe, it, expect } from "vitest";
import {
  calculateCategoryScore,
  calculateOverallScore,
  compareScores,
  scoreColor,
  scoreLabel,
} from "../lib/scoring";
import { qualityGate } from "../types";
import type { Finding, CategoryScore } from "../types";

function finding(severity: Finding["severity"], confidence = 100): Finding {
  return {
    id: Math.random().toString(36).slice(2),
    scanId: "scan-test",
    websiteId: "site-test",
    category: "seo",
    severity,
    title: "Test finding",
    description: "",
    affectedUrls: [],
    evidence: [],
    recommendation: "",
    confidence,
    provenance: "MEASURED",
    verified: false,
    qualityScore: null,
    agentExecutionId: null,
    createdAt: new Date().toISOString(),
  };
}

function scoredCategory(value: number): CategoryScore {
  return { value, status: "scored", label: "", findingCount: 0, criticalCount: 0 };
}

describe("calculateCategoryScore", () => {
  it("returns 100 for no findings", () => {
    expect(calculateCategoryScore([])).toBe(100);
  });

  it("deducts 25 for one critical finding at full confidence", () => {
    expect(calculateCategoryScore([finding("critical")])).toBe(75);
  });

  it("deducts 12 for one high finding", () => {
    expect(calculateCategoryScore([finding("high")])).toBe(88);
  });

  it("deducts 5 for one medium finding", () => {
    expect(calculateCategoryScore([finding("medium")])).toBe(95);
  });

  it("deducts 2 for one low finding", () => {
    expect(calculateCategoryScore([finding("low")])).toBe(98);
  });

  it("deducts 0 for info findings", () => {
    expect(calculateCategoryScore([finding("info"), finding("info")])).toBe(100);
  });

  it("confidence-weights penalties (50% confidence = half penalty)", () => {
    // critical at 50% confidence → 12.5 penalty → round(100 - 12.5) = 88
    expect(calculateCategoryScore([finding("critical", 50)])).toBe(88);
  });

  it("floors at 0 and does not go negative", () => {
    const findings = Array.from({ length: 10 }, () => finding("critical"));
    expect(calculateCategoryScore(findings)).toBe(0);
  });

  it("is deterministic — same input same output", () => {
    const input = [finding("high"), finding("medium"), finding("low")];
    expect(calculateCategoryScore(input)).toBe(calculateCategoryScore(input));
  });
});

describe("calculateOverallScore", () => {
  it("returns 0 when no scored categories", () => {
    expect(calculateOverallScore({})).toBe(0);
  });

  it("returns the single score when only one category is scored", () => {
    const scores = { seo: scoredCategory(80) };
    expect(calculateOverallScore(scores)).toBe(80);
  });

  it("excludes not_measured categories from the weighted average", () => {
    const scores = {
      seo: scoredCategory(100),
      security: { value: null, status: "not_measured" as const, label: "", findingCount: 0, criticalCount: 0 },
    };
    expect(calculateOverallScore(scores)).toBe(100);
  });

  it("computes weighted average of two scored categories", () => {
    // seo=0.20, security=0.20 — equal weight so average = (80+60)/2 = 70
    const scores = { seo: scoredCategory(80), security: scoredCategory(60) };
    expect(calculateOverallScore(scores)).toBe(70);
  });
});

describe("compareScores", () => {
  it("identifies regressions correctly", () => {
    const deltas = compareScores({ seo: 90 }, { seo: 80 });
    expect(deltas[0].isRegression).toBe(true);
    expect(deltas[0].delta).toBe(-10);
  });

  it("identifies improvements correctly", () => {
    const deltas = compareScores({ seo: 70 }, { seo: 85 });
    expect(deltas[0].isImprovement).toBe(true);
    expect(deltas[0].delta).toBe(15);
  });

  it("returns null delta when previous is null", () => {
    const deltas = compareScores({ seo: null }, { seo: 80 });
    expect(deltas[0].delta).toBe(null);
    expect(deltas[0].isRegression).toBe(false);
    expect(deltas[0].isImprovement).toBe(false);
  });
});

describe("scoreColor", () => {
  it("returns grey for null", () => {
    expect(scoreColor(null)).toBe("#94a3b8");
  });

  it("returns green for 90+", () => {
    expect(scoreColor(95)).toBe("#10b981");
    expect(scoreColor(90)).toBe("#10b981");
  });

  it("returns blue for 80–89", () => {
    expect(scoreColor(85)).toBe("#3b82f6");
  });

  it("returns amber for 70–79", () => {
    expect(scoreColor(75)).toBe("#f59e0b");
  });

  it("returns red for below 70", () => {
    expect(scoreColor(65)).toBe("#ef4444");
    expect(scoreColor(0)).toBe("#ef4444");
  });
});

describe("scoreLabel", () => {
  it("returns Not Measured for null", () => {
    expect(scoreLabel(null)).toBe("Not Measured");
  });

  it("returns Excellent for 95+", () => {
    expect(scoreLabel(100)).toBe("Excellent");
    expect(scoreLabel(95)).toBe("Excellent");
  });

  it("returns Good for 90–94", () => {
    expect(scoreLabel(92)).toBe("Good");
  });

  it("returns Fair for 80–89", () => {
    expect(scoreLabel(82)).toBe("Fair");
  });

  it("returns Poor for 70–79", () => {
    expect(scoreLabel(74)).toBe("Poor");
  });

  it("returns Critical below 70", () => {
    expect(scoreLabel(50)).toBe("Critical");
  });
});

describe("qualityGate", () => {
  it("returns excellent for 95–100", () => {
    expect(qualityGate(100)).toBe("excellent");
    expect(qualityGate(95)).toBe("excellent");
  });

  it("returns accept for 90–94", () => {
    expect(qualityGate(94)).toBe("accept");
    expect(qualityGate(90)).toBe("accept");
  });

  it("returns improve for 80–89", () => {
    expect(qualityGate(85)).toBe("improve");
  });

  it("returns regenerate for 70–79", () => {
    expect(qualityGate(75)).toBe("regenerate");
  });

  it("returns failed for below 70", () => {
    expect(qualityGate(69)).toBe("failed");
    expect(qualityGate(0)).toBe("failed");
  });
});
