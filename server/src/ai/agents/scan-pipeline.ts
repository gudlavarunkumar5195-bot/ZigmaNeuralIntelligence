import { createHash, randomUUID } from "node:crypto";
import { query } from "../../db/client.js";
import { assessQuality } from "../quality/evaluator.js";
import { runDiscovery } from "./discovery.js";
import { agentExecutor } from "./executor.js";
import { getOxAlphaExecutor } from "../ox-alpha.js";
import type { AgentFinding, AgentResult } from "./types.js";
import type { NewFinding } from "../../types.js";

export interface ScanIntelligenceResult {
  discoveryCount: number;
  seoResult: AgentResult | null;
  reportResult: AgentResult | null;
  status: "completed" | "unavailable" | "failed";
  error?: string;
}

function key(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runScanIntelligence(input: {
  scanId: string;
  organizationId: string;
  websiteId: string;
  target: string;
  deterministicFindings: NewFinding[];
}): Promise<ScanIntelligenceResult> {
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
    return { discoveryCount: 0, seoResult: null, reportResult: null, status: "failed", error: message };
  }

  if (discovery.pages.length === 0 || discovery.evidence.length === 0) {
    const message = "Discovery produced no usable evidence";
    await failIntelligence(input, `DISCOVERY_FAILURE: ${message}`);
    return { discoveryCount: 0, seoResult: null, reportResult: null, status: "failed", error: message };
  }

  if (!getOxAlphaExecutor()) {
    await failIntelligence(input, "MODEL_UNAVAILABLE: OPENROUTER_API_KEY is not configured");
    return { discoveryCount: discovery.pages.length, seoResult: null, reportResult: null, status: "unavailable", error: "OPENROUTER_API_KEY is not configured" };
  }

  let seoResult: AgentResult;
  try {
    seoResult = await agentExecutor.execute({
    taskId: input.scanId,
    scanId: input.scanId,
    tenantId: input.organizationId,
    websiteId: input.websiteId,
    target: input.target,
    agentType: "SEO_ANALYSIS",
    agentVersion: "1",
    evidenceReferences: discovery.evidence.map((record) => record.evidenceId),
    riskLevel: "MEDIUM",
    satisfiedDependencies: ["DISCOVERY"],
    allowedTools: ["HTML_PARSER", "STRUCTURED_DATA_PARSER", "SITEMAP_PARSER", "ROBOTS_PARSER"],
    context: {
      discoveryPages: discovery.pages,
      deterministicFindings: input.deterministicFindings,
      warnings: discovery.warnings,
    },
    });
  } catch (error: unknown) {
    const message = (error as Error).message;
    await failIntelligence(input, `SEO_FAILURE: ${message}`);
    return { discoveryCount: discovery.pages.length, seoResult: null, reportResult: null, status: "failed", error: message };
  }

  const quality = assessQuality({
    result: seoResult,
    evidenceValid: seoResult.findings.every((finding) => finding.evidenceIds.length > 0),
  });
  if (quality.status !== "ACCEPT") {
    await failIntelligence(input, `QC_REJECTED: ${quality.status}`);
    return { discoveryCount: discovery.pages.length, seoResult, reportResult: null, status: "failed", error: `SEO quality gate: ${quality.status}` };
  }

  await persistSeoFindings(input, seoResult.findings);
  let reportResult: AgentResult;
  try {
    reportResult = await agentExecutor.execute({
    taskId: input.scanId,
    scanId: input.scanId,
    tenantId: input.organizationId,
    websiteId: input.websiteId,
    target: input.target,
    agentType: "REPORT_SYNTHESIS",
    agentVersion: "1",
    evidenceReferences: discovery.evidence.map((record) => record.evidenceId),
    riskLevel: "MEDIUM",
    satisfiedDependencies: ["DISCOVERY", "SEO_ANALYSIS"],
    allowedTools: ["FINDING_AGGREGATOR"],
    context: {
      deterministicFindings: input.deterministicFindings,
      seoFindings: seoResult.findings,
      discoveryCount: discovery.pages.length,
    },
    });
  } catch (error: unknown) {
    const message = (error as Error).message;
    await failIntelligence(input, `REPORT_SYNTHESIS_FAILURE: ${message}`);
    return { discoveryCount: discovery.pages.length, seoResult, reportResult: null, status: "failed", error: message };
  }
  const reportQuality = assessQuality({
    result: reportResult,
    evidenceValid: reportResult.findings.every((finding) => finding.evidenceIds.length > 0),
  });
  if (reportQuality.status !== "ACCEPT") {
    await failIntelligence(input, `REPORT_QC_REJECTED: ${reportQuality.status}`);
    return { discoveryCount: discovery.pages.length, seoResult, reportResult, status: "failed", error: `Report quality gate: ${reportQuality.status}` };
  }
  await query(
    `UPDATE reports SET status = 'READY', summary = $4, updated_at = NOW()
     WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1`,
    [input.scanId, input.organizationId, input.websiteId, JSON.stringify({ deterministic: true, intelligence: "COMPLETED", seoStatus: seoResult.status, reportStatus: reportResult.status })]
  );
  await query("UPDATE scans SET intelligence_status = 'COMPLETED', intelligence_error = NULL WHERE id = $1 AND org_id = $2", [input.scanId, input.organizationId]);
  return { discoveryCount: discovery.pages.length, seoResult, reportResult, status: "completed" };
}

async function failIntelligence(input: { scanId: string; organizationId: string; websiteId: string }, error: string): Promise<void> {
  await query("UPDATE scans SET intelligence_status = 'FAILED', intelligence_error = $3 WHERE id = $1 AND org_id = $2", [input.scanId, input.organizationId, error]);
  await query("UPDATE reports SET status = 'FAILED', error = $4, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1", [input.scanId, input.organizationId, input.websiteId, error]);
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