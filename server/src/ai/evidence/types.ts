export const EVIDENCE_TYPES = ["HTTP_RESPONSE", "HTML_DOCUMENT", "HTTP_HEADER", "DNS_RECORD", "TLS_CERTIFICATE", "ROBOTS_TXT", "SITEMAP", "STRUCTURED_DATA", "BROWSER_OBSERVATION", "PERFORMANCE_METRIC", "ACCESSIBILITY_RESULT", "SECURITY_SCANNER_RESULT", "TEST_RESULT", "LOG_RESULT", "API_RESPONSE", "DATABASE_OBSERVATION", "USER_PROVIDED_EVIDENCE", "AGENT_RESULT_REFERENCE"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export const EVIDENCE_SOURCES = ["HTTP_CLIENT", "BROWSER", "DNS", "TLS", "CRAWLER", "SCANNER", "TEST_RUNNER", "DATABASE", "USER", "AGENT", "SYSTEM"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export type EvidenceKind = "RAW_EVIDENCE" | "DERIVED_EVIDENCE";
export type FreshnessStatus = "FRESH" | "STALE" | "EXPIRED" | "UNKNOWN";

export interface EvidenceInput {
  tenantId: string; taskId: string; executionId?: string; agentId?: string; agentVersion?: string;
  evidenceType: EvidenceType; sourceType: EvidenceSource; sourceReference: string; resourceReference?: string;
  observedAt: string; content: unknown; confidence?: number; metadata?: Record<string, unknown>;
  logicalKey?: string;
  kind?: EvidenceKind; parentEvidenceIds?: string[]; expiresAt?: string; freshnessPolicy?: string;
  retentionClass?: string; storageReference?: string;
}
export interface EvidenceRecord extends Omit<EvidenceInput, "content"> {
  evidenceId: string; contentHash: string; status: "ACTIVE" | "REDACTED" | "INVALID";
  freshnessStatus: FreshnessStatus; collectedAt: string; createdAt: string;
  quality: { completeness?: number; freshness?: number; integrity?: number; sourceReliability?: number; scopeValidity?: number };
}
export interface EvidenceValidation { valid: boolean; code?: "EVIDENCE_GAP" | "GROUNDING_FAILURE"; violations: string[]; evidence: EvidenceRecord[]; }
