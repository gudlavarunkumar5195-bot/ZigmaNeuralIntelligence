import { createHash } from "node:crypto"
import { query, withTransaction, createListenClient } from "../db/client.js"
import { runSEOScanner } from "../scanner/seo.js"
import { runSecurityScanner } from "../scanner/security.js"
import { runSSLScanner } from "../scanner/ssl.js"
import { runPerformanceScanner } from "../scanner/performance.js"
import { calculateCategoryScore } from "../types.js"
import type {
  ScanRow,
  ModuleResult,
  NewFinding,
  ScoreStatus,
  ScanStatus,
} from "../types.js"
import { audit } from "./audit.service.js"
import { collectEvidence } from "../ai/evidence/store.js"
import type { EvidenceType } from "../ai/evidence/types.js"
import { AI_SCAN_DEADLINE_MS } from "../ai/limits.js"
import { runScanIntelligence } from "../ai/agents/scan-pipeline.js"
import { randomUUID } from "node:crypto"
import { config } from "../config.js"
import { trackEvent } from "../analytics/events.js"

export const SCAN_LEASE_MS = 120_000
export const SCAN_HEARTBEAT_MS = 40_000
/** Consecutive heartbeat errors tolerated before the lease is declared lost. */
export const SCAN_HEARTBEAT_MAX_FAILURES = 2
const leaseHeartbeats = new Map<string, {
  lost: boolean
  timer: NodeJS.Timeout
  orgId: string
  ownerId: string
}>()

export class ScanLeaseLostError extends Error {
  constructor() {
    super("Scan execution lease was lost")
    this.name = "ScanLeaseLostError"
  }
}

export async function claimScanExecution(
  scanId: string,
  orgId: string,
  ownerId = randomUUID(),
): Promise<string | null> {
  const { rows } = await query<{ execution_owner: string }>(
    `UPDATE scans SET execution_attempts = CASE WHEN execution_owner IS NOT DISTINCT FROM $3 THEN execution_attempts ELSE execution_attempts + 1 END,
        execution_owner=$3, execution_claimed_at=NOW(), execution_lease_until=NOW() + ($4 || ' milliseconds')::interval
    WHERE id=$1 AND org_id=$2 AND status IN ('queued','running') AND intelligence_status <> 'COMPLETED' AND (execution_owner IS NULL OR execution_lease_until < NOW() OR execution_owner=$3)
     RETURNING execution_owner`,
    [scanId, orgId, ownerId, SCAN_LEASE_MS],
  )
  return rows[0]?.execution_owner ?? null
}

export async function releaseScanExecution(
  scanId: string,
  orgId: string,
  ownerId: string,
): Promise<void> {
  await query(
    "UPDATE scans SET execution_owner=NULL, execution_claimed_at=NULL, execution_lease_until=NULL WHERE id=$1 AND org_id=$2 AND execution_owner=$3",
    [scanId, orgId, ownerId],
  )
}

export async function renewScanExecution(
  scanId: string,
  orgId: string,
  ownerId: string,
): Promise<boolean> {
  const { rows } = await query<{ execution_owner: string }>(
    `UPDATE scans SET execution_lease_until=NOW() + ($4 || ' milliseconds')::interval
     WHERE id=$1 AND org_id=$2 AND execution_owner=$3 AND status <> 'cancelled' AND execution_lease_until > NOW()
     RETURNING execution_owner`,
    [scanId, orgId, ownerId, SCAN_LEASE_MS],
  )
  return rows.length > 0
}

export function startScanLeaseHeartbeat(
  scanId: string,
  orgId: string,
  ownerId: string,
): void {
  stopScanLeaseHeartbeat(scanId)
  const state = {
    lost: false,
    timer: undefined as unknown as NodeJS.Timeout,
    orgId,
    ownerId,
  }
  let consecutiveFailures = 0
  state.timer = setInterval(() => {
    void renewScanExecution(scanId, orgId, ownerId)
      .then((renewed) => {
        consecutiveFailures = 0
        if (!renewed) {
          state.lost = true
          clearInterval(state.timer)
        }
      })
      .catch((err: unknown) => {
        // A single transient DB error must not abandon a healthy scan; the
        // lease (120s) comfortably outlives a few 40s heartbeats.
        consecutiveFailures += 1
        console.error(JSON.stringify({
          event: "scan_heartbeat_failed",
          scanId,
          consecutiveFailures,
          error: (err as Error).message,
        }))
        if (consecutiveFailures > SCAN_HEARTBEAT_MAX_FAILURES) {
          state.lost = true
          clearInterval(state.timer)
        }
      })
  }, SCAN_HEARTBEAT_MS)
  state.timer.unref?.()
  leaseHeartbeats.set(scanId, state)
}

export function stopScanLeaseHeartbeat(scanId: string): void {
  const state = leaseHeartbeats.get(scanId)
  if (state) clearInterval(state.timer)
  leaseHeartbeats.delete(scanId)
}

export function hasLostScanLease(scanId: string): boolean {
  return leaseHeartbeats.get(scanId)?.lost ?? false
}

