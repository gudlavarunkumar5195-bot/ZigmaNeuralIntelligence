// Phase 3D: Specialist Agent Framework — shared types.
//
// Separation of concerns:
//   AgentDefinition  — what work needs to be done + tool permissions
//   AgentInput       — per-execution input contract
//   AgentResult      — per-execution structured output
//   Phase 3C router  — which model executes the agent
//
// Agent confidence ≠ routing confidence.
//   Routing confidence: "Was this a good model choice?"
//   Agent confidence:   "How confident is this analysis given the evidence?"

export const AGENT_TYPES = [
  "DISCOVERY",
  "SEO_ANALYSIS",
  "AEO_ANALYSIS",
  "GEO_ANALYSIS",
  "SECURITY_ANALYSIS",
  "PERFORMANCE_ANALYSIS",
  "ACCESSIBILITY_ANALYSIS",
  "QA_ANALYSIS",
  "SSL_ANALYSIS",
  "REMEDIATION",
  "REPORT_SYNTHESIS",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export type AgentStatus = "ACTIVE" | "DISABLED" | "DEPRECATED" | "REQUIRES_REVIEW";
export type AgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// Tool permission levels — EXECUTE requires explicit authorization
export type PermissionLevel = "READ" | "ANALYZE" | "GENERATE" | "PROPOSE" | "EXECUTE";

export type DependencyType = "REQUIRED" | "OPTIONAL";

export type FailureType =
  | "RETRYABLE"
  | "NON_RETRYABLE"
  | "DEPENDENCY_FAILURE"
  | "TOOL_FAILURE"
  | "MODEL_FAILURE"
  | "VALIDATION_FAILURE"
  | "AUTHORIZATION_FAILURE";

export type FindingSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FindingStatus = "OPEN" | "CONFIRMED" | "DISPUTED" | "RESOLVED" | "IGNORED";
export type WorkflowStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "BLOCKED"
  | "WAITING";

// ─── Agent tool definition ────────────────────────────────────────────────────

export interface AgentTool {
  name: string;
  permissionLevel: PermissionLevel;
  description: string;
}

// ─── Agent dependency declaration ────────────────────────────────────────────

export interface AgentDependency {
  agentType: AgentType;
  dependencyType: DependencyType;
}

// ─── Agent definition (global, not tenant-specific) ──────────────────────────

export interface AgentDefinition {
  agentType: AgentType;
  name: string;
  description: string;
  version: string;
  status: AgentStatus;
  riskLevel: AgentRiskLevel;
  // Agent-level capabilities (different from model capabilities)
  capabilities: string[];
  // Explicit tool allowlist — agents never receive unrestricted access
  allowedTools: AgentTool[];
  // Dependency declarations for workflow graph
  dependencies: AgentDependency[];
  // What model capabilities are required for the Phase 3C router
  requiredModelCapabilities: string[];
  preferredModelCapabilities: string[];
  producesFindings: boolean;
  enabled: boolean;
  // Predefined instruction profile — Phase 3E will make this dynamic
  instructionProfile: string;
}

// ─── Agent input contract ─────────────────────────────────────────────────────
// Every agent receives structured input. No arbitrary raw context injected.
// Website content is never passed as instructions — only as labeled, untrusted evidence.

export interface AgentInput {
  taskId: string;
  scanId?: string;
  websiteId?: string;
  tenantId: string;
  target?: string;
  userId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  agentType: AgentType;
  agentVersion: string;
  // Only reference IDs to stored evidence — never raw website content in instructions
  evidenceReferences: string[];
  riskLevel: AgentRiskLevel;
  // Structured context provided by the orchestration layer (not user/website content)
  context: Record<string, unknown>;
  // Explicit tool allowlist for this execution (subset of agent's allowed tools)
  allowedTools?: string[];
  // Agents whose results are already available (for dependency checking)
  satisfiedDependencies?: string[];
  correlationId?: string;
  // simulate=true: skip model execution, return deterministic stub
  simulate?: boolean;
}

// ─── Agent finding structure ──────────────────────────────────────────────────
// Evidence IDs must resolve to actual stored evidence — model cannot fabricate them.

export interface AgentFinding {
  findingId: string;
  title: string;
  category: string;
  severity: FindingSeverity;
  description: string;
  affectedResource?: string;
  // Must reference real stored evidence IDs — validated before acceptance
  evidenceIds: string[];
  confidence: number;     // 0–100
  impact?: string;
  recommendation?: string;
  status: FindingStatus;
}

// ─── Agent result (structured output contract) ────────────────────────────────
// Raw model text is stored separately for audit; this is the validated result.

export interface AgentResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED";
  agentType: AgentType;
  agentVersion: string;
  taskId: string;
  findings: AgentFinding[];
  evidenceReferences: string[];
  recommendations: string[];
  // Agent confidence in its own analysis (0–100) — separate from routing confidence
  confidence: number;
  warnings: string[];
  limitations: string[];
  // Execution metadata
  executionId?: string;
  routingId?: string;
  modelId?: string;
  latencyMs?: number;
  simulate?: boolean;
  instructionPlanId?: string;
  instructionProfileVersion?: string;
  composedInstructionHash?: string;
}

// ─── Workflow node (for dependency graph) ─────────────────────────────────────

export interface WorkflowNode {
  agentType: AgentType;
  status: WorkflowStatus;
  dependencies: AgentType[];
  result?: AgentResult;
  error?: string;
  failureType?: FailureType;
}

// ─── Agent execution failure ──────────────────────────────────────────────────

export interface AgentExecutionError {
  failureType: FailureType;
  message: string;
  retryable: boolean;
  agentType: AgentType;
  attempt: number;
}
