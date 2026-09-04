import { createHash } from "node:crypto";
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
  const discovery = await runDiscovery({
    scanId: input.scanId,
    organizationId: input.organizationId,
    websiteId: input.websiteId,
    target: input.target,
  });

  if (!getOxAlphaExecutor()) {
    return { discoveryCount: discovery.pages.length, seoResult: null, reportResult: null, status: "unavailable", error: "OPENROUTER_API_KEY is not configured" };
  }

  const seoResult = await agentExecutor.execute({
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

  const quality = assessQuality({
    result: seoResult,
    evidenceValid: seoResult.findings.every((finding) => finding.evidenceIds.length > 0),
  });
  if (quality.status !== "ACCEPT") {
    return { discoveryCount: discovery.pages.length, seoResult, reportResult: null, status: "failed", error: `SEO quality gate: ${quality.status}` };
  }

  await persistSeoFindings(input, seoResult.findings);
  const reportResult = await agentExecutor.execute({
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
  const reportQuality = assessQuality({
    result: reportResult,
    evidenceValid: reportResult.findings.every((finding) => finding.evidenceIds.length > 0),
  });
  if (reportQuality.status !== "ACCEPT") {
    return { discoveryCount: discovery.pages.length, seoResult, reportResult, status: "failed", error: `Report quality gate: ${reportQuality.status}` };
  }
  return { discoveryCount: discovery.pages.length, seoResult, reportResult, status: "completed" };
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