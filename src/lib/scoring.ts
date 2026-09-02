import type { Finding, Severity, IntelligenceScores, CategoryScore } from "../types";

// ─── Weight Table ─────────────────────────────────────────────────────────────

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0,
};

// Maximum penalty before score floors at 0
const MAX_PENALTY = 100;

/**
 * Calculates a 0–100 category score from a set of findings.
 * Each finding subtracts a weighted penalty from 100.
 * Score is deterministic: same findings → same score.
 */
export function calculateCategoryScore(findings: Finding[]): number {
  const totalPenalty = findings.reduce((sum, f) => {
    const base = SEVERITY_PENALTY[f.severity] ?? 0;
    // Confidence-weighted penalty (a 50% confidence finding counts half)
    const weighted = base * (f.confidence / 100);
    return sum + weighted;
  }, 0);

  return Math.max(0, Math.round(100 - Math.min(totalPenalty, MAX_PENALTY)));
}

/**
 * Calculates the overall score as a weighted average of category scores.
 * Categories with no measurement are excluded from the average.
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  seo: 0.20,
  security: 0.20,
  performance: 0.15,
  accessibility: 0.10,
  aiVisibility: 0.10,
  technicalHealth: 0.10,
  ssl: 0.10,
  qa: 0.05,
};

export function calculateOverallScore(scores: Record<string, CategoryScore>): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    const score = scores[key];
    if (score && score.status === "scored" && score.value !== null) {
      weightedSum += score.value * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return Math.round(weightedSum / totalWeight);
}

/**
 * Builds an empty IntelligenceScores object for scans that haven't run yet.
 */
export function emptyScores(): IntelligenceScores {
  const empty: CategoryScore = { value: null, status: "not_measured", label: "", findingCount: 0, criticalCount: 0 };
  return {
    overall: { ...empty, label: "Overall" },
    seo: { ...empty, label: "SEO" },
    aiVisibility: { ...empty, label: "AI Visibility" },
    security: { ...empty, label: "Security" },
    performance: { ...empty, label: "Performance" },
    accessibility: { ...empty, label: "Accessibility" },
    technicalHealth: { ...empty, label: "Technical Health" },
    ssl: { ...empty, label: "SSL" },
    qa: { ...empty, label: "QA" },
  };
}

/**
 * Returns the display color for a score value.
 */
export function scoreColor(score: number | null): string {
  if (score === null) return "#94a3b8";
  if (score >= 90) return "#10b981";
  if (score >= 80) return "#3b82f6";
  if (score >= 70) return "#f59e0b";
  return "#ef4444";
}

/**
 * Returns a human-readable label for a score value.
 */
export function scoreLabel(score: number | null): string {
  if (score === null) return "Not Measured";
  if (score >= 95) return "Excellent";
  if (score >= 90) return "Good";
  if (score >= 80) return "Fair";
  if (score >= 70) return "Poor";
  return "Critical";
}

/**
 * Compares two category scores and returns the delta.
 * Used by the monitoring engine to detect regressions.
 */
export interface ScoreDelta {
  category: string;
  previous: number | null;
  current: number | null;
  delta: number | null;
  isRegression: boolean;
  isImprovement: boolean;
}

export function compareScores(
  previous: Record<string, number | null>,
  current: Record<string, number | null>
): ScoreDelta[] {
  return Object.keys(current).map((key) => {
    const prev = previous[key] ?? null;
    const curr = current[key] ?? null;
    const delta = prev !== null && curr !== null ? curr - prev : null;
    return {
      category: key,
      previous: prev,
      current: curr,
      delta,
      isRegression: delta !== null && delta < 0,
      isImprovement: delta !== null && delta > 0,
    };
  });
}