export async function isScanCancelled(
  scanId: string,
  orgId: string,
): Promise<boolean> {
  const { rows } = await query<{ status: ScanStatus }>(
    "SELECT status FROM scans WHERE id=$1 AND org_id=$2",
    [scanId, orgId],
  )
  return rows[0]?.status === "cancelled"
}

const MODULE_RUNNERS: Record<string, (url: string) => Promise<ModuleResult>> = {
  seo: runSEOScanner,
  security: runSecurityScanner,
  ssl: runSSLScanner,
  performance: runPerformanceScanner,
}

export const SCAN_MODULE_NAMES = ["seo", "security", "ssl", "performance"] as const
export type ScanModuleName = (typeof SCAN_MODULE_NAMES)[number]

export function logicalKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function isRecoverableModuleFailure(error: string | undefined): boolean {
  if (!error) return false
  if (
    /SSRF|Invalid URL|Too many redirects|Redirect with no Location/i.test(error)
  )
    return false
  return /timed out|timeout|aborted|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket/i.test(
    error,
  )
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, 250 * 2 ** Math.max(0, attempt - 1)),
  )
}

export interface ScanScoreSummary {
  category: string
  score: number | null
  status: ScoreStatus
  finding_count: number
  critical_count: number
}

export function summarizeOverallScore(
  scoreRows: ScanScoreSummary[],
): {
  score: number | null
  status: ScoreStatus
  findingCount: number
  criticalCount: number
} {
  const relevantRows = scoreRows.filter((row) => row.category !== "overall")

  if (relevantRows.length === 0) {
    return {
      score: null,
      status: "not_measured",
      findingCount: 0,
      criticalCount: 0,
    }
  }

  const measured = relevantRows.filter(
    (row) => row.score !== null && row.status === "scored",
  )
  const weightedSum = measured.reduce((sum, row) => {
    const weight =
      row.category === "seo"
        ? 0.2
        : row.category === "security"
          ? 0.2
          : row.category === "performance"
            ? 0.15
            : row.category === "ssl"
              ? 0.1
              : row.category === "accessibility"
                ? 0.1
                : row.category === "aiVisibility"
                  ? 0.1
                  : row.category === "technicalHealth"
                    ? 0.1
                    : row.category === "qa"
                      ? 0.05
                      : 0.1
    return sum + (row.score ?? 0) * weight
  }, 0)

  const totalWeight = measured.reduce((sum, row) => {
    const weight =
      row.category === "seo"
        ? 0.2
        : row.category === "security"
          ? 0.2
          : row.category === "performance"
            ? 0.15
            : row.category === "ssl"
              ? 0.1
              : row.category === "accessibility"
                ? 0.1
                : row.category === "aiVisibility"
                  ? 0.1
                  : row.category === "technicalHealth"
                    ? 0.1
                    : row.category === "qa"
                      ? 0.05
                      : 0.1
    return sum + weight
  }, 0)

  const hasFailures = relevantRows.some((row) => row.status === "failed")
  const hasIncomplete = relevantRows.some((row) => row.status !== "scored")
  const findingCount = relevantRows.reduce(
    (sum, row) => sum + row.finding_count,
    0,
  )
  const criticalCount = relevantRows.reduce(
    (sum, row) => sum + row.critical_count,
    0,
  )

  if (measured.length === 0) {
    return {
      score: null,
      status: hasFailures ? "failed" : "not_measured",
      findingCount,
      criticalCount,
    }
  }

  const score = Math.round(weightedSum / totalWeight)
  return {
    score,
    status: hasFailures ? "failed" : hasIncomplete ? "partial" : "scored",
    findingCount,
    criticalCount,
  }
}

// ─── Create Scan ──────────────────────────────────────────────────────────────

export interface CreateScanInput {
  websiteId: string
  orgId: string
  triggeredBy: string | null
  modules?: string[]
}

export class ScanAdmissionError extends Error {
  readonly statusCode = 429
  constructor(message: string) {
    super(message)
    this.name = "ScanAdmissionError"
  }
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }

async function enforceScanAdmission(db: Queryable, orgId: string): Promise<void> {
  // Serialise admission per tenant for the duration of the transaction so
  // concurrent requests cannot all pass the check-then-insert race.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scan-admission:${orgId}`])
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('queued','running')) AS active_count,
            COUNT(*) FILTER (WHERE status = 'queued') AS queued_count,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute') AS recent_count
       FROM scans WHERE org_id=$1`,
    [orgId],
  )
  const row = rows[0]
  const activeLimit = config.MAX_CONCURRENT_SCANS_PER_TENANT ?? 2
  const queuedLimit = config.MAX_QUEUED_SCANS_PER_TENANT ?? 10
  const recentLimit = config.MAX_SCAN_CREATIONS_PER_MINUTE ?? 10
  if (Number(row?.active_count ?? 0) >= activeLimit) throw new ScanAdmissionError("Tenant scan concurrency limit reached")
  if (Number(row?.queued_count ?? 0) >= queuedLimit) throw new ScanAdmissionError("Tenant scan queue limit reached")
  if (Number(row?.recent_count ?? 0) >= recentLimit) throw new ScanAdmissionError("Tenant scan creation rate limit reached")
}

/**
 * Creates the scan, its module rows and the scan_queued event atomically so a
 * crash cannot leave a scan without modules/events (F-015).
 */
export async function createScan(input: CreateScanInput): Promise<ScanRow> {
  const modules = input.modules ?? ["seo", "security", "ssl", "performance"]

  return withTransaction(async (client) => {
    await enforceScanAdmission(client, input.orgId)

    const { rows } = await client.query<ScanRow>(
      `INSERT INTO scans (website_id, org_id, triggered_by, modules)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.websiteId, input.orgId, input.triggeredBy, modules],
    )
    const scan = rows[0]

    // Pre-create module rows so status can be tracked
    await client.query(
      `INSERT INTO scan_modules (scan_id, module_name)
       SELECT $1, m FROM unnest($2::text[]) AS m`,
      [scan.id, modules],
    )
    await client.query(
      "INSERT INTO scan_events (scan_id, type, payload) VALUES ($1, $2, $3)",
      [scan.id, "scan_queued", JSON.stringify({ scanId: scan.id, modules })],
    )
    return scan
  })
}

