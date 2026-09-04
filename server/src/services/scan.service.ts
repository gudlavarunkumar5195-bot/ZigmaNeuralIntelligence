import { createHash } from "node:crypto";
import { query, withTransaction, createListenClient } from "../db/client.js";
import { runSEOScanner } from "../scanner/seo.js";
import { runSecurityScanner } from "../scanner/security.js";
import { runSSLScanner } from "../scanner/ssl.js";
import { runPerformanceScanner } from "../scanner/performance.js";
import { calculateCategoryScore } from "../types.js";
import type { ScanRow, ModuleResult, NewFinding, ScoreStatus } from "../types.js";
import { audit } from "./audit.service.js";
import { collectEvidence } from "../ai/evidence/store.js";
import type { EvidenceType } from "../ai/evidence/types.js";
import { runScanIntelligence } from "../ai/agents/scan-pipeline.js";

const MODULE_RUNNERS: Record<string, (url: string) => Promise<ModuleResult>> = {
  seo: runSEOScanner,
  security: runSecurityScanner,
  ssl: runSSLScanner,
  performance: runPerformanceScanner,
};

export function logicalKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isRecoverableModuleFailure(error: string | undefined): boolean {
  if (!error) return false;
  if (/SSRF|Invalid URL|Too many redirects|Redirect with no Location/i.test(error)) return false;
  return /timed out|timeout|aborted|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket/i.test(error);
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 * (2 ** Math.max(0, attempt - 1))));
}

export interface ScanScoreSummary {
  category: string;
  score: number | null;
  status: ScoreStatus;
  finding_count: number;
  critical_count: number;
}

export function summarizeOverallScore(scoreRows: ScanScoreSummary[]): {
  score: number | null;
  status: ScoreStatus;
  findingCount: number;
  criticalCount: number;
} {
  const relevantRows = scoreRows.filter((row) => row.category !== "overall");

  if (relevantRows.length === 0) {
    return { score: null, status: "not_measured", findingCount: 0, criticalCount: 0 };
  }

  const measured = relevantRows.filter((row) => row.score !== null && row.status === "scored");
  const weightedSum = measured.reduce((sum, row) => {
    const weight = row.category === "seo" ? 0.2 : row.category === "security" ? 0.2 : row.category === "performance" ? 0.15 : row.category === "ssl" ? 0.1 : row.category === "accessibility" ? 0.1 : row.category === "aiVisibility" ? 0.1 : row.category === "technicalHealth" ? 0.1 : row.category === "qa" ? 0.05 : 0.1;
    return sum + (row.score ?? 0) * weight;
  }, 0);

  const totalWeight = measured.reduce((sum, row) => {
    const weight = row.category === "seo" ? 0.2 : row.category === "security" ? 0.2 : row.category === "performance" ? 0.15 : row.category === "ssl" ? 0.1 : row.category === "accessibility" ? 0.1 : row.category === "aiVisibility" ? 0.1 : row.category === "technicalHealth" ? 0.1 : row.category === "qa" ? 0.05 : 0.1;
    return sum + weight;
  }, 0);

  const hasFailures = relevantRows.some((row) => row.status === "failed");
  const hasIncomplete = relevantRows.some((row) => row.status !== "scored");
  const findingCount = relevantRows.reduce((sum, row) => sum + row.finding_count, 0);
  const criticalCount = relevantRows.reduce((sum, row) => sum + row.critical_count, 0);

  if (measured.length === 0) {
    return { score: null, status: hasFailures ? "failed" : "not_measured", findingCount, criticalCount };
  }

  const score = Math.round(weightedSum / totalWeight);
  return {
    score,
    status: hasFailures ? "failed" : hasIncomplete ? "partial" : "scored",
    findingCount,
    criticalCount,
  };
}

// ─── Create Scan ──────────────────────────────────────────────────────────────

export interface CreateScanInput {
  websiteId: string;
  orgId: string;
  triggeredBy: string;
  modules?: string[];
}

