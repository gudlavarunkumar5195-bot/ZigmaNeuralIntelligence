import { randomUUID } from "node:crypto";
import type { QualityAssessment } from "../quality/types.js";
import type { AdaptationDecision, AdaptationStrategy, RootCause } from "./types.js";
export function planAdaptation(assessment: QualityAssessment, options: { currentAgent: AdaptationDecision["selectedAgents"][number]; eligibleModels?: string[]; highRisk?: boolean } ): AdaptationDecision {
  const codes = assessment.reasonCodes; const causes: RootCause[] = []; let strategy: AdaptationStrategy = "NEW_MODEL"; let instructionChanges: string[] = []; let evidenceRequests: string[] = []; let selectedModels: string[] = []; let parallelTasks: AdaptationDecision["parallelTasks"] = [];
  if (assessment.status === "ACCEPT" || assessment.status === "BLOCK") { strategy = "STOP"; causes.push(assessment.status === "BLOCK" ? "SECURITY_PROBLEM" : "QUALITY_PROBLEM"); }
  else if (codes.includes("EVIDENCE_MISSING") || codes.includes("EVIDENCE_INCOMPLETE") || codes.includes("STALE_EVIDENCE")) { strategy = "MORE_EVIDENCE"; causes.push("EVIDENCE_PROBLEM"); evidenceRequests = assessment.improvementTargets.map(t => t.target).filter(Boolean); }
  else if (codes.includes("LOW_COVERAGE")) { strategy = "MORE_EVIDENCE"; causes.push("COVERAGE_PROBLEM"); evidenceRequests = assessment.improvementTargets.map(t => t.target); }
  else if (codes.includes("INSTRUCTION_VIOLATION")) { strategy = "SAME_MODEL_NEW_INSTRUCTIONS"; causes.push("INSTRUCTION_PROBLEM"); instructionChanges = assessment.improvementTargets.map(t => t.target); }
  else if (options.highRisk) { strategy = "INDEPENDENT_VERIFICATION"; causes.push("AMBIGUITY"); selectedModels = options.eligibleModels?.slice(0, 1) ?? []; }
  else { causes.push("MODEL_CAPABILITY_PROBLEM"); selectedModels = options.eligibleModels?.slice(0, 1) ?? []; }
  return { adaptationId: randomUUID(), qualityAssessmentId: assessment.qualityAssessmentId, strategy, selectedModels, selectedAgents: [options.currentAgent], instructionChanges, evidenceRequests, parallelTasks, reasonCodes: codes, rootCauses: causes, confidence: assessment.qualityConfidence, qualityBefore: assessment.overallScore, createdAt: new Date().toISOString() };
}
