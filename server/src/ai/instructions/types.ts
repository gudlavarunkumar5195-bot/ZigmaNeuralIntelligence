import type { AgentRiskLevel, AgentResult, AgentType } from "../agents/types.js";

export const INSTRUCTION_TYPES = ["SYSTEM", "PLATFORM_POLICY", "AGENT", "TASK", "SPECIALIZATION", "VALIDATION", "OUTPUT_FORMAT", "EVIDENCE", "SAFETY"] as const;
export type InstructionType = (typeof INSTRUCTION_TYPES)[number];
export const INSTRUCTION_REASON_CODES = ["SPECIALIZED_TASK", "UNUSUAL_INPUT", "INSUFFICIENT_BASE_INSTRUCTIONS", "HIGH_RISK", "OUTPUT_CONSTRAINT", "EVIDENCE_GAP", "DEPENDENCY_RESULT", "PREVIOUS_FAILURE", "QUALITY_IMPROVEMENT", "DOMAIN_SPECIFIC_REQUIREMENT"] as const;
export type InstructionReasonCode = (typeof INSTRUCTION_REASON_CODES)[number];
export type InstructionTrust = "TRUSTED" | "CONTROLLED" | "UNTRUSTED";
export type InstructionPlanStatus = "SUFFICIENT" | "ADDITIONAL_INSTRUCTIONS_REQUIRED" | "INTEGRATION_REQUIRED" | "REJECTED";
export type ValidationStatus = "APPROVED" | "REJECTED";

export interface InstructionItem {
  id: string;
  type: InstructionType;
  text: string;
  mandatory: boolean;
  source: InstructionTrust;
  version: string;
}

export interface InstructionProfile {
  instructionProfileId: string;
  agentId: AgentType;
  agentVersion: string;
  version: string;
  instructions: InstructionItem[];
  requiredContext: string[];
  outputRequirements: Record<string, unknown>;
  validationRules: string[];
  status: "ACTIVE" | "DEPRECATED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface InstructionPlan {
  instructionPlanId: string;
  taskId: string;
  agentId: AgentType;
  agentVersion: string;
  profileVersion: string;
  status: InstructionPlanStatus;
  baseInstructionIds: string[];
  additionalInstructions: InstructionItem[];
  reasonCodes: InstructionReasonCode[];
  explanation: string;
  constraints: string[];
  outputContract: Record<string, unknown>;
  evidenceRequirements: string[];
  validationRequirements: string[];
  createdAt: string;
  decisionSource: "OX_ALPHA" | "DETERMINISTIC";
}

export interface ValidationResult {
  status: ValidationStatus;
  violations: string[];
  validatedAt: string;
}

export interface ComposedInstructionSet {
  instructionSetId: string;
  versions: { profileVersion: string; planVersion: string; agentVersion: string };
  orderedSections: InstructionItem[];
  hash: string;
  createdAt: string;
}

export interface InstructionPlanningInput {
  taskId: string;
  agentType: AgentType;
  agentVersion: string;
  riskLevel: AgentRiskLevel;
  context: Record<string, unknown>;
  evidenceReferences: string[];
  previousFailure?: string;
  agentResultContext?: Pick<AgentResult, "status" | "warnings" | "limitations">;
}
