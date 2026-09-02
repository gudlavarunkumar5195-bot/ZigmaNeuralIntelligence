// ─── Core Entity IDs ────────────────────────────────────────────────────────

export type UserId = string;
export type TenantId = string;
export type WebsiteId = string;
export type ScanId = string;
export type FindingId = string;
export type AgentExecutionId = string;
export type ModelExecutionId = string;
export type InstructionId = string;
export type ReportId = string;

// ─── Scan Status ─────────────────────────────────────────────────────────────

export type ScanStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type ModuleStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timeout";

export type ScanModule =
  | "discovery"
  | "seo"
  | "ai-visibility"
  | "security"
  | "performance"
  | "accessibility"
  | "qa"
  | "ssl";

// ─── Findings ────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type DataProvenance = "MEASURED" | "INFERRED" | "OPPORTUNITY";

export interface Evidence {
  tool: string;
  sourceUrl?: string;
  raw: string;
  timestamp: string;
}

export interface Finding {
  id: FindingId;
  scanId: ScanId;
  websiteId: WebsiteId;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  affectedUrls: string[];
  evidence: Evidence[];
  recommendation: string;
  confidence: number;
  provenance: DataProvenance;
  verified: boolean;
  qualityScore: number | null;
  agentExecutionId: AgentExecutionId | null;
  createdAt: string;
}

// ─── Scores ──────────────────────────────────────────────────────────────────

export type ScoreStatus = "scored" | "not_measured" | "failed" | "partial";

export interface CategoryScore {
  value: number | null;
  status: ScoreStatus;
  label: string;
  findingCount: number;
  criticalCount: number;
}

export interface IntelligenceScores {
  overall: CategoryScore;
  seo: CategoryScore;
  aiVisibility: CategoryScore;
  security: CategoryScore;
  performance: CategoryScore;
  accessibility: CategoryScore;
  technicalHealth: CategoryScore;
  ssl: CategoryScore;
  qa: CategoryScore;
}

// ─── Websites ─────────────────────────────────────────────────────────────────

export type VerificationMethod = "html-meta" | "dns-txt" | "html-file";
export type VerificationStatus = "unverified" | "pending" | "verified" | "failed";

export interface Website {
  id: WebsiteId;
  tenantId: TenantId;
  url: string;
  domain: string;
  createdAt: string;
  verificationStatus: VerificationStatus;
  verificationMethod: VerificationMethod | null;
  verifiedAt: string | null;
  lastScanId: ScanId | null;
  lastScanAt: string | null;
}

// ─── Scans ────────────────────────────────────────────────────────────────────

export interface ScanModuleResult {
  module: ScanModule;
  status: ModuleStatus;
  startedAt: string | null;
  completedAt: string | null;
  findingCount: number;
  error: string | null;
  retryCount: number;
}

export interface Scan {
  id: ScanId;
  websiteId: WebsiteId;
  tenantId: TenantId;
  status: ScanStatus;
  requestedModules: ScanModule[];
  moduleResults: ScanModuleResult[];
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  scores: IntelligenceScores | null;
}

// ─── AI Agents ────────────────────────────────────────────────────────────────

export type AgentStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "waiting";

export interface AgentExecution {
  id: AgentExecutionId;
  scanId: ScanId;
  agentType: string;
  status: AgentStatus;
  modelId: string;
  instructionVersion: string;
  dynamicInstructionId: InstructionId | null;
  qualityScore: number | null;
  attemptNumber: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

// ─── Quality Control ──────────────────────────────────────────────────────────

export type QualityGate = "excellent" | "accept" | "improve" | "regenerate" | "failed";

export function qualityGate(score: number): QualityGate {
  if (score >= 95) return "excellent";
  if (score >= 90) return "accept";
  if (score >= 80) return "improve";
  if (score >= 70) return "regenerate";
  return "failed";
}

export interface QualityAttempt {
  attempt: number;
  modelId: string;
  score: number;
  gate: QualityGate;
  failureReason: string | null;
  dynamicInstruction: string | null;
  timestamp: string;
}

// ─── Models ───────────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  reasoning: boolean;
  coding: boolean;
  vision: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
}

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  openRouterId: string;
  free: boolean;
  contextLength: number;
  capabilities: ModelCapabilities;
  avgLatency: number;
  reliability: number;
  available: boolean;
  enabled: boolean;
  role: "master" | "worker";
  lastBenchmarkAt: string | null;
  benchmarkScores: Record<string, number> | null;
}

// ─── SSL ──────────────────────────────────────────────────────────────────────

export type SSLStatus = "valid" | "expiring" | "expired" | "invalid" | "unavailable" | "not_measured";

export interface SSLResult {
  status: SSLStatus;
  issuer: string | null;
  subject: string | null;
  san: string[];
  issuedAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  tlsVersion: string | null;
  grade: string | null;
  hstsEnabled: boolean | null;
  chainValid: boolean | null;
  autoRenewal: boolean | null;
  measuredAt: string;
}

// ─── URL Validation ───────────────────────────────────────────────────────────

export interface URLValidationResult {
  valid: boolean;
  normalizedUrl: string | null;
  error: string | null;
  blocked: boolean;
  blockReason: string | null;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
}

// ─── App State ────────────────────────────────────────────────────────────────

export type AppMode = "demo" | "production";

export interface AppConfig {
  mode: AppMode;
  apiBaseUrl: string;
  wsBaseUrl: string;
  maxRetries: number;
  qualityThreshold: number;
  maxScanRetries: number;
}