// ─── Get Scan ─────────────────────────────────────────────────────────────────

export async function getScan(
  scanId: string,
  orgId: string,
): Promise<ScanRow | null> {
  const { rows } = await query<ScanRow>(
    "SELECT * FROM scans WHERE id = $1 AND org_id = $2",
    [scanId, orgId],
  )
  return rows[0] ?? null
}

// ─── Emit SSE Event ───────────────────────────────────────────────────────────

export async function emitScanEvent(
  scanId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    "INSERT INTO scan_events (scan_id, type, payload) VALUES ($1, $2, $3)",
    [scanId, type, JSON.stringify(payload)],
  )
}

// ─── Run Scan (called by background worker) ────────────────────────────────

export async function runScan(scanId: string, preClaimedOwner?: string): Promise<void> {
  try {
    await runScanWithLease(scanId, preClaimedOwner)
  } finally {
    const state = leaseHeartbeats.get(scanId)
    if (state)
      await releaseScanExecution(scanId, state.orgId, state.ownerId).catch(
        () => undefined,
      )
    stopScanLeaseHeartbeat(scanId)
  }
}

async function runScanWithLease(scanId: string, preClaimedOwner?: string): Promise<void> {
  const scanDeadline = Date.now() + (config.SCANNER_MAX_SCAN_DURATION_MS ?? 300_000)
  // Fetch scan + website URL — enforce org isolation via JOIN
  const { rows } = await query<{
    scan_id: string
    url: string
    org_id: string
    website_id: string
    modules: string[]
  }>(
    `SELECT s.id AS scan_id, s.website_id, w.url, s.org_id, s.modules
     FROM scans s JOIN websites w ON w.id = s.website_id
    WHERE s.id = $1 AND s.org_id = w.org_id`,
    [scanId],
  )

  if (rows.length === 0) {
    console.error(`[worker] Scan ${scanId} not found`)
    return
  }

  const { url, org_id, website_id, modules } = rows[0]
  const ownerId = preClaimedOwner ?? (await claimScanExecution(scanId, org_id))
  if (!ownerId || (await isScanCancelled(scanId, org_id))) return
  startScanLeaseHeartbeat(scanId, org_id, ownerId)

  await query(
    "UPDATE scans SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND org_id = $2 AND status <> 'cancelled'",
    [scanId, org_id],
  )
  await emitScanEvent(scanId, "scan_started", { scanId })

  const { rows: persistedFindings } = await query<{
    category: string
    severity: NewFinding["severity"]
    title: string
    description: string
    recommendation: string
    affected_urls: string[]
    confidence: number
    provenance: NewFinding["provenance"]
  }>(
    `SELECT category, severity, title, description, recommendation, affected_urls, confidence, provenance
     FROM findings WHERE scan_id = $1 AND org_id = $2`,
    [scanId, org_id],
  )
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
  }))
  const moduleStatuses: Record<string, "completed" | "failed" | "skipped"> = {}

  for (const moduleName of modules) {
    if (Date.now() >= scanDeadline) throw new Error("SCAN_DEADLINE_EXCEEDED")
    if (hasLostScanLease(scanId) || (await isScanCancelled(scanId, org_id))) {
      await releaseScanExecution(scanId, org_id, ownerId)
      return
    }
    const runner = MODULE_RUNNERS[moduleName]
    if (!runner) {
      await query(
        "UPDATE scan_modules SET status = 'skipped' WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName],
      )
      moduleStatuses[moduleName] = "skipped"
      await emitScanEvent(scanId, "module_skipped", {
        module: moduleName,
        reason: "No runner registered",
      })
      continue
    }

    const { rows: claimed } = await query<{
      id: string
      retry_count: number
      max_retries: number
    }>(
      `UPDATE scan_modules
       SET status = 'running', started_at = NOW(), retry_count = retry_count + 1
       WHERE scan_id = $1 AND module_name = $2
         AND (status = 'pending' OR (status = 'failed' AND retry_count < max_retries + 1))
       RETURNING id, retry_count, max_retries`,
      [scanId, moduleName],
    )
    if (claimed.length === 0) {
      const { rows: current } = await query<{
        status: "pending" | "running" | "completed" | "failed" | "skipped"
      }>(
        "SELECT status FROM scan_modules WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName],
      )
      if (current[0]?.status === "completed") {
        moduleStatuses[moduleName] = "completed"
        continue
      }
      if (current[0]?.status === "skipped") {
        moduleStatuses[moduleName] = "skipped"
        continue
      }
      if (current[0]?.status === "failed") {
        // Retry budget exhausted (e.g. across crash recoveries): keep the
        // failure instead of abandoning the scan.
        moduleStatuses[moduleName] = "failed"
        continue
      }
      // Another worker owns this module. It will finalize the scan.
      return
    }
    await emitScanEvent(scanId, "module_started", { module: moduleName })

    let result: ModuleResult
    let attempt = claimed[0].retry_count
    const maxAttempts = claimed[0].max_retries + 1
    while (true) {
      if (Date.now() >= scanDeadline) throw new Error("SCAN_DEADLINE_EXCEEDED")
      try {
        result = await runner(url)
      } catch (err: unknown) {
        result = {
          moduleName,
          status: "failed",
          durationMs: 0,
          findings: [],
          error: (err as Error).message,
        }
      }
      if (
        result.status !== "failed" ||
        !isRecoverableModuleFailure(result.error) ||
        attempt >= maxAttempts
      )
        break
      await retryDelay(attempt)
      attempt += 1
      await query(
        "UPDATE scan_modules SET retry_count = $3 WHERE scan_id = $1 AND module_name = $2",
        [scanId, moduleName, attempt],
      )
      await emitScanEvent(scanId, "module_retry", {
        module: moduleName,
        attempt,
        maxAttempts,
      })
    }

    await query(
      `UPDATE scan_modules
         SET status = $3, completed_at = NOW(), duration_ms = $4, error = $5
       WHERE scan_id = $1 AND module_name = $2`,
      [
        scanId,
        moduleName,
        result.status,
        result.durationMs,
        result.error ?? null,
      ],
    )

    if (result.status === "completed" || result.findings.length > 0) {
      for (const f of result.findings) {
        await persistFinding(scanId, url, org_id, moduleName, f)
      }
      allFindings.push(...result.findings)
    }

    moduleStatuses[moduleName] =
      result.status === "completed" ? "completed" : "failed"
    await emitScanEvent(scanId, "module_completed", {
      module: moduleName,
      status: result.status,
      findingCount: result.findings.length,
      durationMs: result.durationMs,
    })
    if (hasLostScanLease(scanId)) {
      await releaseScanExecution(scanId, org_id, ownerId)
      return
    }
  }

  if (Date.now() >= scanDeadline) throw new Error("SCAN_DEADLINE_EXCEEDED")
  if (hasLostScanLease(scanId) || (await isScanCancelled(scanId, org_id))) {
    await releaseScanExecution(scanId, org_id, ownerId)
    return
  }
  // The pipeline polls a synchronous predicate: lost lease is in memory, and
  // cancellation is mirrored from the database by a short-lived refresher.
  let cancelledFlag = false
  const cancelWatcher = setInterval(() => {
    isScanCancelled(scanId, org_id)
      .then((cancelled) => { if (cancelled) cancelledFlag = true })
      .catch((error: unknown) => console.error(JSON.stringify({ event: "scan_cancel_watch_failed", scanId, error: (error as Error).message })))
  }, 2_000)
  try {
    const intelligence = await runScanIntelligence({
      isAborted: () => cancelledFlag || hasLostScanLease(scanId),
      scanId,
      organizationId: org_id,
      websiteId: website_id,
      target: url,
      deterministicFindings: allFindings,
      deadlineAt: Date.now() + AI_SCAN_DEADLINE_MS,
    })
    await emitScanEvent(scanId, "intelligence_completed", {
      status: intelligence.status,
      discoveryCount: intelligence.discoveryCount,
      seoStatus: intelligence.seoResult?.status ?? "UNAVAILABLE",
      reportStatus: intelligence.reportResult?.status ?? "UNAVAILABLE",
      error: intelligence.error,
    })
  } catch (err: unknown) {
    await query(
      "UPDATE scans SET intelligence_status = 'FAILED', intelligence_error = $3 WHERE id = $1 AND org_id = $2",
      [scanId, org_id, (err as Error).message],
    )
    await query(
      "UPDATE reports SET status = 'FAILED', error = $4, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 AND report_version = 1",
      [scanId, org_id, website_id, (err as Error).message],
    )
    await emitScanEvent(scanId, "intelligence_failed", {
      error: (err as Error).message,
    })
  } finally {
    clearInterval(cancelWatcher)
  }

  if (hasLostScanLease(scanId) || (await isScanCancelled(scanId, org_id))) {
    await releaseScanExecution(scanId, org_id, ownerId)
    return
  }
  // Calculate scores per category
  const categories = [
    "seo",
    "security",
    "ssl",
    "performance",
    "accessibility",
    "aiVisibility",
    "technicalHealth",
    "qa",
  ]
  const categoryRows: ScanScoreSummary[] = []

  for (const cat of categories) {
    const catFindings = allFindings.filter((f) => f.category === cat)
    const moduleRan =
      Object.prototype.hasOwnProperty.call(MODULE_RUNNERS, cat) &&
      (modules.includes(cat) || modules.includes(cat.toLowerCase()))

    if (!moduleRan) {
      const row = {
        category: cat,
        score: null,
        status: "not_measured" as ScoreStatus,
        finding_count: 0,
        critical_count: 0,
      }
      categoryRows.push(row)
      await upsertScore(scanId, org_id, cat, null, "not_measured", 0, 0)
    } else if (moduleStatuses[cat] === "failed") {
      const row = {
        category: cat,
        score: null,
        status: "failed" as ScoreStatus,
        finding_count: catFindings.length,
        critical_count: catFindings.filter((f) => f.severity === "critical")
          .length,
      }
      categoryRows.push(row)
      await upsertScore(
        scanId,
        org_id,
        cat,
        null,
        "failed",
        row.finding_count,
        row.critical_count,
      )
    } else {
      const score = calculateCategoryScore(catFindings)
      const critical = catFindings.filter(
        (f) => f.severity === "critical",
      ).length
      const row = {
        category: cat,
        score,
        status: "scored" as ScoreStatus,
        finding_count: catFindings.length,
        critical_count: critical,
      }
      categoryRows.push(row)
      await upsertScore(
        scanId,
        org_id,
        cat,
        score,
        "scored",
        catFindings.length,
        critical,
      )
    }
  }

  const overallSummary = summarizeOverallScore(categoryRows)
  await upsertScore(
    scanId,
    org_id,
    "overall",
    overallSummary.score,
    overallSummary.status,
    overallSummary.findingCount,
    overallSummary.criticalCount,
  )
  await query(
    "UPDATE reports SET deterministic_score = $3, updated_at = NOW() WHERE scan_id = $1 AND org_id = $2 AND report_version = 1",
    [scanId, org_id, overallSummary.score],
  )

  // Determine final scan status
  const incompleteModules = Object.values(moduleStatuses).filter(
    (s) => s !== "completed",
  ).length
  const finalStatus =
    incompleteModules === 0
      ? "completed"
      : incompleteModules === modules.length
        ? "failed"
        : "partial"

  if (hasLostScanLease(scanId) || (await isScanCancelled(scanId, org_id))) {
    await releaseScanExecution(scanId, org_id, ownerId)
    return
  }
  const finalized = await query(
    "UPDATE scans SET status = $2, completed_at = NOW() WHERE id = $1 AND org_id = $3 AND execution_owner = $4 AND execution_lease_until > NOW() AND status = 'running' RETURNING id",
    [scanId, finalStatus, org_id, ownerId],
  )
  if (finalized.rows.length === 0) {
    // F-026: we lost the lease (expired/requeued/cancelled). Another owner or
    // the sweeper decides the outcome; do not emit completion or audit.
    console.warn(`[worker] Scan ${scanId} lost its lease before completion; discarding result`)
    return
  }

  // The terminal event is emitted first so a failure in any follow-up can
  // never leave a completed scan without scan_completed (SSE would hang).
  await emitScanEvent(scanId, "scan_completed", { scanId, status: finalStatus })
  trackEvent("scan_events", org_id, { scan_id: scanId, website_id, status: finalStatus, modules, duration_ms: null })

  const followUp = async (step: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err: unknown) {
      console.error(JSON.stringify({
        event: "scan_completion_followup_failed",
        step,
        scanId,
        orgId: org_id,
        error: (err as Error).message,
      }))
    }
  }

  await followUp("finalize_monitoring_run", () =>
    import("./monitoring.service.js").then(({ finalizeMonitoringRun }) =>
      finalizeMonitoringRun(scanId, org_id, finalStatus),
    ),
  )
  await followUp("snapshot_monitoring", async () => {
    if (!(await isScanCancelled(scanId, org_id)))
      await snapshotMonitoring(scanId, org_id, url)
  })
  await followUp("release_execution", () => releaseScanExecution(scanId, org_id, ownerId))
  await followUp("audit", () =>
    audit({
      orgId: org_id,
      action: "scan_completed",
      resourceType: "scan",
      resourceId: scanId as unknown as string,
      result: "success",
      metadata: { status: finalStatus },
    }),
  )
}

