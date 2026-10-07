import { createHash } from "node:crypto";
import { z } from "zod";
import { query } from "../db/client.js";

export const CROSS_DOMAINS = ["seo", "ai_visibility", "security", "performance", "accessibility", "technical_health"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const severities = ["critical", "high", "medium", "low", "info"] as const;

export const CrossDomainFindingSchema = z.object({
  findingId: z.string().uuid().optional(),
  title: z.string().min(1).max(500),
  severity: z.enum(severities),
  domains: z.array(z.enum(CROSS_DOMAINS)).min(2),
  sourceFindingIds: z.array(z.string().uuid()).min(2),
  evidenceIds: z.array(z.string().uuid()).min(1),
  businessImpact: z.string().min(1),
  technicalImpact: z.string().min(1),
  confidence: z.number().int().min(0).max(100),
  priority: z.enum(PRIORITIES),
  priorityScore: z.number().min(0).max(100),
  priorityReason: z.record(z.unknown()),
  recommendation: z.string().min(1),
}).strict();

export const RemediationProposalSchema = z.object({
  remediationId: z.string().uuid().optional(),
  findingIds: z.array(z.string().uuid()).min(1),
  title: z.string().min(1).max(500),
  problem: z.string().min(1),
  rootCause: z.string().min(1),
  proposedChange: z.string().min(1),
  implementationSteps: z.array(z.string().min(1)).min(1),
  expectedBenefit: z.string().min(1),
  riskLevel: z.enum(severities.filter((value) => value !== "info") as ["critical", "high", "medium", "low"]),
  confidence: z.number().int().min(0).max(100),
  validationPlan: z.array(z.string().min(1)).min(1),
  requiresHumanApproval: z.literal(true),
  approvalStatus: z.enum(["PROPOSED", "APPROVED", "REJECTED", "EXPIRED"]),
}).strict();

export type CrossDomainFinding = z.infer<typeof CrossDomainFindingSchema>;
export type RemediationProposal = z.infer<typeof RemediationProposalSchema>;

const DOMAIN_BY_CATEGORY: Record<string, typeof CROSS_DOMAINS[number]> = {
  seo: "seo", aiVisibility: "ai_visibility", AEO_ANALYSIS: "ai_visibility", SEO_ANALYSIS: "seo",
  security: "security", SECURITY_ANALYSIS: "security", performance: "performance", PERFORMANCE_ANALYSIS: "performance",
  accessibility: "accessibility", ACCESSIBILITY_ANALYSIS: "accessibility", technicalHealth: "technical_health", TECHNICAL_HEALTH_ANALYSIS: "technical_health",
};

export function calculatePriority(input: { severity: string; confidence: number; affectedScope: number; domainCount: number; security: boolean }): { priority: typeof PRIORITIES[number]; score: number; reason: Record<string, number> } {
  const severityWeight: Record<string, number> = { critical: 100, high: 80, medium: 55, low: 30, info: 10 };
  const severityScore = severityWeight[input.severity] ?? 0;
  const scopeScore = Math.min(100, Math.max(1, input.affectedScope) * 10);
  const domainScore = Math.min(100, input.domainCount * 25);
  const securityScore = input.security ? 100 : 0;
  const score = Math.min(100, Math.round(severityScore * 0.4 + input.confidence * 0.2 + scopeScore * 0.15 + domainScore * 0.15 + securityScore * 0.1));
  const priority = score >= 80 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";
  return { priority, score, reason: { severityScore, confidence: input.confidence, scopeScore, domainScore, securityScore } };
}

export function buildCrossDomainFinding(sourceFindings: Array<{ id: string; category: string; module_name: string; severity: string; title: string; description: string; recommendation: string; affected_urls: string[]; evidence_ids: string[] }>): CrossDomainFinding | null {
  const domains = [...new Set(sourceFindings.map((finding) => DOMAIN_BY_CATEGORY[finding.category] ?? DOMAIN_BY_CATEGORY[finding.module_name]).filter((domain): domain is typeof CROSS_DOMAINS[number] => Boolean(domain)))];
  const evidenceIds = [...new Set(sourceFindings.flatMap((finding) => finding.evidence_ids))];
  if (sourceFindings.length < 2 || domains.length < 2 || evidenceIds.length === 0) return null;
  const severity = sourceFindings.reduce<typeof severities[number]>((highest, finding) => severities.indexOf(finding.severity as typeof severities[number]) < severities.indexOf(highest) ? finding.severity as typeof severities[number] : highest, "info");
  const confidence = Math.round(sourceFindings.reduce((sum, finding) => sum + 75, 0) / sourceFindings.length);
  const priority = calculatePriority({ severity, confidence, affectedScope: new Set(sourceFindings.flatMap((finding) => finding.affected_urls)).size, domainCount: domains.length, security: domains.includes("security") });
  return CrossDomainFindingSchema.parse({ title: `Cross-domain impact across ${domains.join(" and ")}`, severity, domains, sourceFindingIds: sourceFindings.map((finding) => finding.id), evidenceIds, businessImpact: "The correlated findings may compound user, discoverability, operational, or security impact; business outcome requires validation.", technicalImpact: sourceFindings.map((finding) => finding.description).join(" "), confidence, priority: priority.priority, priorityScore: priority.score, priorityReason: priority.reason, recommendation: sourceFindings.map((finding) => finding.recommendation).filter(Boolean).join(" ") || "Validate the correlated findings and address the highest-impact source issue first." });
}

export function buildProposal(finding: CrossDomainFinding, sourceRecommendations: string[]): RemediationProposal {
  return RemediationProposalSchema.parse({ findingIds: finding.sourceFindingIds, title: `Proposal for ${finding.title}`, problem: finding.technicalImpact, rootCause: "Root cause requires further validation", proposedChange: sourceRecommendations.filter(Boolean).join(" ") || "Validate the source findings before selecting a change.", implementationSteps: ["Review the referenced findings and evidence", "Prepare a change within the customer-controlled system", "Obtain explicit human approval before any future execution"], expectedBenefit: finding.businessImpact, riskLevel: finding.priority === "critical" ? "critical" : finding.priority, confidence: Math.min(finding.confidence, 80), validationPlan: ["Re-run the affected deterministic scanner", "Re-run the relevant specialist analysis", "Compare the resulting evidence with the baseline"], requiresHumanApproval: true, approvalStatus: "PROPOSED" });
}

function logicalKey(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function listCrossDomainFindings(scanId: string, orgId: string): Promise<unknown[]> {
  const { rows } = await query("SELECT * FROM cross_domain_findings WHERE scan_id=$1 AND org_id=$2 ORDER BY priority_score DESC, created_at", [scanId, orgId]);
  return rows;
}

export async function listRemediationProposals(scanId: string, orgId: string): Promise<unknown[]> {
  const { rows } = await query("SELECT * FROM remediation_proposals WHERE scan_id=$1 AND org_id=$2 ORDER BY created_at DESC", [scanId, orgId]);
  return rows;
}

export async function persistCrossDomainFinding(input: { orgId: string; websiteId: string; scanId: string; finding: CrossDomainFinding; executionId?: string }): Promise<string | null> {
  const { rows } = await query<{ id: string }>(`INSERT INTO cross_domain_findings (org_id, website_id, scan_id, logical_key, title, severity, domains, source_finding_ids, evidence_ids, business_impact, technical_impact, confidence, priority, priority_score, priority_reason, recommendation, execution_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (org_id, scan_id, logical_key) DO UPDATE SET title=EXCLUDED.title, severity=EXCLUDED.severity, domains=EXCLUDED.domains, source_finding_ids=EXCLUDED.source_finding_ids, evidence_ids=EXCLUDED.evidence_ids, business_impact=EXCLUDED.business_impact, technical_impact=EXCLUDED.technical_impact, confidence=EXCLUDED.confidence, priority=EXCLUDED.priority, priority_score=EXCLUDED.priority_score, priority_reason=EXCLUDED.priority_reason, recommendation=EXCLUDED.recommendation, updated_at=NOW() RETURNING id`, [input.orgId, input.websiteId, input.scanId, logicalKey({ sourceFindingIds: input.finding.sourceFindingIds }), input.finding.title, input.finding.severity, input.finding.domains, input.finding.sourceFindingIds, input.finding.evidenceIds, input.finding.businessImpact, input.finding.technicalImpact, input.finding.confidence, input.finding.priority, input.finding.priorityScore, JSON.stringify(input.finding.priorityReason), input.finding.recommendation, input.executionId ?? null]);
  const crossDomainId = rows[0]?.id;
  if (!crossDomainId) return null;
  for (const sourceFindingId of input.finding.sourceFindingIds) await query("INSERT INTO cross_domain_finding_sources (cross_domain_finding_id, source_finding_id, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [crossDomainId, sourceFindingId, input.orgId]);
  for (const evidenceId of input.finding.evidenceIds) await query("INSERT INTO cross_domain_finding_evidence (cross_domain_finding_id, evidence_id, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [crossDomainId, evidenceId, input.orgId]);
  return crossDomainId;
}

export async function persistRemediationProposal(input: { orgId: string; websiteId: string; scanId: string; proposal: RemediationProposal }): Promise<void> {
  const { rows } = await query<{ id: string }>(`INSERT INTO remediation_proposals (org_id, website_id, scan_id, logical_key, finding_ids, title, problem, root_cause, proposed_change, implementation_steps, expected_benefit, risk_level, confidence, validation_plan, requires_human_approval, approval_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,'PROPOSED')
    ON CONFLICT (org_id, scan_id, logical_key) DO UPDATE SET problem=EXCLUDED.problem, root_cause=EXCLUDED.root_cause, proposed_change=EXCLUDED.proposed_change, implementation_steps=EXCLUDED.implementation_steps, expected_benefit=EXCLUDED.expected_benefit, risk_level=EXCLUDED.risk_level, confidence=EXCLUDED.confidence, validation_plan=EXCLUDED.validation_plan, updated_at=NOW() RETURNING id`, [input.orgId, input.websiteId, input.scanId, logicalKey({ findingIds: input.proposal.findingIds }), input.proposal.findingIds, input.proposal.title, input.proposal.problem, input.proposal.rootCause, input.proposal.proposedChange, JSON.stringify(input.proposal.implementationSteps), input.proposal.expectedBenefit, input.proposal.riskLevel, input.proposal.confidence, JSON.stringify(input.proposal.validationPlan)]);
  const proposalId = rows[0]?.id;
  if (!proposalId) return;
  for (const findingId of input.proposal.findingIds) await query("INSERT INTO remediation_proposal_findings (proposal_id, finding_id, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [proposalId, findingId, input.orgId]);
}
