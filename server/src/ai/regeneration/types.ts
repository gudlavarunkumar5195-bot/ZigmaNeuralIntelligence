import type { QualityAssessment, QualityReason } from "../quality/types.js";
export type RegenerationStatus = "PLANNED" | "WAITING_FOR_EVIDENCE" | "REGENERATING" | "VERIFYING" | "ACCEPTED" | "REJECTED" | "BLOCKED" | "EXHAUSTED" | "FAILED" | "CANCELLED";
export type ImprovementStrategy = "COLLECT_MORE_EVIDENCE" | "RETRY_SAME_AGENT_DIFFERENT_MODEL" | "RETRY_SAME_MODEL_IMPROVED_INSTRUCTIONS" | "RETRY_DIFFERENT_AGENT" | "RETRY_DIFFERENT_MODEL_AND_AGENT" | "RECOMPUTE_WITH_NEW_EVIDENCE" | "REQUEST_HUMAN_REVIEW" | "STOP";
export interface RegenerationPolicy { version: string; maxIterations: number; maxModelCalls: number; maxDurationMs: number; plateauLimit: number; }
export interface ImprovementDiagnosis { diagnosisId: string; qualityAssessmentId: string; rootCauses: string[]; recommendedStrategy: ImprovementStrategy; reasonCodes: QualityReason[]; confidence: number; createdAt: string; }
export interface RegenerationPlan { status: RegenerationStatus; strategy: ImprovementStrategy; reason: string; diagnosis: ImprovementDiagnosis; bestScore: number; qualityDelta?: number; }
export const DEFAULT_REGENERATION_POLICY: RegenerationPolicy = { version: "1", maxIterations: 3, maxModelCalls: 6, maxDurationMs: 300000, plateauLimit: 2 };
export type AssessmentHistory = Pick<QualityAssessment, "overallScore" | "status">[];
