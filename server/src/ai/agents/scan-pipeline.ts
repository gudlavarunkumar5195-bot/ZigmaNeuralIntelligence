import { createHash, randomUUID } from "node:crypto";
import { query } from "../../db/client.js";
import { assessQuality } from "../quality/evaluator.js";
import { runDiscovery } from "./discovery.js";
import { agentExecutor } from "./executor.js";
import { getOxAlphaExecutor } from "../ox-alpha.js";
import { getAgentDefinition } from "./registry.js";
import { findScanEvidence } from "../evidence/store.js";
import type { AgentFinding, AgentResult, AgentType } from "./types.js";
import type { NewFinding } from "../../types.js";

export interface ScanIntelligenceResult {
  discoveryCount: number;
  seoResult: AgentResult | null;
  agentResults: Partial<Record<AgentType, AgentResult>>;
  reportResult: AgentResult | null;
  status: "completed" | "partial" | "unavailable" | "failed";
  error?: string;
}

const SPECIALISTS: Array<{ agentType: AgentType; riskLevel: "MEDIUM" | "HIGH"; allowedTools: string[]; category: string }> = [
  { agentType: "SEO_ANALYSIS", riskLevel: "MEDIUM", allowedTools: ["HTML_PARSER", "STRUCTURED_DATA_PARSER", "SITEMAP_PARSER", "ROBOTS_PARSER"], category: "seo" },
  { agentType: "AEO_ANALYSIS", riskLevel: "MEDIUM", allowedTools: ["HTML_PARSER", "STRUCTURED_DATA_PARSER"], category: "aiVisibility" },
  { agentType: "SECURITY_ANALYSIS", riskLevel: "HIGH", allowedTools: ["SECURITY_SCANNER_OUTPUT"], category: "security" },
  { agentType: "PERFORMANCE_ANALYSIS", riskLevel: "MEDIUM", allowedTools: ["PERFORMANCE_DATA_PARSER", "HTML_PARSER"], category: "performance" },
  { agentType: "ACCESSIBILITY_ANALYSIS", riskLevel: "MEDIUM", allowedTools: ["ACCESSIBILITY_SCANNER_OUTPUT", "HTML_PARSER"], category: "accessibility" },
  { agentType: "TECHNICAL_HEALTH_ANALYSIS", riskLevel: "MEDIUM", allowedTools: ["TECHNICAL_SCANNER_OUTPUT", "HTML_PARSER"], category: "technicalHealth" },
];

