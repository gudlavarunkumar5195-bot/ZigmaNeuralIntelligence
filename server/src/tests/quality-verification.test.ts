import { describe, expect, it } from "vitest";
import { assessQuality } from "../ai/quality/evaluator.js";
import type { AgentResult } from "../ai/agents/types.js";
import { checkEvidence } from "../ai/quality/evidence-check.js";
import type { EvidenceRecord } from "../ai/evidence/types.js";
// Evidence records that really back result() (same tenant + task, fresh). The old tests passed no evidence check, which the gate now treats as unverified (policy v2).
const record = (id: string): EvidenceRecord => ({ evidenceId: id, tenantId: "org-1", taskId: "task-1", evidenceType: "HTTP_RESPONSE", sourceType: "HTTP_CLIENT", sourceReference: "https://example.com", observedAt: new Date().toISOString(), contentHash: "h", status: "ACTIVE", confidence: 100, freshnessStatus: "FRESH", collectedAt: new Date().toISOString(), createdAt: new Date().toISOString(), quality: {} });
const verified = (r: AgentResult) => checkEvidence(r, r.evidenceReferences.map(record), { tenantId: "org-1", taskId: "task-1" });
const result = (evidenceIds = ["e-1"]): AgentResult => ({ status: "SUCCESS", agentType: "SEO_ANALYSIS", agentVersion: "1", taskId: "task-1", findings: [{ findingId: "f-1", title: "Canonical missing", category: "SEO", severity: "MEDIUM", description: "No canonical", evidenceIds, confidence: 90, status: "OPEN" }], evidenceReferences: evidenceIds, recommendations: [], confidence: 99, warnings: [], limitations: [] });
describe("Quality Verification", () => {
  it("accepts a fully grounded, covered and valid result", () => { const assessment = assessQuality({ result: result(), evidenceCheck: verified(result()), requiredCoverage: 10, coveredResources: 10 }); expect(assessment.status).toBe("ACCEPT"); expect(assessment.overallScore).toBe(100); });
  it("blocks missing factual evidence regardless of score", () => { const assessment = assessQuality({ result: result([]), evidenceValid: false }); expect(assessment.status).toBe("BLOCK"); expect(assessment.reasonCodes).toContain("EVIDENCE_MISSING"); });
  it("blocks security violations regardless of score", () => { const assessment = assessQuality({ result: result(), securityViolation: true }); expect(assessment.status).toBe("BLOCK"); expect(assessment.reasonCodes).toContain("SECURITY_VIOLATION"); });
  it("identifies low coverage with an explicit improvement target", () => { const assessment = assessQuality({ result: result(), evidenceCheck: verified(result()), requiredCoverage: 100, coveredResources: 20 }); expect(assessment.status).toBe("NEEDS_IMPROVEMENT"); expect(assessment.reasonCodes).toContain("LOW_COVERAGE"); expect(assessment.improvementTargets[0].target).toContain("remaining 80"); });
});
