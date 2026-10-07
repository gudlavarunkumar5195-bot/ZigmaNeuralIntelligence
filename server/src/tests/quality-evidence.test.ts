import { describe, expect, it } from "vitest";
import { assessQuality } from "../ai/quality/evaluator.js";
import { QUALITY_POLICY_VERSION, checkEvidence } from "../ai/quality/evidence-check.js";
import type { AgentFinding, AgentResult } from "../ai/agents/types.js";
import type { EvidenceRecord } from "../ai/evidence/types.js";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const ex = { tenantId: "org-1", taskId: "scan-1", now: NOW };
const rec = (id: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({ evidenceId: id, tenantId: "org-1", taskId: "scan-1", evidenceType: "HTTP_RESPONSE", sourceType: "HTTP_CLIENT", sourceReference: "https://e.com", observedAt: new Date(NOW - 60_000).toISOString(), contentHash: "h", status: "ACTIVE", confidence: 100, freshnessStatus: "FRESH", collectedAt: "", createdAt: "", quality: {}, ...over });
const finding = (id: string, evidenceIds: string[]): AgentFinding => ({ findingId: id, title: "t", category: "SEO", severity: "LOW", description: "d", evidenceIds, confidence: 80, status: "OPEN" });
const result = (findings: AgentFinding[], over: Partial<AgentResult> = {}): AgentResult => ({ status: "SUCCESS", agentType: "SEO_ANALYSIS", agentVersion: "1", taskId: "scan-1", findings, evidenceReferences: [...new Set(findings.flatMap((f) => f.evidenceIds))], recommendations: [], confidence: 90, warnings: [], limitations: [], ...over });
const run = (r: AgentResult, records: EvidenceRecord[]) => assessQuality({ result: r, evidenceCheck: checkEvidence(r, records, ex) });

describe("quality gate evidence validation (F-009)", () => {
  it("records the bumped policy version", () => {
    const a = run(result([finding("f1", ["e1"])]), [rec("e1")]);
    expect(a.policyVersion).toBe(QUALITY_POLICY_VERSION);
    expect(Number(QUALITY_POLICY_VERSION)).toBeGreaterThan(1);
  });
  it("accepts findings backed by valid evidence with 100% coverage", () => {
    const a = run(result([finding("f1", ["e1"]), finding("f2", ["e2"])]), [rec("e1"), rec("e2")]);
    expect(a.status).toBe("ACCEPT");
    expect(a.evidenceSummary.coverage).toBe(1);
  });
  it("blocks nonexistent evidence ids", () => {
    const a = run(result([finding("f1", ["ghost"])]), []);
    expect(a.status).toBe("BLOCK");
    expect(a.reasonCodes).toContain("EVIDENCE_MISSING");
    expect(a.evidenceSummary.invalidEvidenceIds).toContain("ghost");
  });
  it("blocks foreign-tenant evidence", () => {
    const a = run(result([finding("f1", ["e1"])]), [rec("e1", { tenantId: "org-2" })]);
    expect(a.status).toBe("BLOCK");
    expect(a.evidenceSummary.unsupportedFindingIds).toEqual(["f1"]);
  });
  it("blocks evidence from another task/scan", () => {
    const a = run(result([finding("f1", ["e1"])]), [rec("e1", { taskId: "scan-2" })]);
    expect(a.status).toBe("BLOCK");
  });
  it("does not accept stale evidence", () => {
    const old = new Date(NOW - 3 * 24 * 3600_000).toISOString();
    const a = run(result([finding("f1", ["e1"])]), [rec("e1", { observedAt: old })]);
    expect(a.status).not.toBe("ACCEPT");
    expect(a.reasonCodes).toContain("STALE_EVIDENCE");
    expect(a.evidenceSummary.staleEvidenceIds).toEqual(["e1"]);
  });
  it("blocks findings with empty evidence", () => {
    const a = run(result([finding("f1", [])], { evidenceReferences: ["e1"] }), [rec("e1")]);
    expect(a.status).toBe("BLOCK");
  });
  it("computes real coverage for mixed findings and never accepts partial grounding", () => {
    const r = result([finding("f1", ["e1"]), finding("f2", ["ghost"]), finding("f3", ["e1"]), finding("f4", [])]);
    const check = checkEvidence(r, [rec("e1")], ex);
    expect(check.coverage).toBe(0.5);
    const a = assessQuality({ result: r, evidenceCheck: check });
    expect(a.status).toBe("BLOCK");
    expect(a.evidenceSummary.unsupportedFindingIds).toEqual(["f2", "f4"]);
  });
  it("does not trust unverified evidence (no evidence check supplied)", () => {
    expect(assessQuality({ result: result([finding("f1", ["e1"])]) }).status).not.toBe("ACCEPT");
  });
  it("a failed policy gate blocks", () => {
    const r = result([finding("f1", ["e1"])]);
    expect(assessQuality({ result: r, evidenceCheck: checkEvidence(r, [rec("e1")], ex), policyGate: { passed: false } }).status).toBe("BLOCK");
  });
  describe("zero findings", () => {
    it("accepts a legitimate clean scan: SUCCESS, valid fresh evidence, declared confidence", () => {
      expect(run(result([], { evidenceReferences: ["e1"] }), [rec("e1")]).status).toBe("ACCEPT");
    });
    it("does not accept an empty result with no evidence", () => {
      const a = run(result([], { evidenceReferences: [] }), []);
      expect(a.status).toBe("BLOCK");
    });
    it("does not accept an empty result whose evidence is foreign or stale", () => {
      expect(run(result([], { evidenceReferences: ["e1"] }), [rec("e1", { tenantId: "org-2" })]).status).toBe("BLOCK");
      expect(run(result([], { evidenceReferences: ["e1"] }), [rec("e1", { observedAt: new Date(NOW - 5 * 24 * 3600_000).toISOString() })]).status).not.toBe("ACCEPT");
    });
    it("does not accept PARTIAL or no-confidence empty results", () => {
      expect(run(result([], { evidenceReferences: ["e1"], status: "PARTIAL" }), [rec("e1")]).status).not.toBe("ACCEPT");
      expect(run(result([], { evidenceReferences: ["e1"], confidence: 0 }), [rec("e1")]).status).not.toBe("ACCEPT");
    });
  });
});
