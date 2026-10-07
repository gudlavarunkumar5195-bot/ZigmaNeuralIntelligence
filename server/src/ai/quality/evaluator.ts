import { randomUUID } from "node:crypto";
import { QUALITY_POLICY_VERSION, DEFAULT_MAX_EVIDENCE_AGE_MS } from "./evidence-check.js";
import type { QualityAssessment, QualityDimension, QualityInput, QualityPolicy, QualityReason } from "./types.js";
export const DEFAULT_QUALITY_POLICY: QualityPolicy = { version: QUALITY_POLICY_VERSION, maxEvidenceAgeMs: DEFAULT_MAX_EVIDENCE_AGE_MS, minimumGroundingCoverage: 1, minimumCleanScanConfidence: 50, weights: { REQUIREMENT_COMPLIANCE: 20, EVIDENCE_GROUNDING: 20, EVIDENCE_COMPLETENESS: 15, FINDING_QUALITY: 15, COVERAGE: 10, INSTRUCTION_COMPLIANCE: 10, CONSISTENCY: 5, OUTPUT_VALIDITY: 5 }, acceptThreshold: 90, improveThreshold: 60, minimumCoverage: 0.9 };
const dimension = (score: number, explanation: string) => ({ score, applicable: true, explanation });
export function assessQuality(input: QualityInput, policy: QualityPolicy = DEFAULT_QUALITY_POLICY): QualityAssessment {
  const result = input.result; const required = input.requiredCoverage ?? 0; const covered = input.coveredResources ?? required; const coverage = required ? Math.max(0, Math.min(100, Math.round((covered / required) * 100))) : 100;
  const findingEvidence = result.findings.flatMap((finding) => finding.evidenceIds);
  const check = input.evidenceCheck; const hasFindings = result.findings.length > 0;
  // Zero findings are acceptable only for a SUCCESS result backed by at least one valid, fresh
  // evidence record and a declared confidence at or above the policy floor (a verified clean scan).
  const cleanScan = !hasFindings && !!check && result.status === "SUCCESS" && check.validReferenced > 0 && result.confidence >= policy.minimumCleanScanConfidence;
  const unsupported = check ? check.findings.filter((item) => !item.supported) : [];
  const hardUnsupported = unsupported.filter((item) => item.failures.some((failure) => failure !== "STALE"));
  const staleFailures = check ? check.staleEvidenceIds.length > 0 || unsupported.some((item) => item.failures.includes("STALE")) : false;
  const gatePassed = input.policyGate?.passed !== false;
  let evidenceValid = input.evidenceValid ?? true; let grounding: number;
  if (!check) grounding = input.evidenceValid === false ? 0 : 50;
  else if (hasFindings) { grounding = Math.round(check.coverage * 100); evidenceValid = hardUnsupported.length === 0; }
  else { grounding = cleanScan ? 100 : 0; evidenceValid = cleanScan || check.validReferenced > 0; }
  const groundingExplanation = !check ? "Evidence was not verified against stored records." : hasFindings ? `${check.supportedFindings} of ${check.totalFindings} findings are supported by valid evidence.` : cleanScan ? "No findings, and the result is backed by valid, fresh evidence with declared coverage." : "An empty result is not backed by valid evidence and declared coverage.";
  const outputValid = result.status !== "FAILED" ? 100 : 0; const instructionValid = input.instructionValid ?? true; const securityOk = !input.securityViolation && !input.unauthorizedTool && gatePassed;
  const scores: Partial<Record<QualityDimension, { score: number; applicable: boolean; explanation: string }>> = {
    REQUIREMENT_COMPLIANCE: dimension(coverage, required ? `${covered} of ${required} required scope units covered.` : "No explicit coverage scope was supplied."), OUTPUT_VALIDITY: dimension(outputValid, outputValid ? "Structured result is valid." : "Agent result failed output validation."), EVIDENCE_GROUNDING: dimension(grounding, groundingExplanation), EVIDENCE_COMPLETENESS: dimension(input.evidenceFresh === false || staleFailures ? 50 : grounding, input.evidenceFresh === false || staleFailures ? "Referenced evidence is stale." : "Evidence completeness follows grounded findings."), FINDING_QUALITY: dimension(result.findings.every((finding) => finding.title && finding.description) ? 100 : 0, "Finding structure was inspected deterministically."), COVERAGE: dimension(coverage, `${covered} of ${required || covered} scoped units covered.`), INSTRUCTION_COMPLIANCE: dimension(instructionValid ? 100 : 0, instructionValid ? "Required output and instruction constraints are satisfied." : "Instruction contract was not satisfied."), CONSISTENCY: dimension(100, "No deterministic contradiction was supplied."), SECURITY_COMPLIANCE: dimension(securityOk ? 100 : 0, securityOk ? "No security or permission violation was supplied." : "Security or permission violation detected."),
  };
  const blockingIssues: string[] = []; const reasonCodes: QualityReason[] = []; const improvementTargets: QualityAssessment["improvementTargets"] = [];
  const add = (code: QualityReason, key: QualityDimension, target: string, block = false) => { reasonCodes.push(code); improvementTargets.push({ dimension: key, reasonCode: code, target }); if (block) blockingIssues.push(target); };
  if (!securityOk) add(input.unauthorizedTool ? "UNAUTHORIZED_TOOL" : "SECURITY_VIOLATION", "SECURITY_COMPLIANCE", "Resolve the security or tool-permission violation before continuing.", true);
  if (!outputValid) add("OUTPUT_INVALID", "OUTPUT_VALIDITY", "Return a valid structured agent result.", true);
  if (!evidenceValid || (check ? hardUnsupported.length > 0 || (!hasFindings && !cleanScan && check.validReferenced === 0) : grounding === 0)) add("EVIDENCE_MISSING", "EVIDENCE_GROUNDING", "Provide valid evidence for every factual finding.", true);
  else if (check && !hasFindings && !cleanScan) add("EVIDENCE_INCOMPLETE", "EVIDENCE_GROUNDING", "An empty result requires a SUCCESS status and declared coverage over valid evidence.");
  else if (!check) add("EVIDENCE_INCOMPLETE", "EVIDENCE_GROUNDING", "Evidence references were not verified against stored evidence.");
  if (input.evidenceFresh === false || staleFailures) add("STALE_EVIDENCE", "EVIDENCE_COMPLETENESS", "Collect fresh evidence for time-sensitive findings.");
  if (coverage < policy.minimumCoverage * 100) add("LOW_COVERAGE", "COVERAGE", `Analyze the remaining ${Math.max(0, required - covered)} scoped resources.`);
  if (!instructionValid) add("INSTRUCTION_VIOLATION", "INSTRUCTION_COMPLIANCE", "Satisfy the mandatory instruction and output contract.", true);
  const score = Math.round(Object.entries(policy.weights).reduce((sum, [key, weight]) => sum + (scores[key as QualityDimension]?.score ?? 0) * (weight ?? 0), 0) / 100);
  const mustImprove = !check || staleFailures || (hasFindings ? check.coverage < policy.minimumGroundingCoverage : !cleanScan);
  const scored = score >= policy.acceptThreshold ? (mustImprove ? "NEEDS_IMPROVEMENT" : "ACCEPT") : score >= policy.improveThreshold ? "NEEDS_IMPROVEMENT" : "REJECT";
  const status = blockingIssues.length ? "BLOCK" : scored;
  if (status !== "ACCEPT" && !reasonCodes.includes("LOW_QUALITY_SCORE")) reasonCodes.push("LOW_QUALITY_SCORE");
  return { qualityAssessmentId: randomUUID(), taskId: result.taskId, executionId: result.executionId, agentId: result.agentType, agentVersion: result.agentVersion, routingId: result.routingId, instructionPlanId: result.instructionPlanId, status, overallScore: score, dimensionScores: scores, blockingIssues, warnings: [], reasonCodes, improvementTargets, evidenceSummary: { referenced: result.evidenceReferences.length, grounded: check ? check.supportedFindings : findingEvidence.length, verified: !!check, ...(check ? { coverage: check.coverage, totalFindings: check.totalFindings, unsupportedFindingIds: unsupported.map((item) => item.findingId), invalidEvidenceIds: check.invalidEvidenceIds, staleEvidenceIds: check.staleEvidenceIds } : {}) }, requirementSummary: { required, covered }, qualityConfidence: securityOk && evidenceValid && !!check ? 100 : 50, policyVersion: policy.version, createdAt: new Date().toISOString() };
}