export async function createScan(input: CreateScanInput): Promise<ScanRow> {
  const modules = input.modules ?? ["seo", "security", "ssl", "performance"];

  const { rows } = await query<ScanRow>(
    `INSERT INTO scans (website_id, org_id, triggered_by, modules)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.websiteId, input.orgId, input.triggeredBy, modules]
  );

  const scan = rows[0];

  // Pre-create module rows so status can be tracked
  for (const mod of modules) {
    await query(
      `INSERT INTO scan_modules (scan_id, module_name) VALUES ($1, $2)`,
      [scan.id, mod]
    );
  }

  await emitScanEvent(scan.id, "scan_queued", { scanId: scan.id, modules });
  return scan;
}

// ─── Get Scan ─────────────────────────────────────────────────────────────────

export async function getScan(scanId: string, orgId: string): Promise<ScanRow | null> {
  const { rows } = await query<ScanRow>(
    "SELECT * FROM scans WHERE id = $1 AND org_id = $2",
    [scanId, orgId]
  );
  return rows[0] ?? null;
}

// ─── Emit SSE Event ───────────────────────────────────────────────────────────

export async function emitScanEvent(
  scanId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  await query(
    "INSERT INTO scan_events (scan_id, type, payload) VALUES ($1, $2, $3)",
    [scanId, type, JSON.stringify(payload)]
  );
}

// ─── Run Scan (called by background worker) ────────────────────────────────

export async function runScan(scanId: string): Promise<void> {
  // Fetch scan + website URL — enforce org isolation via JOIN
  const { rows } = await query<{ scan_id: string; url: string; org_id: string; website_id: string; modules: string[] }>(
    `SELECT s.id AS scan_id, s.website_id, w.url, s.org_id, s.modules
     FROM scans s JOIN websites w ON w.id = s.website_id
     WHERE s.id = $1`,
    [scanId]
  );

  if (rows.length === 0) {
    console.error(`[worker] Scan ${scanId} not found`);
    return;
  }

  const { url, org_id, website_id, modules } = rows[0];

  await query(
    "UPDATE scans SET status = 'running', started_at = NOW() WHERE id = $1",
    [scanId]
  );
  await emitScanEvent(scanId, "scan_started", { scanId });

  const { rows: persistedFindings } = await query<{
    category: string;
    severity: NewFinding["severity"];
    title: string;
    description: string;
    recommendation: string;
    affected_urls: string[];
    confidence: number;
    provenance: NewFinding["provenance"];
  }>(
    `SELECT category, severity, title, description, recommendation, affected_urls, confidence, provenance
     FROM findings WHERE scan_id = $1 AND org_id = $2`,
    [scanId, org_id]
  );
  const allFindings: NewFinding[] = persistedFindings.map((finding) => ({
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    recommendation: finding.recommendation,
    affectedUrls: finding.affected_urls,
    confidence: finding.confidence,
    provenance: finding.provenance,
    evidence: [],
  }));
  const moduleStatuses: Record<string, "completed" | "failed" | "skipped"> = {};

  for (const moduleName of modules) {
    const runner = MODULE_RUNNERS[moduleName];
    if (!runner) {
      await query(
        "UPDATE scan_modules SET status = 'skipped' WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName]
      );
      moduleStatuses[moduleName] = "skipped";
      await emitScanEvent(scanId, "module_skipped", { module: moduleName, reason: "No runner registered" });
      continue;
    }

    const { rows: claimed } = await query<{ id: string; retry_count: number; max_retries: number }>(
      `UPDATE scan_modules
       SET status = 'running', started_at = NOW(), retry_count = retry_count + 1
       WHERE scan_id = $1 AND module_name = $2
         AND (status = 'pending' OR (status = 'failed' AND retry_count < max_retries + 1))
       RETURNING id, retry_count, max_retries`,
      [scanId, moduleName]
    );
    if (claimed.length === 0) {
      const { rows: current } = await query<{ status: "pending" | "running" | "completed" | "failed" | "skipped" }>(
        "SELECT status FROM scan_modules WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName]
      );
      if (current[0]?.status === "completed") {
        moduleStatuses[moduleName] = "completed";
        continue;
      }
      if (current[0]?.status === "skipped") {
        moduleStatuses[moduleName] = "skipped";
        continue;
      }
      // Another worker owns this module. It will finalize the scan.
      return;
    }
    await emitScanEvent(scanId, "module_started", { module: moduleName });

    let result: ModuleResult;
    let attempt = claimed[0].retry_count;
    const maxAttempts = claimed[0].max_retries + 1;
    while (true) {
      try {
        result = await runner(url);
      } catch (err: unknown) {
        result = { moduleName, status: "failed", durationMs: 0, findings: [], error: (err as Error).message };
      }
      if (result.status !== "failed" || !isRecoverableModuleFailure(result.error) || attempt >= maxAttempts) break;
      await retryDelay(attempt);
      attempt += 1;
      await query(
        "UPDATE scan_modules SET retry_count = $3 WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName, attempt]
      );
      await emitScanEvent(scanId, "module_retry", { module: moduleName, attempt, maxAttempts });
    }

    await query(
      `UPDATE scan_modules
         SET status = $3, completed_at = NOW(), duration_ms = $4, error = $5
       WHERE scan_id = $1 AND module_name = $2`,
      [scanId, moduleName, result.status, result.durationMs, result.error ?? null]
    );

    if (result.status === "completed" || result.findings.length > 0) {
      for (const f of result.findings) {
        await persistFinding(scanId, url, org_id, moduleName, f);
      }
      allFindings.push(...result.findings);
    }

    moduleStatuses[moduleName] = result.status === "completed" ? "completed" : "failed";
    await emitScanEvent(scanId, "module_completed", {
      module: moduleName,
      status: result.status,
      findingCount: result.findings.length,
      durationMs: result.durationMs,
    });
  }

  try {
    const intelligence = await runScanIntelligence({
      scanId,
      organizationId: org_id,
      websiteId: website_id,
      target: url,
      deterministicFindings: allFindings,
    });
    await emitScanEvent(scanId, "intelligence_completed", {
      status: intelligence.status,
      discoveryCount: intelligence.discoveryCount,
      seoStatus: intelligence.seoResult?.status ?? "UNAVAILABLE",
      reportStatus: intelligence.reportResult?.status ?? "UNAVAILABLE",
      error: intelligence.error,
    });
  } catch (err: unknown) {
    await query("UPDATE scans SET intelligence_status = 'FAILED', intelligence_error = $3 WHERE id = $1 AND org_id = $2", [scanId, org_id, (err as Error).message]);
    await query("UPDATE reports SET status = 'FAILED', error = $4, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1", [scanId, org_id, website_id, (err as Error).message]);
    await emitScanEvent(scanId, "intelligence_failed", { error: (err as Error).message });
  }

  // Calculate scores per category
  const categories = ["seo", "security", "ssl", "performance", "accessibility", "aiVisibility", "technicalHealth", "qa"];
  const categoryRows: ScanScoreSummary[] = [];

  for (const cat of categories) {
    const catFindings = allFindings.filter((f) => f.category === cat);
    const moduleRan = modules.includes(cat) || modules.includes(cat.toLowerCase());

    if (!moduleRan) {
      const row = { category: cat, score: null, status: "not_measured" as ScoreStatus, finding_count: 0, critical_count: 0 };
      categoryRows.push(row);
      await upsertScore(scanId, org_id, cat, null, "not_measured", 0, 0);
    } else if (moduleStatuses[cat] === "failed") {
      const row = { category: cat, score: null, status: "failed" as ScoreStatus, finding_count: catFindings.length, critical_count: catFindings.filter((f) => f.severity === "critical").length };
      categoryRows.push(row);
      await upsertScore(scanId, org_id, cat, null, "failed", row.finding_count, row.critical_count);
    } else {
      const score = calculateCategoryScore(catFindings);
      const critical = catFindings.filter((f) => f.severity === "critical").length;
      const row = { category: cat, score, status: "scored" as ScoreStatus, finding_count: catFindings.length, critical_count: critical };
      categoryRows.push(row);
      await upsertScore(scanId, org_id, cat, score, "scored", catFindings.length, critical);
    }
  }

  const overallSummary = summarizeOverallScore(categoryRows);
  await upsertScore(scanId, org_id, "overall", overallSummary.score, overallSummary.status, overallSummary.findingCount, overallSummary.criticalCount);
  await query(
    "UPDATE reports SET deterministic_score = $3, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND report_version = 1",
    [scanId, org_id, overallSummary.score]
  );

  // Determine final scan status
  const incompleteModules = Object.values(moduleStatuses).filter((s) => s !== "completed").length;
  const finalStatus = incompleteModules === 0 ? "completed" : incompleteModules === modules.length ? "failed" : "partial";

  await query(
    "UPDATE scans SET status = $2, completed_at = NOW() WHERE id = $1",
    [scanId, finalStatus]
  );

  // Snapshot for monitoring
  await snapshotMonitoring(scanId, org_id, url);

  await emitScanEvent(scanId, "scan_completed", { scanId, status: finalStatus });

  await audit({
    orgId: org_id,
    action: "scan_completed",
    resourceType: "scan",
    resourceId: scanId as unknown as string,
    result: "success",
    metadata: { status: finalStatus },
  });
}

async function persistFinding(
  scanId: string,
  url: string,
  orgId: string,
  moduleName: string,
  f: NewFinding
): Promise<string> {
  // Get website_id from scan
  const { rows: scanRows } = await query<{ website_id: string }>(
    "SELECT website_id FROM scans WHERE id = $1",
    [scanId]
  );
  const websiteId = scanRows[0]?.website_id;

  const { rows: findingRows } = await query<{ id: string }>(
    `INSERT INTO findings
       (scan_id, website_id, org_id, logical_key, module_name, category, severity, title,
        description, recommendation, affected_urls, confidence, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (org_id, scan_id, logical_key) DO UPDATE
       SET description = EXCLUDED.description,
           recommendation = EXCLUDED.recommendation,
           affected_urls = EXCLUDED.affected_urls,
           confidence = EXCLUDED.confidence,
           provenance = EXCLUDED.provenance
     RETURNING id`,
    [
      scanId, websiteId, orgId, logicalKey({ moduleName, category: f.category, severity: f.severity, title: f.title, affectedUrls: f.affectedUrls ?? [] }), moduleName, f.category, f.severity, f.title,
      f.description, f.recommendation ?? "",
      f.affectedUrls ?? [], f.confidence ?? 100, f.provenance ?? "MEASURED",
    ]
  );

  const findingId = findingRows[0].id;

  for (const ev of f.evidence) {
    const evidenceType: EvidenceType = moduleName === "security" ? "SECURITY_SCANNER_RESULT" : moduleName === "performance" ? "PERFORMANCE_METRIC" : moduleName === "ssl" ? "TLS_CERTIFICATE" : ev.type === "http_status" ? "HTTP_RESPONSE" : "HTML_DOCUMENT";
    const evidenceKey = logicalKey({ findingId: logicalKey({ moduleName, category: f.category, severity: f.severity, title: f.title, affectedUrls: f.affectedUrls ?? [] }), type: ev.type, url: ev.url ?? url, observedValue: ev.observedValue ?? null, expectedValue: ev.expectedValue ?? null, rule: ev.rule ?? null, tool: ev.tool ?? null });
    const record = await collectEvidence({ tenantId: orgId, taskId: scanId, logicalKey: evidenceKey, evidenceType, sourceType: "SCANNER", sourceReference: ev.tool ?? `${moduleName}_scanner`, resourceReference: ev.url ?? url, observedAt: new Date().toISOString(), content: { observedValue: ev.observedValue, expectedValue: ev.expectedValue, rule: ev.rule, type: ev.type }, agentId: moduleName.toUpperCase(), agentVersion: "scanner", metadata: { legacyType: ev.type, tool: ev.tool } });
    await query(`UPDATE evidence SET finding_id=$2, type=$3, url=$4, observed_value=$5, expected_value=$6, rule=$7, tool=$8 WHERE id=$1`, [record.evidenceId, findingId, ev.type, ev.url ?? null, ev.observedValue ?? null, ev.expectedValue ?? null, ev.rule ?? null, ev.tool ?? null]);
  }

  return findingId;
}

async function upsertScore(
  scanId: string, orgId: string, category: string,
  score: number | null, status: ScoreStatus,
  findingCount: number, criticalCount: number
): Promise<void> {
  await query(
    `INSERT INTO scan_scores (scan_id, org_id, category, score, status, finding_count, critical_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scan_id, category) DO UPDATE
       SET score = EXCLUDED.score, status = EXCLUDED.status,
           finding_count = EXCLUDED.finding_count, critical_count = EXCLUDED.critical_count`,
    [scanId, orgId, category, score, status, findingCount, criticalCount]
  );
}

async function snapshotMonitoring(scanId: string, orgId: string, _url: string): Promise<void> {
  const { rows: scoreRows } = await query<{ category: string; score: number | null }>(
    "SELECT category, score FROM scan_scores WHERE scan_id = $1",
    [scanId]
  );
  const scores = Object.fromEntries(scoreRows.map((r) => [r.category, r.score]));

  const { rows: scanRows } = await query<{ website_id: string }>(
    "SELECT website_id FROM scans WHERE id = $1",
    [scanId]
  );

  await query(
    `INSERT INTO monitoring_snapshots
       (website_id, org_id, scan_id, overall_score, seo_score, security_score,
        performance_score, accessibility_score, ssl_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      scanRows[0]?.website_id, orgId, scanId,
      scores["overall"] ?? null,
      scores["seo"] ?? null, scores["security"] ?? null,
      scores["performance"] ?? null, scores["accessibility"] ?? null,
      scores["ssl"] ?? null,
    ]
  );
}

// ─── Background Worker ────────────────────────────────────────────────────────

let workerRunning = false;

export function startScanWorker(intervalMs: number): NodeJS.Timeout {
  console.log(`[worker] Starting scan worker (poll interval: ${intervalMs}ms)`);

  return setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await processNextQueuedScan();
    } catch (err: unknown) {
      console.error("[worker] Queue poll failed:", (err as Error).message);
    } finally {
      workerRunning = false;
    }
  }, intervalMs);
}

async function processNextQueuedScan(): Promise<void> {
  // Atomic claim: take one queued scan and set it to running
  const { rows } = await query<{ id: string }>(
    `UPDATE scans SET status = 'running'
     WHERE id = (
       SELECT id FROM scans WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`
  );

  if (rows.length === 0) return;

  const scanId = rows[0].id;
  console.log(`[worker] Processing scan ${scanId}`);

  try {
    await runScan(scanId);
  } catch (err: unknown) {
    console.error(`[worker] Scan ${scanId} crashed:`, (err as Error).message);
    await query(
      "UPDATE scans SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1",
      [scanId, (err as Error).message]
    );
  }
}
