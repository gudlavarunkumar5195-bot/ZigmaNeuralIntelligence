import { findEvidence } from "../evidence/store.js";
import { validateGrounding } from "../evidence/validator.js";
import type { EvidenceRecord } from "../evidence/types.js";
import type { AgentFinding } from "../agents/types.js";

/** Bumped whenever quality-gate behaviour changes; recorded on every assessment. */
export const QUALITY_POLICY_VERSION = "2";
/** Policy-defined maximum evidence age (matches evidence freshness window). */
export const DEFAULT_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EvidenceFailure = "NO_EVIDENCE_IDS" | "NOT_FOUND" | "TENANT_MISMATCH" | "TASK_MISMATCH" | "INACTIVE" | "STALE" | "GROUNDING_FAILURE";
export interface FindingEvidenceCheck { findingId: string; supported: boolean; failures: EvidenceFailure[]; }
export interface EvidenceCheck {
  policyVersion: string;
  totalFindings: number;
  supportedFindings: number;
  /** supportedFindings / totalFindings; 0 when there are no findings (see validReferenced for clean scans). */
  coverage: number;
  findings: FindingEvidenceCheck[];
  invalidEvidenceIds: string[];
  staleEvidenceIds: string[];
  referencedTotal: number;
  /** Referenced evidence records that exist, belong to tenant+task, are active and fresh. */
  validReferenced: number;
}
export interface EvidenceCheckExpectation { tenantId: string; taskId: string; maxAgeMs?: number; now?: number; }

function recordFailures(record: EvidenceRecord, expected: EvidenceCheckExpectation, maxAgeMs: number, now: number): EvidenceFailure[] {
  const failures: EvidenceFailure[] = [];
  if (record.tenantId !== expected.tenantId) failures.push("TENANT_MISMATCH");
  if (record.taskId !== expected.taskId) failures.push("TASK_MISMATCH");
  if (record.status !== "ACTIVE") failures.push("INACTIVE");
  const observed = Date.parse(record.observedAt);
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
  if (!Number.isFinite(observed) || now - observed > maxAgeMs || record.freshnessStatus === "EXPIRED" || record.freshnessStatus === "STALE" || (Number.isFinite(expires) && expires < now)) failures.push("STALE");
  return failures;
}

/** Pure: verifies every finding's evidence against the resolved records and computes real coverage. */
export function checkEvidence(result: { findings: AgentFinding[]; evidenceReferences: string[] }, records: EvidenceRecord[], expected: EvidenceCheckExpectation): EvidenceCheck {
  const maxAgeMs = expected.maxAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const now = expected.now ?? Date.now();
  const byId = new Map(records.map((record) => [record.evidenceId, record]));
  const invalid = new Set<string>(); const stale = new Set<string>();
  const failuresById = new Map<string, EvidenceFailure[]>();
  const failuresFor = (id: string): EvidenceFailure[] => {
    const cached = failuresById.get(id); if (cached) return cached;
    const record = byId.get(id);
    const failures = record ? recordFailures(record, expected, maxAgeMs, now) : (["NOT_FOUND"] as EvidenceFailure[]);
    failuresById.set(id, failures);
    if (failures.includes("STALE") && failures.length === 1) stale.add(id); else if (failures.length) invalid.add(id);
    return failures;
  };
  const findings = result.findings.map((finding): FindingEvidenceCheck => {
    const ids = [...new Set(finding.evidenceIds)];
    if (!ids.length) return { findingId: finding.findingId, supported: false, failures: ["NO_EVIDENCE_IDS"] };
    const failures = new Set<EvidenceFailure>();
    for (const id of ids) for (const failure of failuresFor(id)) failures.add(failure);
    const resolved = ids.map((id) => byId.get(id)).filter((record): record is EvidenceRecord => Boolean(record));
    if (!failures.has("NOT_FOUND")) {
      const grounding = validateGrounding(resolved, { tenantId: expected.tenantId, taskId: expected.taskId });
      if (!grounding.valid) failures.add("GROUNDING_FAILURE");
    }
    return { findingId: finding.findingId, supported: failures.size === 0, failures: [...failures] };
  });
  const refs = [...new Set(result.evidenceReferences)];
  const validReferenced = refs.filter((id) => failuresFor(id).length === 0).length;
  const supportedFindings = findings.filter((item) => item.supported).length;
  return { policyVersion: QUALITY_POLICY_VERSION, totalFindings: findings.length, supportedFindings, coverage: findings.length ? supportedFindings / findings.length : 0, findings, invalidEvidenceIds: [...invalid], staleEvidenceIds: [...stale], referencedTotal: refs.length, validReferenced };
}

/** Resolves evidence within the tenant and task (never across them) and checks it. */
export async function loadEvidenceCheck(result: { findings: AgentFinding[]; evidenceReferences: string[] }, expected: EvidenceCheckExpectation): Promise<EvidenceCheck> {
  const ids = [...new Set([...result.evidenceReferences, ...result.findings.flatMap((finding) => finding.evidenceIds)])].filter((id) => UUID.test(id));
  const records = await findEvidence(ids, expected.tenantId, expected.taskId);
  return checkEvidence(result, records, expected);
}