async function persistFinding(
  scanId: string,
  url: string,
  orgId: string,
  moduleName: string,
  f: NewFinding,
): Promise<string> {
  // Get website_id from scan
  const { rows: scanRows } = await query<{ website_id: string }>(
    "SELECT website_id FROM scans WHERE id = $1 AND org_id = $2",
    [scanId, orgId],
  )
  const websiteId = scanRows[0]?.website_id

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
      scanId,
      websiteId,
      orgId,
      logicalKey({
        moduleName,
        category: f.category,
        severity: f.severity,
        title: f.title,
        affectedUrls: f.affectedUrls ?? [],
      }),
      moduleName,
      f.category,
      f.severity,
      f.title,
      f.description,
      f.recommendation ?? "",
      f.affectedUrls ?? [],
      f.confidence ?? 100,
      f.provenance ?? "MEASURED",
    ],
  )

  const findingId = findingRows[0].id
  trackEvent("scan_findings", orgId, { scan_id: scanId, website_id: websiteId, finding_id: findingId, module_name: moduleName, category: f.category, severity: f.severity })

  for (const ev of f.evidence) {
    const evidenceType: EvidenceType =
      moduleName === "security"
        ? "SECURITY_SCANNER_RESULT"
        : moduleName === "performance"
          ? "PERFORMANCE_METRIC"
          : moduleName === "ssl"
            ? "TLS_CERTIFICATE"
            : ev.type === "http_status"
              ? "HTTP_RESPONSE"
              : "HTML_DOCUMENT"
    const evidenceKey = logicalKey({
      findingId: logicalKey({
        moduleName,
        category: f.category,
        severity: f.severity,
        title: f.title,
        affectedUrls: f.affectedUrls ?? [],
      }),
      type: ev.type,
      url: ev.url ?? url,
      observedValue: ev.observedValue ?? null,
      expectedValue: ev.expectedValue ?? null,
      rule: ev.rule ?? null,
      tool: ev.tool ?? null,
    })
    const record = await collectEvidence({
      tenantId: orgId,
      taskId: scanId,
      logicalKey: evidenceKey,
      evidenceType,
      sourceType: "SCANNER",
      sourceReference: ev.tool ?? `${moduleName}_scanner`,
      resourceReference: ev.url ?? url,
      observedAt: new Date().toISOString(),
      content: {
        observedValue: ev.observedValue,
        expectedValue: ev.expectedValue,
        rule: ev.rule,
        type: ev.type,
      },
      agentId: moduleName.toUpperCase(),
      agentVersion: "scanner",
      metadata: { legacyType: ev.type, tool: ev.tool },
    })
    await query(
      `UPDATE evidence SET type=$2, url=$3, observed_value=$4, expected_value=$5, rule=$6, tool=$7, metadata = metadata || $8::jsonb WHERE id=$1`,
      [
        record.evidenceId,
        ev.type,
        ev.url ?? null,
        ev.observedValue ?? null,
        ev.expectedValue ?? null,
        ev.rule ?? null,
        ev.tool ?? null,
        JSON.stringify({ websiteId: websiteId }),
      ],
    )
    await query(
      "INSERT INTO finding_evidence (finding_id, evidence_id, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [findingId, record.evidenceId, orgId],
    )
  }

  return findingId
}

