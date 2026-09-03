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

const MODULE_RUNNERS: Record<string, (url: string) => Promise<ModuleResult>> = {
  seo: runSEOScanner,
  security: runSecurityScanner,
  ssl: runSSLScanner,
  performance: runPerformanceScanner,
};

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
  const { rows } = await query<{ scan_id: string; url: string; org_id: string; modules: string[] }>(
    `SELECT s.id AS scan_id, w.url, s.org_id, s.modules
     FROM scans s JOIN websites w ON w.id = s.website_id
     WHERE s.id = $1`,
    [scanId]
  );

  if (rows.length === 0) {
    console.error(`[worker] Scan ${scanId} not found`);
    return;
  }

  const { url, org_id, modules } = rows[0];

  await query(
    "UPDATE scans SET status = 'running', started_at = NOW() WHERE id = $1",
    [scanId]
  );
  await emitScanEvent(scanId, "scan_started", { scanId });

  const allFindings: NewFinding[] = [];
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

    await query(
      "UPDATE scan_modules SET status = 'running', started_at = NOW() WHERE scan_id = $1 AND module_name = $2",
      [scanId, moduleName]
    );
    await emitScanEvent(scanId, "module_started", { module: moduleName });

    let result: ModuleResult;
    try {
      result = await runner(url);
    } catch (err: unknown) {
      result = { moduleName, status: "failed", durationMs: 0, findings: [], error: (err as Error).message };
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

  // Calculate scores per category
  const categories = ["seo", "security", "ssl", "performance", "accessibility", "aiVisibility", "technicalHealth", "qa"];
  for (const cat of categories) {
    const catFindings = allFindings.filter((f) => f.category === cat);
    const moduleRan = modules.includes(cat) || modules.includes(cat.toLowerCase());

    if (!moduleRan) {
      await upsertScore(scanId, org_id, cat, null, "not_measured", 0, 0);
    } else if (moduleStatuses[cat] === "failed") {
      await upsertScore(scanId, org_id, cat, null, "failed", 0, 0);
    } else {
      const score = calculateCategoryScore(catFindings);
      const critical = catFindings.filter((f) => f.severity === "critical").length;
      await upsertScore(scanId, org_id, cat, score, "scored", catFindings.length, critical);
    }
  }

  // Determine final scan status
  const failedModules = Object.values(moduleStatuses).filter((s) => s === "failed").length;
  const finalStatus = failedModules === 0 ? "completed" : failedModules === modules.length ? "failed" : "partial";

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
       (scan_id, website_id, org_id, module_name, category, severity, title,
        description, recommendation, affected_urls, confidence, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      scanId, websiteId, orgId, moduleName, f.category, f.severity, f.title,
      f.description, f.recommendation ?? "",
      f.affectedUrls ?? [], f.confidence ?? 100, f.provenance ?? "MEASURED",
    ]
  );

  const findingId = findingRows[0].id;

  for (const ev of f.evidence) {
    const evidenceType: EvidenceType = moduleName === "security" ? "SECURITY_SCANNER_RESULT" : moduleName === "performance" ? "PERFORMANCE_METRIC" : moduleName === "ssl" ? "TLS_CERTIFICATE" : ev.type === "http_status" ? "HTTP_RESPONSE" : "HTML_DOCUMENT";
    const record = await collectEvidence({ tenantId: orgId, taskId: scanId, evidenceType, sourceType: "SCANNER", sourceReference: ev.tool ?? `${moduleName}_scanner`, resourceReference: ev.url ?? url, observedAt: new Date().toISOString(), content: { observedValue: ev.observedValue, expectedValue: ev.expectedValue, rule: ev.rule, type: ev.type }, agentId: moduleName.toUpperCase(), agentVersion: "scanner", metadata: { legacyType: ev.type, tool: ev.tool } });
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
      null, // overall score calculated separately
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
