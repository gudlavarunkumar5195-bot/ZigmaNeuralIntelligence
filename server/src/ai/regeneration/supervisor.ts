import { randomUUID } from "node:crypto";
import type { QualityAssessment } from "../quality/types.js";
import { DEFAULT_REGENERATION_POLICY, type AssessmentHistory, type ImprovementStrategy, type RegenerationPlan, type RegenerationPolicy } from "./types.js";
export function planRegeneration(assessment: QualityAssessment, history: AssessmentHistory, policy: RegenerationPolicy = DEFAULT_REGENERATION_POLICY): RegenerationPlan {
  const causes: string[] = []; let strategy: ImprovementStrategy = "STOP"; let status: RegenerationPlan["status"] = "PLANNED";
  if (assessment.status === "ACCEPT") return { status: "ACCEPTED", strategy: "STOP", reason: "Current result is accepted by the quality policy.", diagnosis: diagnosis(assessment, ["QUALITY_ACCEPTED"], "STOP"), bestScore: Math.max(...history.map(x => x.overallScore), assessment.overallScore) };
  if (assessment.status === "BLOCK") return { status: "BLOCKED", strategy: "STOP", reason: "A deterministic quality blocker cannot be overridden.", diagnosis: diagnosis(assessment, ["DETERMINISTIC_BLOCK"], "STOP"), bestScore: Math.max(...history.map(x => x.overallScore), assessment.overallScore) };
  if (history.length >= policy.maxIterations) return { status: "EXHAUSTED", strategy: "STOP", reason: "Maximum regeneration iterations reached.", diagnosis: diagnosis(assessment, ["ITERATION_LIMIT"], "STOP"), bestScore: Math.max(...history.map(x => x.overallScore), assessment.overallScore) };
  if (assessment.reasonCodes.includes("EVIDENCE_MISSING") || assessment.reasonCodes.includes("EVIDENCE_INCOMPLETE") || assessment.reasonCodes.includes("STALE_EVIDENCE")) { causes.push("INSUFFICIENT_EVIDENCE"); strategy = "COLLECT_MORE_EVIDENCE"; status = "WAITING_FOR_EVIDENCE"; }
  else if (assessment.reasonCodes.includes("INSTRUCTION_VIOLATION")) { causes.push("INSUFFICIENT_INSTRUCTIONS"); strategy = "RETRY_SAME_MODEL_IMPROVED_INSTRUCTIONS"; }
  else if (assessment.reasonCodes.includes("EVIDENCE_CONFLICT") || assessment.reasonCodes.includes("INTERNAL_CONTRADICTION")) { causes.push("CONTRADICTION"); strategy = "RECOMPUTE_WITH_NEW_EVIDENCE"; status = "WAITING_FOR_EVIDENCE"; }
  else { causes.push("LOW_REASONING_QUALITY"); strategy = "RETRY_SAME_AGENT_DIFFERENT_MODEL"; }
  const prior = history.at(-1)?.overallScore; const delta = prior === undefined ? undefined : assessment.overallScore - prior;
  if (history.length >= policy.plateauLimit && delta !== undefined && delta <= 0) { strategy = "REQUEST_HUMAN_REVIEW"; status = "BLOCKED"; causes.push("QUALITY_PLATEAU"); }
  return { status, strategy, reason: `Improvement required: ${causes.join(", ")}.`, diagnosis: diagnosis(assessment, causes, strategy), bestScore: Math.max(...history.map(x => x.overallScore), assessment.overallScore), qualityDelta: delta };
}
function diagnosis(assessment: QualityAssessment, causes: string[], strategy: ImprovementStrategy) { return { diagnosisId: randomUUID(), qualityAssessmentId: assessment.qualityAssessmentId, rootCauses: causes, recommendedStrategy: strategy, reasonCodes: assessment.reasonCodes, confidence: assessment.qualityConfidence, createdAt: new Date().toISOString() }; }