function key(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyResult(status: ScanIntelligenceResult["status"], error: string): ScanIntelligenceResult {
  return { discoveryCount: 0, seoResult: null, agentResults: {}, reportResult: null, status, error };
}

export async function runScanIntelligence(input: {
  scanId: string;
  organizationId: string;
  websiteId: string;
  target: string;
  deterministicFindings: NewFinding[];
}): Promise<ScanIntelligenceResult> {
  const existing = await query<{ intelligence_status: string }>("SELECT intelligence_status FROM scans WHERE id=$1 AND org_id=$2", [input.scanId, input.organizationId]);
  if (existing.rows[0]?.intelligence_status === "COMPLETED") {
    return { discoveryCount: 0, seoResult: null, agentResults: {}, reportResult: null, status: "completed" };
  }
  await query("UPDATE scans SET intelligence_status = 'RUNNING', intelligence_error = NULL WHERE id = $1 AND org_id = $2", [input.scanId, input.organizationId]);
  await query(
    `INSERT INTO reports (org_id, website_id, scan_id, report_version, status, summary)
     VALUES ($1, $2, $3, 1, 'GENERATING', $4)
     ON CONFLICT (scan_id, report_version) DO UPDATE SET status = 'GENERATING', error = NULL, updated_at = NOW()`,
    [input.organizationId, input.websiteId, input.scanId, JSON.stringify({ deterministic: true, intelligence: "GENERATING" })]
  );

  const discoveryExecutionId = await startDiscoveryExecution(input);
  let discovery;
  try {
    discovery = await runDiscovery({
      scanId: input.scanId,
      organizationId: input.organizationId,
      websiteId: input.websiteId,
      target: input.target,
    });
    await finishDiscoveryExecution(discoveryExecutionId, "completed");
  } catch (error: unknown) {
    const message = (error as Error).message;
    await finishDiscoveryExecution(discoveryExecutionId, "failed", message);
    await failIntelligence(input, `DISCOVERY_FAILURE: ${message}`);
    return emptyResult("failed", message);
  }

  if (discovery.pages.length === 0 || discovery.evidence.length === 0) {
    const message = "Discovery produced no usable evidence";
    await failIntelligence(input, `DISCOVERY_FAILURE: ${message}`);
    return { ...emptyResult("failed", message), discoveryCount: discovery.pages.length };
  }

  if (!getOxAlphaExecutor()) {
    await failIntelligence(input, "MODEL_UNAVAILABLE: OPENROUTER_API_KEY is not configured");
    return { ...emptyResult("unavailable", "OPENROUTER_API_KEY is not configured"), discoveryCount: discovery.pages.length };
  }

  const evidenceReferences = discovery.evidence.map((record) => record.evidenceId);
  const deterministicEvidence = await findScanEvidence(input.organizationId, input.scanId, input.websiteId);
  const allEvidence = [...new Map([...discovery.evidence, ...deterministicEvidence].map((record) => [record.evidenceId, record])).values()];
  const allEvidenceReferences = allEvidence.map((record) => record.evidenceId);
  const sharedContext = { discoveryPages: discovery.pages, deterministicFindings: input.deterministicFindings, deterministicEvidence, discoveryWarnings: discovery.warnings, evidenceState: "Canonical discovery and deterministic scanner evidence; external visibility and unavailable measurements are NOT_MEASURED." };
  const settled = await Promise.all(SPECIALISTS.map(async (spec) => {
    const definition = getAgentDefinition(spec.agentType)!;
    const stageOwner = randomUUID();
    try {
      const claimed = await claimStage(input, spec.agentType, stageOwner);
      if (!claimed) return [spec.agentType, failedAgentResult(input.scanId, spec.agentType, "Stage already completed by another execution")] as const;
      if (await isCancelled(input)) return [spec.agentType, failedAgentResult(input.scanId, spec.agentType, "Scan was cancelled before specialist execution")] as const;
      const result = await agentExecutor.execute({ taskId: input.scanId, scanId: input.scanId, tenantId: input.organizationId, websiteId: input.websiteId, target: input.target, agentType: spec.agentType, agentVersion: definition.version, evidenceReferences: allEvidenceReferences, riskLevel: spec.riskLevel, satisfiedDependencies: ["DISCOVERY"], allowedTools: spec.allowedTools, context: sharedContext });
      if (await isCancelled(input)) return [spec.agentType, failedAgentResult(input.scanId, spec.agentType, "Scan was cancelled after specialist execution")] as const;
      const quality = assessQuality({ result, evidenceValid: result.findings.every((finding) => finding.evidenceIds.length > 0) });
      if (quality.status !== "ACCEPT") throw new Error(`QC_REJECTED: ${quality.status}`);
      await persistAgentFindings(input, spec.category, spec.agentType, result.findings);
      await finishStage(input, spec.agentType, stageOwner, "COMPLETED");
      return [spec.agentType, result] as const;
    } catch (error: unknown) {
      await finishStage(input, spec.agentType, stageOwner, "FAILED", (error as Error).message);
      return [spec.agentType, failedAgentResult(input.scanId, spec.agentType, (error as Error).message)] as const;
    }
  }));
  const agentResults = Object.fromEntries(settled) as Partial<Record<AgentType, AgentResult>>;
  const successfulResults = settled.filter(([, result]) => result.status !== "FAILED");
  const failedResults = settled.filter(([, result]) => result.status === "FAILED");
  const seoResult = agentResults.SEO_ANALYSIS ?? null;
  let reportResult: AgentResult | null = null;
  if (successfulResults.length > 0) {
    try {
      if (await isCancelled(input)) {
        await markCancelled(input);
        return { discoveryCount: discovery.pages.length, seoResult, agentResults, reportResult: null, status: "failed", error: "Scan was cancelled before report synthesis" };
      }
      const definition = getAgentDefinition("REPORT_SYNTHESIS")!;
      reportResult = await agentExecutor.execute({ taskId: input.scanId, scanId: input.scanId, tenantId: input.organizationId, websiteId: input.websiteId, target: input.target, agentType: "REPORT_SYNTHESIS", agentVersion: definition.version, evidenceReferences: allEvidenceReferences, riskLevel: "MEDIUM", satisfiedDependencies: ["DISCOVERY"], allowedTools: ["FINDING_AGGREGATOR"], context: { ...sharedContext, agentStatuses: Object.fromEntries(settled.map(([type, result]) => [type, result.status])), agentFindings: Object.fromEntries(successfulResults.map(([type, result]) => [type, result.findings])) } });
      const quality = assessQuality({ result: reportResult, evidenceValid: reportResult.findings.every((finding) => finding.evidenceIds.length > 0) });
      if (quality.status !== "ACCEPT") throw new Error(`QC_REJECTED: ${quality.status}`);
    } catch (error: unknown) {
      reportResult = failedAgentResult(input.scanId, "REPORT_SYNTHESIS", (error as Error).message);
    }
  }
  const status = failedResults.length === 0 && reportResult?.status !== "FAILED" ? "completed" : successfulResults.length > 0 ? "partial" : "failed";
  const error = failedResults.length > 0 ? `${failedResults.length} specialist agent(s) failed` : reportResult?.status === "FAILED" ? "Report synthesis failed" : undefined;
  const reportStatus = status === "completed" && reportResult?.status !== "FAILED" ? "READY" : "FAILED";
  await query("UPDATE reports SET status = $4, summary = $5, synthesis_artifact = $6, synthesis_execution_id = $7, synthesis_quality_status = $8, error = $9, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1", [input.scanId, input.organizationId, input.websiteId, reportStatus, JSON.stringify({ deterministic: true, intelligence: status.toUpperCase(), agents: Object.fromEntries(settled.map(([type, result]) => [type, result.status])), reportStatus: reportResult?.status ?? "UNAVAILABLE" }), reportResult, reportResult?.executionId ?? null, reportResult?.status === "FAILED" ? "REJECTED" : "ACCEPTED", error]);
  await query("UPDATE scans SET intelligence_status = $3, intelligence_error = $4 WHERE id = $1 AND org_id = $2", [input.scanId, input.organizationId, status === "completed" ? "COMPLETED" : status === "partial" ? "PARTIAL" : "FAILED", error]);
  return { discoveryCount: discovery.pages.length, seoResult, agentResults, reportResult, status, error };
}

async function failIntelligence(input: { scanId: string; organizationId: string; websiteId: string }, error: string): Promise<void> {
  await query("UPDATE scans SET intelligence_status = 'FAILED', intelligence_error = $3 WHERE id = $1 AND org_id = $2", [input.scanId, input.organizationId, error]);
  await query("UPDATE reports SET status = 'FAILED', error = $4, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1", [input.scanId, input.organizationId, input.websiteId, error]);
}

async function isCancelled(input: { scanId: string; organizationId: string }): Promise<boolean> {
  const { rows } = await query<{ status: string }>("SELECT status FROM scans WHERE id=$1 AND org_id=$2", [input.scanId, input.organizationId]);
  return rows[0]?.status === "cancelled";
}

async function claimStage(input: { scanId: string; organizationId: string }, stageName: string, ownerId: string): Promise<boolean> {
  const { rows } = await query<{ stage_name: string }>(`INSERT INTO agent_stage_claims (scan_id, org_id, stage_name, owner_id, status, attempt_number, claimed_at, lease_until)
    VALUES ($1,$2,$3,$4,'RUNNING',1,NOW(),NOW()+INTERVAL '2 minutes')
    ON CONFLICT (scan_id, stage_name) DO UPDATE SET owner_id=EXCLUDED.owner_id, status='RUNNING', attempt_number=agent_stage_claims.attempt_number+1, claimed_at=NOW(), lease_until=NOW()+INTERVAL '2 minutes', error=NULL
    WHERE agent_stage_claims.status <> 'COMPLETED' AND agent_stage_claims.lease_until < NOW()
    RETURNING stage_name`, [input.scanId, input.organizationId, stageName, ownerId]);
  return rows.length > 0;
}

async function finishStage(input: { scanId: string; organizationId: string }, stageName: string, ownerId: string | undefined, status: "COMPLETED" | "FAILED", error?: string): Promise<void> {
  if (ownerId) await query("UPDATE agent_stage_claims SET status=$4, completed_at=NOW(), error=$5 WHERE scan_id=$1 AND org_id=$2 AND stage_name=$3 AND owner_id=$6", [input.scanId, input.organizationId, stageName, status, error ?? null, ownerId]);
}

async function markCancelled(input: { scanId: string; organizationId: string; websiteId: string }): Promise<void> {
  await query("UPDATE scans SET intelligence_status='CANCELLED', intelligence_error='Scan cancelled' WHERE id=$1 AND org_id=$2 AND status='cancelled'", [input.scanId, input.organizationId]);
  await query("UPDATE reports SET status='FAILED', error='Scan cancelled', updated_at=NOW() WHERE scan_id=$1 AND org_id=$2 AND website_id=$3 AND report_version=1", [input.scanId, input.organizationId, input.websiteId]);
}

async function startDiscoveryExecution(input: { scanId: string; organizationId: string }): Promise<string> {
  const executionId = randomUUID();
  await query(
    `INSERT INTO agent_executions (scan_id, org_id, agent_type, task, status, attempt_number, execution_id, started_at)
     VALUES ($1, $2, 'DISCOVERY', 'Discover authorized website resources', 'running', 1, $3, NOW())`,
    [input.scanId, input.organizationId, executionId]
  );
  return executionId;
}

async function finishDiscoveryExecution(executionId: string, status: "completed" | "failed", error?: string): Promise<void> {
  await query("UPDATE agent_executions SET status = $2, completed_at = NOW(), error = $3 WHERE execution_id = $1", [executionId, status, error ?? null]);
}

function failedAgentResult(taskId: string, agentType: AgentType, message: string): AgentResult {
  return {
    status: "FAILED",
    agentType,
    agentVersion: getAgentDefinition(agentType)?.version ?? "1",
    taskId,
    findings: [],
    evidenceReferences: [],
    recommendations: [],
    confidence: 0,
    warnings: [message],
    limitations: ["Agent execution did not produce a validated result"],
  };
}

async function persistAgentFindings(
  input: { scanId: string; organizationId: string; websiteId: string },
  category: string,
  agentType: AgentType,
  findings: AgentFinding[],
): Promise<void> {
  for (const finding of findings) {
    const findingKey = key({ agent: agentType, category: finding.category, title: finding.title, affectedResource: finding.affectedResource ?? null });
    const { rows } = await query<{ id: string }>(
      `INSERT INTO findings (scan_id, website_id, org_id, logical_key, module_name, category, severity, title, description, recommendation, affected_urls, confidence, provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'INFERRED')
       ON CONFLICT (org_id, scan_id, logical_key) DO UPDATE SET description=EXCLUDED.description, recommendation=EXCLUDED.recommendation, affected_urls=EXCLUDED.affected_urls, confidence=EXCLUDED.confidence
       RETURNING id`,
      [input.scanId, input.websiteId, input.organizationId, findingKey, agentType, category, finding.severity.toLowerCase(), finding.title, finding.description, finding.recommendation ?? "", finding.affectedResource ? [finding.affectedResource] : [], finding.confidence]
    );
    await query("INSERT INTO finding_evidence (finding_id, evidence_id, org_id) SELECT $1, id, $3 FROM evidence WHERE id = ANY($2::uuid[]) AND org_id = $3 AND task_id = $4 ON CONFLICT DO NOTHING", [rows[0].id, finding.evidenceIds, input.organizationId, input.scanId]);
  }
}

async function persistSeoFindings(input: { scanId: string; organizationId: string; websiteId: string }, findings: AgentFinding[]): Promise<void> {
  for (const finding of findings) {
    const findingKey = key({ agent: "SEO_ANALYSIS", category: finding.category, title: finding.title, affectedResource: finding.affectedResource ?? null });
    const { rows } = await query<{ id: string }>(
      `INSERT INTO findings (scan_id, website_id, org_id, logical_key, module_name, category, severity, title, description, recommendation, affected_urls, confidence, provenance)
       VALUES ($1,$2,$3,$4,'SEO_ANALYSIS',$5,$6,$7,$8,$9,$10,$11,'INFERRED')
       ON CONFLICT (org_id, scan_id, logical_key) DO UPDATE SET description=EXCLUDED.description, recommendation=EXCLUDED.recommendation, affected_urls=EXCLUDED.affected_urls, confidence=EXCLUDED.confidence
       RETURNING id`,
      [input.scanId, input.websiteId, input.organizationId, findingKey, finding.category, finding.severity.toLowerCase(), finding.title, finding.description, finding.recommendation ?? "", finding.affectedResource ? [finding.affectedResource] : [], finding.confidence]
    );
    await query(
      "UPDATE evidence SET finding_id = $1 WHERE id = ANY($2::uuid[]) AND org_id = $3 AND task_id = $4",
      [rows[0].id, finding.evidenceIds, input.organizationId, input.scanId]
    );
  }
}