export type Role = "owner" | "admin" | "member" | "viewer";
export type ScanStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type ModuleStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Provenance = "MEASURED" | "INFERRED" | "OPPORTUNITY";
export type ScoreStatus = "scored" | "not_measured" | "failed" | "partial";
export type QualityGate = "excellent" | "accept" | "improve" | "regenerate" | "failed";
export type AuditResult = "success" | "failure" | "unauthorized";

export interface JwtPayload {
  sub: string;       // user id
  email: string;
  orgIds: string[];  // all org memberships
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  orgIds: string[];
  role?: Role;       // populated per-request for the active org
}

export interface FindingRow {
  id: string;
  scan_id: string;
  website_id: string;
  org_id: string;
  module_name: string;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  affected_urls: string[];
  confidence: number;
  provenance: Provenance;
  verified: boolean;
  quality_score: number | null;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  finding_id: string;
  type: string;
  url: string | null;
  observed_value: string | null;
  expected_value: string | null;
  rule: string | null;
  tool: string | null;
  collected_at: string;
}

export interface ScanRow {
  id: string;
  website_id: string;
  org_id: string;
  triggered_by: string | null;
  status: ScanStatus;
  modules: string[];
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
}

export interface WebsiteRow {
  id: string;
  org_id: string;
  url: string;
  domain: string;
  verified: boolean;
  verification_method: string | null;
  verification_token: string | null;
  verification_environment?: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Module scan result returned by each scanner
export interface ModuleResult {
  moduleName: string;
  status: ModuleStatus;
  durationMs: number;
  findings: NewFinding[];
  error?: string;
}

export interface NewFinding {
  category: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  affectedUrls?: string[];
  confidence?: number;
  provenance?: Provenance;
  evidence: NewEvidence[];
}

export interface NewEvidence {
  type: string;
  url?: string;
  observedValue?: string;
  expectedValue?: string;
  rule?: string;
  tool?: string;
}

export function qualityGate(score: number): QualityGate {
  if (score >= 95) return "excellent";
  if (score >= 90) return "accept";
  if (score >= 80) return "improve";
  if (score >= 70) return "regenerate";
  return "failed";
}

// SEVERITY_PENALTY — mirrors frontend scoring.ts
export const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0,
};

export function calculateCategoryScore(findings: NewFinding[]): number {
  const total = findings.reduce((sum, f) => {
    const base = SEVERITY_PENALTY[f.severity] ?? 0;
    return sum + base * ((f.confidence ?? 100) / 100);
  }, 0);
  return Math.max(0, Math.round(100 - Math.min(total, 100)));
}
