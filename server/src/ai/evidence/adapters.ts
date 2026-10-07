import type { EvidenceInput, EvidenceSource, EvidenceType } from "./types.js";

/** Tool adapters normalize observations only; they never create findings or bypass SSRF/tool permissions. */
export function normalizeToolObservation(base: Omit<EvidenceInput, "evidenceType" | "sourceType">, type: EvidenceType, source: EvidenceSource): EvidenceInput {
  return { ...base, evidenceType: type, sourceType: source, kind: "RAW_EVIDENCE" };
}
export const httpEvidence = (base: Omit<EvidenceInput, "evidenceType" | "sourceType">) => normalizeToolObservation(base, "HTTP_RESPONSE", "HTTP_CLIENT");
export const securityEvidence = (base: Omit<EvidenceInput, "evidenceType" | "sourceType">) => normalizeToolObservation(base, "SECURITY_SCANNER_RESULT", "SCANNER");
export const performanceEvidence = (base: Omit<EvidenceInput, "evidenceType" | "sourceType">) => normalizeToolObservation(base, "PERFORMANCE_METRIC", "BROWSER");
export const accessibilityEvidence = (base: Omit<EvidenceInput, "evidenceType" | "sourceType">) => normalizeToolObservation(base, "ACCESSIBILITY_RESULT", "TEST_RUNNER");
