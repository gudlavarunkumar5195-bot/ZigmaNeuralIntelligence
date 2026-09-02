import { createHash } from "node:crypto";
import type { EvidenceInput, EvidenceRecord, EvidenceValidation } from "./types.js";

const secretPatterns = [/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, /\b(api[_-]?key|password|token|secret)\s*[:=]\s*[^\s,;]+/gi];
export function redactEvidence(value: unknown): unknown {
  if (typeof value === "string") return secretPatterns.reduce((text, pattern) => text.replace(pattern, "$1[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => /password|token|secret|authorization|api.?key/i.test(key) ? [key, "[REDACTED]"] : [key, redactEvidence(entry)]));
  return value;
}
export function stableEvidenceHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(redactEvidence(value))).digest("hex"); }
export function freshnessFor(observedAt: string, expiresAt?: string): EvidenceRecord["freshnessStatus"] {
  const now = Date.now(); const observed = Date.parse(observedAt); const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(observed)) return "UNKNOWN"; if (Number.isFinite(expiry) && expiry < now) return "EXPIRED";
  return now - observed > 24 * 60 * 60 * 1000 ? "STALE" : "FRESH";
}
export function validateEvidenceInput(input: EvidenceInput): string[] {
  const issues: string[] = []; if (!input.tenantId || !input.taskId || !input.sourceReference) issues.push("Tenant, task, and source reference are required.");
  if (!Number.isFinite(Date.parse(input.observedAt))) issues.push("Observed timestamp is invalid.");
  if (input.kind === "DERIVED_EVIDENCE" && !input.parentEvidenceIds?.length) issues.push("Derived evidence requires at least one parent evidence reference.");
  return issues;
}
export function validateGrounding(records: EvidenceRecord[], expected: { tenantId: string; taskId: string; resource?: string; requireFresh?: boolean }): EvidenceValidation {
  const violations: string[] = []; if (!records.length) violations.push("No evidence references resolved.");
  for (const record of records) { if (record.tenantId !== expected.tenantId) violations.push("Evidence belongs to a different tenant."); if (record.taskId !== expected.taskId) violations.push("Evidence belongs to a different task."); if (expected.resource && record.resourceReference && record.resourceReference !== expected.resource) violations.push("Evidence does not match the finding resource."); if (expected.requireFresh && record.freshnessStatus !== "FRESH") violations.push("Required evidence is not fresh."); }
  return { valid: !violations.length, code: violations.length ? (records.length ? "GROUNDING_FAILURE" : "EVIDENCE_GAP") : undefined, violations, evidence: records };
}
