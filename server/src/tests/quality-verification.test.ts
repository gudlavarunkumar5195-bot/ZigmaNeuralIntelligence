import { describe, expect, it } from "vitest";
import { assessQuality } from "../ai/quality/evaluator.js";
import type { AgentResult } from "../ai/agents/types.js";
const result = (evidenceIds = ["e-1"]): AgentResult => ({ status: "SUCCESS", agentType: "SEO_ANALYSIS", agentVersion: "1", taskId: "task-1", findings: [{ findingId: "f-1", title: "Canonical missing", category: "SEO", severity: "MEDIUM", description: "No canonical", evidenceIds, confidence: 90, status: "OPEN" }], evidenceReferences: evidenceIds, recommendations: [], confidence: 99, warnings: [], limitations: [] });
describe("Quality Verification", () => {
  it("accepts a fully grounded, covered and valid result", () => { const assessment = assessQuality({ result: result(), requiredCoverage: 10, coveredResources: 10 }); expect(assessment.status).toBe("ACCEPT"); expect(assessment.overallScore).toBe(100); });
  it("blocks missing factual evidence regardless of score", () => { const assessment = assessQuality({ result: result([]), evidenceValid: false }); expect(assessment.status).toBe("BLOCK"); expect(assessment.reasonCodes).toContain("EVIDENCE_MISSING"); });
  it("blocks security violations regardless of score", () => { const assessment = assessQuality({ result: result(), securityViolation: true }); expect(assessment.status).toBe("BLOCK"); expect(assessment.reasonCodes).toContain("SECURITY_VIOLATION"); });
  it("identifies low coverage with an explicit improvement target", () => { const assessment = assessQuality({ result: result(), requiredCoverage: 100, coveredResources: 20 }); expect(assessment.status).toBe("NEEDS_IMPROVEMENT"); expect(assessment.reasonCodes).toContain("LOW_COVERAGE"); expect(assessment.improvementTargets[0].target).toContain("remaining 80"); });
});