async function upsertScore(
  scanId: string,
  orgId: string,
  category: string,
  score: number | null,
  status: ScoreStatus,
  findingCount: number,
  criticalCount: number,
): Promise<void> {
  await query(
    `INSERT INTO scan_scores (scan_id, org_id, category, score, status, finding_count, critical_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scan_id, category) DO UPDATE
       SET score = EXCLUDED.score, status = EXCLUDED.status,
           finding_count = EXCLUDED.finding_count, critical_count = EXCLUDED.critical_count`,
    [scanId, orgId, category, score, status, findingCount, criticalCount],
  )
}

async function snapshotMonitoring(
  scanId: string,
  orgId: string,
  _url: string,
): Promise<void> {
  const { rows: scoreRows } = await query<{
    category: string
    score: number | null
  }>("SELECT category, score FROM scan_scores WHERE scan_id = $1 AND org_id = $2", [scanId, orgId])
  const scores = Object.fromEntries(scoreRows.map((r) => [r.category, r.score]))

  const { rows: scanRows } = await query<{ website_id: string }>(
    "SELECT website_id FROM scans WHERE id = $1 AND org_id = $2",
    [scanId, orgId],
  )

  await query(
    `INSERT INTO monitoring_snapshots
       (website_id, org_id, scan_id, overall_score, seo_score, security_score,
        performance_score, accessibility_score, ssl_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      scanRows[0]?.website_id,
      orgId,
      scanId,
      scores["overall"] ?? null,
      scores["seo"] ?? null,
      scores["security"] ?? null,
      scores["performance"] ?? null,
      scores["accessibility"] ?? null,
      scores["ssl"] ?? null,
    ],
  )
}

// ─── Background Worker ────────────────────────────────────────────────────────

let workerRunning = false
let workerTimer: NodeJS.Timeout | null = null
let sweeperTimer: NodeJS.Timeout | null = null
let workerStopping = false
let workerActive: Promise<void> | null = null

export const SCAN_SWEEP_INTERVAL_MS = 30_000

export function startScanWorker(intervalMs: number): NodeJS.Timeout {
  console.log(`[worker] Starting scan worker (poll interval: ${intervalMs}ms)`)

  workerStopping = false
  workerTimer = setInterval(async () => {
    if (workerRunning || workerStopping) return
    workerRunning = true
    workerActive = processNextQueuedScan()
      .catch((err: unknown) => console.error("[worker] Queue poll failed:", (err as Error).message))
      .finally(() => { workerRunning = false; workerActive = null })
  }, intervalMs)

  // Crash recovery: requeue/fail scans whose execution lease expired.
  void recoverExpiredScanLeases().catch((err: unknown) =>
    console.error(JSON.stringify({ event: "startup_lease_recovery_failed", error: (err as Error).message })),
  )
  sweeperTimer = setInterval(() => {
    if (workerStopping) return
    void recoverExpiredScanLeases().catch((err: unknown) =>
      console.error("[worker] Lease sweep failed:", (err as Error).message),
    )
  }, SCAN_SWEEP_INTERVAL_MS)
  sweeperTimer.unref?.()
  return workerTimer
}

export interface ShutdownSummary {
  timedOut: boolean
  requeued: string[]
  failed: string[]
}

/**
 * Stop claiming new work, wait up to graceMs for the in-flight scan, then
 * hand any scans this process still owns back to the queue (or fail them when
 * attempts are exhausted) instead of leaving them RUNNING until lease expiry.
 */
export async function stopScanWorker(graceMs = 30_000): Promise<ShutdownSummary> {
  workerStopping = true
  if (workerTimer) clearInterval(workerTimer)
  if (sweeperTimer) clearInterval(sweeperTimer)
  workerTimer = null
  sweeperTimer = null
  const summary: ShutdownSummary = { timedOut: false, requeued: [], failed: [] }
  if (workerActive) {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs)
    })
    const outcome = await Promise.race([workerActive.then(() => "done" as const), timeout])
    if (timer) clearTimeout(timer)
    summary.timedOut = outcome === "timeout"
  }
  if (summary.timedOut || leaseHeartbeats.size > 0) {
    const released = await releaseOwnedScansForShutdown()
    summary.requeued = released.requeued
    summary.failed = released.failed
  }
  return summary
}

async function releaseOwnedScansForShutdown(): Promise<{ requeued: string[]; failed: string[] }> {
  const requeued: string[] = []
  const failed: string[] = []
  for (const [scanId, state] of [...leaseHeartbeats.entries()]) {
    // Make the still-running executor abandon the scan at its next checkpoint.
    state.lost = true
    clearInterval(state.timer)
    try {
      const { rows } = await query<{ status: ScanStatus }>(
        `UPDATE scans SET
           status = CASE WHEN execution_attempts < $4 THEN 'queued' ELSE 'failed' END,
           execution_attempts = GREATEST(execution_attempts - 1, 0),
           error = CASE WHEN execution_attempts < $4 THEN error ELSE 'Scan interrupted by server shutdown and retry attempts are exhausted' END,
           completed_at = CASE WHEN execution_attempts < $4 THEN NULL ELSE NOW() END,
           execution_owner = NULL, execution_claimed_at = NULL, execution_lease_until = NULL
         WHERE id = $1 AND org_id = $2 AND execution_owner = $3 AND status = 'running'
         RETURNING status`,
        [scanId, state.orgId, state.ownerId, maxExecutionAttempts()],
      )
      const status = rows[0]?.status
      if (!status) continue
      await resetRunningModules(scanId)
      if (status === "queued") {
        requeued.push(scanId)
        await emitScanEvent(scanId, "scan_requeued", { scanId, reason: "shutdown" })
      } else {
        failed.push(scanId)
        await emitScanEvent(scanId, "scan_failed", { scanId, reason: "shutdown_attempts_exhausted" })
        await finalizeFailedScan(scanId, state.orgId, "shutdown_attempts_exhausted")
      }
    } catch (err: unknown) {
      console.error(`[worker] Shutdown release failed for scan ${scanId}:`, (err as Error).message)
    }
  }
  return { requeued, failed }
}

export function maxExecutionAttempts(): number {
  return config.SCAN_MAX_EXECUTION_ATTEMPTS ?? 3
}

async function resetRunningModules(scanId: string): Promise<void> {
  // A module left 'running' by a dead executor can never be re-claimed;
  // mark it failed so it is retried within its normal retry budget.
  await query(
    "UPDATE scan_modules SET status='failed', error='Worker lease expired before module finished', completed_at=NOW() WHERE scan_id=$1 AND status='running'",
    [scanId],
  )
}

async function finalizeFailedScan(
  scanId: string,
  orgId: string,
  reason = "execution_lease_expired",
): Promise<void> {
  await import("./monitoring.service.js")
    .then(({ finalizeMonitoringRun }) => finalizeMonitoringRun(scanId, orgId, "failed"))
    .catch((err: unknown) =>
      console.error(`[worker] finalizeMonitoringRun failed for scan ${scanId}:`, (err as Error).message),
    )
  await audit({
    orgId,
    action: "scan_failed",
    resourceType: "scan",
    resourceId: scanId,
    result: "failure",
    metadata: { reason },
  }).catch((err: unknown) =>
    console.error(JSON.stringify({ event: "scan_failed_audit_failed", scanId, orgId, error: (err as Error).message })),
  )
}

export interface LeaseRecoveryResult {
  requeued: { scanId: string; orgId: string }[]
  failed: { scanId: string; orgId: string }[]
}

/**
 * Sweeper: RUNNING scans whose lease expired (worker crashed) are requeued
 * while attempts remain, otherwise failed with a clear error. FOR UPDATE SKIP
 * LOCKED plus the status/lease predicate make concurrent sweepers safe: a row
 * is transitioned out of 'running' exactly once. Live leases are untouched.
 */
export async function recoverExpiredScanLeases(
  opts: { orgId?: string; maxAttempts?: number; limit?: number } = {},
): Promise<LeaseRecoveryResult> {
  const maxAttempts = opts.maxAttempts ?? maxExecutionAttempts()
  const result: LeaseRecoveryResult = { requeued: [], failed: [] }

  const transitioned = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; org_id: string; status: ScanStatus }>(
      `WITH expired AS (
         SELECT id FROM scans
          WHERE status = 'running'
            AND ($1::uuid IS NULL OR org_id = $1)
            AND (execution_lease_until < NOW()
                 OR (execution_lease_until IS NULL AND COALESCE(execution_claimed_at, started_at, created_at) < NOW() - ($4 || ' milliseconds')::interval))
          ORDER BY created_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE scans s SET
         status = CASE WHEN s.execution_attempts < $2 THEN 'queued' ELSE 'failed' END,
         error = CASE WHEN s.execution_attempts < $2 THEN s.error
                      ELSE 'Scan execution lease expired (worker crashed or stalled) and ' || s.execution_attempts || ' attempt(s) were exhausted' END,
         completed_at = CASE WHEN s.execution_attempts < $2 THEN NULL ELSE NOW() END,
         execution_owner = NULL, execution_claimed_at = NULL, execution_lease_until = NULL
       FROM expired
       WHERE s.id = expired.id
       RETURNING s.id, s.org_id, s.status`,
      [opts.orgId ?? null, maxAttempts, opts.limit ?? 25, SCAN_LEASE_MS],
    )
    if (rows.length > 0) {
      await client.query(
        "UPDATE scan_modules SET status='failed', error='Worker lease expired before module finished', completed_at=NOW() WHERE scan_id = ANY($1::uuid[]) AND status='running'",
        [rows.map((r) => r.id)],
      )
      for (const r of rows) {
        await client.query(
          "INSERT INTO scan_events (scan_id, type, payload) VALUES ($1, $2, $3)",
          [
            r.id,
            r.status === "queued" ? "scan_requeued" : "scan_failed",
            JSON.stringify({ scanId: r.id, reason: "execution_lease_expired" }),
          ],
        )
      }
    }
    return rows
  })

  for (const r of transitioned) {
    if (r.status === "queued") result.requeued.push({ scanId: r.id, orgId: r.org_id })
    else {
      result.failed.push({ scanId: r.id, orgId: r.org_id })
      await finalizeFailedScan(r.id, r.org_id)
    }
  }
  if (transitioned.length > 0)
    console.warn(`[worker] Lease sweep: requeued=${result.requeued.length} failed=${result.failed.length}`)
  return result
}

/**
 * Atomic claim: take one queued scan, mark it running and take the execution
 * lease in the same statement so a crash can never leave a running scan
 * without a lease the sweeper can see. `orgId` restricts the claim (tests).
 */
export async function claimNextQueuedScan(
  orgId?: string,
  ownerId = randomUUID(),
): Promise<{ scanId: string; orgId: string; ownerId: string } | null> {
  const { rows } = await query<{ id: string; org_id: string }>(
    `UPDATE scans SET status = 'running',
            execution_owner = $1, execution_claimed_at = NOW(),
            execution_lease_until = NOW() + ($2 || ' milliseconds')::interval,
            execution_attempts = execution_attempts + 1
     WHERE id = (
       SELECT id FROM scans WHERE status = 'queued' AND ($3::uuid IS NULL OR org_id = $3)
       ORDER BY created_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, org_id`,
    [ownerId, SCAN_LEASE_MS, orgId ?? null],
  )
  return rows[0] ? { scanId: rows[0].id, orgId: rows[0].org_id, ownerId } : null
}

async function processNextQueuedScan(): Promise<void> {
  await import("./monitoring.service.js")
    .then(
      async ({ processDueMonitoringJobs, processNotificationDeliveries }) => {
        await processDueMonitoringJobs()
        await processNotificationDeliveries()
      },
    )
    .catch((err: unknown) => {
      console.error(
        "[worker] Monitoring scheduler failed:",
        (err as Error).message,
      )
    })

  if (workerStopping) return

  const claimed = await claimNextQueuedScan()
  if (!claimed) return
  const { scanId, orgId, ownerId } = claimed
  console.log(`[worker] Processing scan ${scanId}`)

  try {
    await runScan(scanId, ownerId)
  } catch (err: unknown) {
    console.error(`[worker] Scan ${scanId} crashed:`, (err as Error).message)
    // Only fail the scan if it is still ours/unowned: never clobber a scan
    // that was requeued, reclaimed by another worker or cancelled.
    const failed = await query(
      `UPDATE scans SET status = 'failed', error = $3, completed_at = NOW(),
              execution_owner = NULL, execution_claimed_at = NULL, execution_lease_until = NULL
       WHERE id = $1 AND org_id = $2 AND status = 'running'
         AND (execution_owner IS NULL OR execution_owner = $4)
       RETURNING id`,
      [scanId, orgId, (err as Error).message, ownerId],
    )
    if (failed.rows.length > 0) {
      const message = (err as Error).message
      const reason = message === "SCAN_DEADLINE_EXCEEDED" ? "scan_deadline_exceeded" : "worker_crash"
      // Terminal event first so SSE subscribers always learn the scan failed.
      await emitScanEvent(scanId, "scan_failed", { scanId, reason }).catch((emitErr: unknown) =>
        console.error(JSON.stringify({ event: "scan_failed_emit_failed", scanId, orgId, error: (emitErr as Error).message })),
      )
      await finalizeFailedScan(scanId, orgId, reason)
    }
  }
}
