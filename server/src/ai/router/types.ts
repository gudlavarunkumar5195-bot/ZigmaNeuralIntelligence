// Phase 3C: Shared types for the OX Alpha routing engine.
// No LLM may modify hard eligibility or security constraints defined here.

// ─── Task types ───────────────────────────────────────────────────────────────

export const TASK_TYPES = [
  "DISCOVERY",
  "SEO_ANALYSIS",
  "AEO_ANALYSIS",
  "GEO_ANALYSIS",
  "SECURITY_ANALYSIS",
  "PERFORMANCE_ANALYSIS",
  "ACCESSIBILITY_ANALYSIS",
  "TECHNICAL_HEALTH_ANALYSIS",
  "QA_ANALYSIS",
  "SSL_ANALYSIS",
  "REMEDIATION",
  "CODE_GENERATION",
  "REPORT_SYNTHESIS",
  "EVIDENCE_SUMMARIZATION",
  "STRUCTURED_EXTRACTION",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export type TaskComplexity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// ─── Model capabilities (routing layer view) ──────────────────────────────────

export type ModelCapability =
  | "REASONING"
  | "CODING"
  | "VISION"
  | "TOOL_CALLING"
  | "STRUCTURED_OUTPUT"
  | "LONG_CONTEXT"
  | "SEO"
  | "SECURITY"
  | "ACCESSIBILITY"
  | "PERFORMANCE";

// ─── Task requirements ────────────────────────────────────────────────────────
// All fields are system-provided. None may originate from website/user content.

export interface TaskRequirements {
  taskType: TaskType;
  agentType?: string;
  complexity: TaskComplexity;
  riskLevel: RiskLevel;
  // Hard constraints — LLM cannot override these
  requiredCapabilities: ModelCapability[];
  structuredOutputRequired: boolean;
  toolCallingRequired: boolean;
  visionRequired: boolean;
  minimumContextLength?: number;
  minimumReliability?: number;     // 0.0–1.0, e.g. 0.9 = 90% success rate
  minimumQualityScore?: number;    // 0–100
  freeOnly?: boolean;
  allowedProviders?: string[];     // openrouter provider prefixes; undefined = all
  excludedModels?: string[];       // openrouter_ids to exclude
  // Soft preferences — may influence scoring
  preferredCapabilities: ModelCapability[];
  preferredModelId?: string;       // openrouter_id; preference only, not enforced
  maximumLatencyMs?: number;
  orgId?: string;                  // for org-level preferences lookup
}

// ─── Scoring weights ──────────────────────────────────────────────────────────

export interface ScoringWeights {
  benchmark: number;       // 0.30 default
  reliability: number;     // 0.20
  capability: number;      // 0.15
  historical: number;      // 0.15
  structuredOutput: number; // 0.05
  latency: number;         // 0.05
  context: number;         // 0.05
  preference: number;      // 0.05
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  benchmark: 0.30,
  reliability: 0.20,
  capability: 0.15,
  historical: 0.15,
  structuredOutput: 0.05,
  latency: 0.05,
  context: 0.05,
  preference: 0.05,
};

// ─── Data quality status ──────────────────────────────────────────────────────

export type DataStatus = "KNOWN" | "UNKNOWN" | "INSUFFICIENT";

// ─── Candidate filtering ──────────────────────────────────────────────────────

export type ExclusionReason =
  | "DISABLED"
  | "NOT_ELIGIBLE"
  | "FREE_ONLY_VIOLATION"
  | "MISSING_STRUCTURED_OUTPUT"
  | "MISSING_TOOL_CALLING"
  | "MISSING_VISION"
  | "CONTEXT_TOO_SHORT"
  | "PROVIDER_EXCLUDED"
  | "EXPLICITLY_EXCLUDED"
  | "BELOW_MIN_RELIABILITY"
  | "BELOW_MIN_QUALITY";

export interface ExcludedCandidate {
  openrouterId: string;
  displayName: string;
  reason: ExclusionReason;
  detail?: string;
}

// ─── Scored candidate ────────────────────────────────────────────────────────

export interface ScoreComponent {
  value: number;           // 0–100
  status: DataStatus;
  detail?: string;
}

export interface ScoredCandidate {
  modelId: string;         // UUID in models table
  openrouterId: string;
  displayName: string;
  compositeScore: number;  // 0–100 weighted sum
  components: {
    benchmark: ScoreComponent;
    reliability: ScoreComponent;
    capability: ScoreComponent;
    historical: ScoreComponent;
    structuredOutput: ScoreComponent;
    latency: ScoreComponent;
    context: ScoreComponent;
    preference: ScoreComponent;
  };
}

// ─── Routing decision ─────────────────────────────────────────────────────────

export type DecisionSource = "DETERMINISTIC" | "OX_ALPHA" | "FALLBACK";
export type RoutingStatus = "RESOLVED" | "NO_CANDIDATES" | "ERROR";

export interface RoutingDecision {
  id: string;                        // UUID
  orgId?: string;
  correlationId?: string;
  taskType: TaskType;
  complexity: TaskComplexity;
  riskLevel: RiskLevel;
  status: RoutingStatus;
  // Resolved fields (null when status !== RESOLVED)
  selectedModel: ScoredCandidate | null;
  fallbackModels: ScoredCandidate[];
  allCandidates: ScoredCandidate[];
  excludedCandidates: ExcludedCandidate[];
  // Decision metadata
  decisionReason: string;
  decisionConfidence: number;        // 0–100
  decisionSource: DecisionSource;
  decisionDurationMs: number;
  // Policy context
  policyId?: string;
  policyVersion?: number;
  // Timestamps
  createdAt: string;
  errorMessage?: string;
}

// ─── Routing policy (DB shape) ────────────────────────────────────────────────

export interface RoutingPolicy {
  id: string;
  orgId: string | null;
  version: number;
  freeOnly: boolean;
  minReliability: number;
  minQuality: number;
  maxAttempts: number;
  requireCrossModelVerification: boolean;
  allowedProviders: string[] | null;
  excludedModels: string[] | null;
  weights: ScoringWeights;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
