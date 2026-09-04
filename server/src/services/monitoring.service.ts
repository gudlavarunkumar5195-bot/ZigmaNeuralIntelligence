import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "../db/client.js";
import { audit } from "./audit.service.js";
import { createScan } from "./scan.service.js";
import type { ScanStatus } from "../types.js";

export const MONITORING_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export const MonitoringConfigInput = z.object({ websiteId: z.string().uuid(), frequency: z.enum(MONITORING_FREQUENCIES), modules: z.array(z.string()).min(1).optional(), alertConfig: z.record(z.unknown()).optional() }).strict();
export type MonitoringFrequency = typeof MONITORING_FREQUENCIES[number];
export type MonitoringState = "ACTIVE" | "PAUSED" | "FAILED" | "DISABLED";

const intervalDays: Record<MonitoringFrequency, number> = { daily: 1, weekly: 7, monthly: 30 };
const severityRank: Record<string, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

export function nextRunAt(frequency: MonitoringFrequency, from = new Date()): Date {
  return new Date(from.getTime() + intervalDays[frequency] * 24 * 60 * 60 * 1000);
}

export function changeSignature(change: { changeType: string; domain: string; affectedUrls: string[]; findingIds: string[] }): string {
  return createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

export function compareSnapshots(before: Snapshot | null, after: Snapshot): Array<DetectedChange> {
  if (!before) return [];
  const changes: DetectedChange[] = [];
  const beforeFindings = new Map(before.findings.map((finding) => [finding.key, finding]));
  const afterFindings = new Map(after.findings.map((finding) => [finding.key, finding]));
  for (const finding of after.findings) {
    if (!beforeFindings.has(finding.key)) changes.push(change("FINDING_INTRODUCED", finding.domain, finding.severity, [], {}, finding, finding.evidenceIds, finding.id));
  }
  for (const finding of before.findings) {
    if (!afterFindings.has(finding.key)) changes.push(change("FINDING_RESOLVED", finding.domain, finding.severity, [], finding, {}, finding.evidenceIds, finding.id));
  }
  const beforeScores = new Map(before.scores.map((score) => [score.category, score.score]));
  for (const score of after.scores) {
    const previous = beforeScores.get(score.category);
    if (previous !== undefined && score.score !== null && previous !== null && previous !== score.score) {
      const severity = score.score < previous - 20 ? "high" : score.score < previous ? "medium" : "low";
      changes.push(change("SCORE_CHANGED", domainForCategory(score.category), severity, [], { score: previous }, { score: score.score }, [], undefined));
    }
  }
  const beforePages = new Map(before.pages.map((page) => [page.url, page]));
  const afterPages = new Map(after.pages.map((page) => [page.url, page]));
  for (const page of after.pages) if (!beforePages.has(page.url)) changes.push(change("URL_ADDED", "technical", "low", [page.url], {}, page, [], undefined));
  for (const page of before.pages) if (!afterPages.has(page.url)) changes.push(change("URL_REMOVED", "technical", "medium", [page.url], page, {}, [], undefined));
  for (const page of after.pages) {
    const previous = beforePages.get(page.url);
    if (!previous) continue;
    for (const field of ["status", "title", "metaDescription", "canonical", "robots", "responseSize"] as const) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(page[field])) changes.push(change(`${field.toUpperCase()}_CHANGED`, "technical", field === "status" ? "high" : "low", [page.url], { [field]: previous[field] }, { [field]: page[field] }, [], undefined));
    }
  }
  return changes;
}

export interface Snapshot { scanId: string; pages: Array<Record<string, unknown> & { url: string }>; findings: Array<{ id: string; key: string; domain: string; severity: string; evidenceIds: string[] }>; scores: Array<{ category: string; score: number | null }>; }
export interface DetectedChange { changeType: string; domain: string; severity: string; affectedUrls: string[]; before: Record<string, unknown>; after: Record<string, unknown>; evidenceIds: string[]; findingIds: string[]; impact: string; }
function change(changeType: string, domain: string, severity: string, affectedUrls: string[], before: Record<string, unknown>, after: Record<string, unknown>, evidenceIds: string[], findingId?: string): DetectedChange { return { changeType, domain, severity, affectedUrls, before, after, evidenceIds, findingIds: findingId ? [findingId] : [], impact: `${changeType.replaceAll("_", " ").toLowerCase()} may affect ${domain} health; review the persisted before and after evidence.` }; }
function domainForCategory(category: string): string { return category === "aiVisibility" ? "ai_visibility" : category === "technicalHealth" ? "technical_health" : category; }

export async function createMonitoringConfig(orgId: string, actorId: string, input: z.infer<typeof MonitoringConfigInput>): Promise<unknown> {
  const website = await query<{ id: string }>("SELECT id FROM websites WHERE id=$1 AND org_id=$2 AND active=TRUE AND verified=TRUE", [input.websiteId, orgId]);
  if (!website.rows[0]) throw Object.assign(new Error("Verified website not found"), { statusCode: 404 });
  const modules = input.modules ?? ["seo", "security", "ssl", "performance"];
  const { rows } = await query("INSERT INTO monitoring_configs (org_id, website_id, frequency, modules, alert_config, next_run_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *", [orgId, input.websiteId, input.frequency, modules, JSON.stringify(input.alertConfig ?? {})]);
  const config = rows[0];
  for (const ruleType of ["new_critical", "regression"]) await query("INSERT INTO alert_rules (org_id, monitoring_id, rule_type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [orgId, config.id, ruleType]);
  await audit({ orgId, userId: actorId, action: "monitoring_created", resourceType: "monitoring", resourceId: config.id, result: "success" });
  return config;
}

export async function listMonitoring(orgId: string): Promise<unknown[]> { return (await query("SELECT * FROM monitoring_configs WHERE org_id=$1 ORDER BY created_at DESC", [orgId])).rows; }
export async function getMonitoring(id: string, orgId: string): Promise<unknown | null> { return (await query("SELECT * FROM monitoring_configs WHERE id=$1 AND org_id=$2", [id, orgId])).rows[0] ?? null; }

export async function claimDueMonitoring(orgId: string, ownerId = randomUUID()): Promise<{ monitoringId: string; runId: string } | null> {
  return withTransaction(async (client) => {
    const due = await client.query<{ id: string; website_id: string; frequency: MonitoringFrequency }>("SELECT id, website_id, frequency FROM monitoring_configs WHERE org_id=$1 AND enabled=TRUE AND status='ACTIVE' AND next_run_at <= NOW() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1", [orgId]);
    const config = due.rows[0];
    if (!config) return null;
    const scheduledFor = new Date();
    const run = await client.query<{ id: string }>("INSERT INTO monitoring_runs (monitoring_id, org_id, website_id, owner_id, scheduled_for, status, started_at) VALUES ($1,$2,$3,$4,$5,'RUNNING',NOW()) ON CONFLICT (monitoring_id, scheduled_for) DO NOTHING RETURNING id", [config.id, orgId, config.website_id, ownerId, scheduledFor]);
    if (!run.rows[0]) return null;
    await client.query("UPDATE monitoring_configs SET last_run_at=NOW(), next_run_at=$2, updated_at=NOW() WHERE id=$1 AND org_id=$3", [config.id, nextRunAt(config.frequency, scheduledFor), orgId]);
    return { monitoringId: config.id, runId: run.rows[0].id };
  });
}

export async function runMonitoringNow(id: string, orgId: string, actorId: string): Promise<unknown> {
  const config = await getMonitoring(id, orgId) as { website_id: string; modules: string[]; status: MonitoringState; enabled: boolean } | null;
  if (!config || !config.enabled || config.status !== "ACTIVE") throw Object.assign(new Error("Monitoring is not active"), { statusCode: 422 });
  const run = await query<{ id: string }>("INSERT INTO monitoring_runs (monitoring_id, org_id, website_id, owner_id, scheduled_for, status, started_at) VALUES ($1,$2,$3,$4,NOW(),'RUNNING',NOW()) RETURNING id", [id, orgId, config.website_id, actorId]);
  const scan = await createScan({ websiteId: config.website_id, orgId, triggeredBy: actorId, modules: config.modules });
  await query("UPDATE monitoring_runs SET scan_id=$2 WHERE id=$1 AND org_id=$3", [run.rows[0].id, scan.id, orgId]);
  await audit({ orgId, userId: actorId, action: "monitoring_triggered", resourceType: "monitoring", resourceId: id, result: "success" });
  return { monitoringRunId: run.rows[0].id, scanId: scan.id };
}

export async function createScanForClaimedMonitoring(claim: { monitoringId: string; runId: string }, orgId: string, actorId: string, websiteId: string, modules: string[]): Promise<unknown> {
  const scan = await createScan({ websiteId, orgId, triggeredBy: null, modules });
  await query("UPDATE monitoring_runs SET scan_id=$2 WHERE id=$1 AND org_id=$3", [claim.runId, scan.id, orgId]);
  return scan;
}

export async function processDueMonitoringJobs(): Promise<void> {
  const { rows } = await query<{ org_id: string }>("SELECT DISTINCT org_id FROM monitoring_configs WHERE enabled=TRUE AND status='ACTIVE' AND next_run_at <= NOW()", []);
  for (const row of rows) {
    const claim = await claimDueMonitoring(row.org_id);
    if (!claim) continue;
    const config = await getMonitoring(claim.monitoringId, row.org_id) as { website_id: string; modules: string[] } | null;
    if (!config) continue;
    await createScanForClaimedMonitoring(claim, row.org_id, randomUUID(), config.website_id, config.modules);
  }
}

export async function updateMonitoringConfig(id: string, orgId: string, actorId: string, input: { frequency?: MonitoringFrequency; modules?: string[]; alertConfig?: Record<string, unknown> }): Promise<boolean> {
  const result = await query("UPDATE monitoring_configs SET frequency=COALESCE($3, frequency), modules=COALESCE($4, modules), alert_config=COALESCE($5, alert_config), next_run_at=CASE WHEN $3 IS NULL THEN next_run_at ELSE NOW() END, updated_at=NOW() WHERE id=$1 AND org_id=$2 RETURNING id", [id, orgId, input.frequency ?? null, input.modules ?? null, input.alertConfig ? JSON.stringify(input.alertConfig) : null]);
  if (result.rows[0]) await audit({ orgId, userId: actorId, action: "monitoring_updated", resourceType: "monitoring", resourceId: id, result: "success" });
  return Boolean(result.rows[0]);
}

export async function setMonitoringState(id: string, orgId: string, actorId: string, state: "ACTIVE" | "PAUSED"): Promise<boolean> {
  const result = await query("UPDATE monitoring_configs SET status=$3, enabled=$4, updated_at=NOW() WHERE id=$1 AND org_id=$2 RETURNING id", [id, orgId, state, state === "ACTIVE"]);
  if (result.rows[0]) await audit({ orgId, userId: actorId, action: state === "ACTIVE" ? "monitoring_resumed" : "monitoring_paused", resourceType: "monitoring", resourceId: id, result: "success" });
  return Boolean(result.rows[0]);
}

export async function finalizeMonitoringRun(scanId: string, orgId: string, scanStatus: ScanStatus): Promise<void> {
  const run = (await query<{ id: string; monitoring_id: string; website_id: string }>("SELECT id, monitoring_id, website_id FROM monitoring_runs WHERE scan_id=$1 AND org_id=$2", [scanId, orgId])).rows[0];
  if (!run) return;
  if (scanStatus !== "completed") {
    await query("UPDATE monitoring_runs SET status=$3, completed_at=NOW(), error=$4 WHERE id=$1 AND org_id=$2", [run.id, orgId, scanStatus === "cancelled" ? "CANCELLED" : "FAILED", `Scan ended ${scanStatus}`]);
    await query("UPDATE monitoring_configs SET status='FAILED', last_failure_at=NOW(), updated_at=NOW() WHERE id=$1 AND org_id=$2", [run.monitoring_id, orgId]);
    return;
  }
  const snapshot = await buildSnapshot(scanId, orgId);
  const previous = (await query<{ snapshot: Snapshot }>("SELECT snapshot FROM monitoring_baselines WHERE monitoring_id=$1 AND org_id=$2 AND status='VALID' ORDER BY created_at DESC LIMIT 1", [run.monitoring_id, orgId])).rows[0]?.snapshot ?? null;
  await query("INSERT INTO monitoring_baselines (monitoring_id, org_id, website_id, scan_id, status, snapshot) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (monitoring_id, scan_id) DO UPDATE SET snapshot=EXCLUDED.snapshot, status=EXCLUDED.status", [run.monitoring_id, orgId, run.website_id, scanId, "VALID", JSON.stringify(snapshot)]);
  for (const detected of compareSnapshots(previous, snapshot)) {
    const signature = changeSignature(detected);
    const inserted = await query<{ id: string }>("INSERT INTO monitoring_changes (monitoring_id, org_id, website_id, scan_id, baseline_scan_id, signature, change_type, domain, severity, affected_urls, before_value, after_value, evidence_ids, finding_ids, impact) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (org_id, monitoring_id, scan_id, signature) DO NOTHING RETURNING id", [run.monitoring_id, orgId, run.website_id, scanId, previous?.scanId ?? null, signature, detected.changeType, detected.domain, detected.severity, detected.affectedUrls, JSON.stringify(detected.before), JSON.stringify(detected.after), detected.evidenceIds, detected.findingIds, detected.impact]);
    if (detected.changeType === "FINDING_RESOLVED") await query("UPDATE alerts SET status='RESOLVED', resolved_at=NOW(), updated_at=NOW() WHERE monitoring_id=$1 AND org_id=$2 AND status IN ('OPEN','ACKNOWLEDGED') AND change_id IN (SELECT id FROM monitoring_changes WHERE monitoring_id=$1 AND org_id=$2 AND finding_ids && $3::uuid[])", [run.monitoring_id, orgId, detected.findingIds]);
    if (inserted.rows[0] && (detected.changeType === "FINDING_INTRODUCED" || severityRank[detected.severity] >= severityRank.medium)) await openAlert(run, inserted.rows[0].id, detected, orgId);
  }
  await query("UPDATE monitoring_runs SET status='COMPLETED', completed_at=NOW() WHERE id=$1 AND org_id=$2", [run.id, orgId]);
  await query("UPDATE monitoring_configs SET status='ACTIVE', last_success_at=NOW(), updated_at=NOW() WHERE id=$1 AND org_id=$2", [run.monitoring_id, orgId]);
}

async function openAlert(run: { monitoring_id: string; website_id: string }, changeId: string, detected: DetectedChange, orgId: string): Promise<void> {
  const alert = await query<{ id: string }>("INSERT INTO alerts (org_id, monitoring_id, website_id, change_id, scan_id, signature, severity, title) SELECT $1,$2,$3,$4,c.scan_id,$5,$6,$7 FROM monitoring_changes c WHERE c.id=$4 ON CONFLICT (org_id, monitoring_id, signature, status) DO NOTHING RETURNING id", [orgId, run.monitoring_id, run.website_id, changeId, changeSignature(detected), detected.severity, detected.changeType.replaceAll("_", " ")]);
  if (alert.rows[0]) await query("INSERT INTO notification_deliveries (org_id, alert_id, channel) VALUES ($1,$2,'internal') ON CONFLICT (alert_id, channel) DO NOTHING", [orgId, alert.rows[0].id]);
}

async function buildSnapshot(scanId: string, orgId: string): Promise<Snapshot> {
  const findings = (await query<{ id: string; category: string; module_name: string; severity: string; affected_urls: string[] }>("SELECT id, category, module_name, severity, affected_urls FROM findings WHERE scan_id=$1 AND org_id=$2", [scanId, orgId])).rows;
  const evidence = (await query<{ finding_id: string; evidence_ids: string[] }>("SELECT finding_id, array_agg(evidence_id) AS evidence_ids FROM finding_evidence WHERE org_id=$1 GROUP BY finding_id", [orgId])).rows;
  const evidenceMap = new Map(evidence.map((entry) => [entry.finding_id, entry.evidence_ids]));
  const scores = (await query<{ category: string; score: number | null }>("SELECT category, score FROM scan_scores WHERE scan_id=$1 AND org_id=$2", [scanId, orgId])).rows;
  const pages = (await query<{ resource_reference: string; metadata: Record<string, unknown> }>("SELECT resource_reference, metadata FROM evidence WHERE task_id=$1 AND org_id=$2 AND evidence_type='HTML_DOCUMENT'", [scanId, orgId])).rows.map((entry) => ({ url: entry.resource_reference, ...(entry.metadata?.redactedContent as Record<string, unknown> ?? {}) }));
  return { scanId, pages, findings: findings.map((finding) => ({ id: finding.id, key: `${finding.module_name}:${finding.category}:${finding.severity}:${finding.affected_urls.join(",")}`, domain: domainForCategory(finding.category || finding.module_name), severity: finding.severity, evidenceIds: evidenceMap.get(finding.id) ?? [] })), scores };
}

export async function listChanges(id: string, orgId: string): Promise<unknown[]> { return (await query("SELECT * FROM monitoring_changes WHERE monitoring_id=$1 AND org_id=$2 ORDER BY detected_at DESC", [id, orgId])).rows; }
export async function listAlerts(orgId: string, monitoringId?: string): Promise<unknown[]> { return (await query("SELECT * FROM alerts WHERE org_id=$1 AND ($2::uuid IS NULL OR monitoring_id=$2) ORDER BY detected_at DESC", [orgId, monitoringId ?? null])).rows; }
export async function updateAlert(id: string, orgId: string, actorId: string, status: "ACKNOWLEDGED" | "RESOLVED" | "DISMISSED"): Promise<boolean> { const result = await query("UPDATE alerts SET status=$3, acknowledged_at=CASE WHEN $3='ACKNOWLEDGED' THEN NOW() ELSE acknowledged_at END, resolved_at=CASE WHEN $3 IN ('RESOLVED','DISMISSED') THEN NOW() ELSE resolved_at END, updated_at=NOW() WHERE id=$1 AND org_id=$2 AND status IN ('OPEN','ACKNOWLEDGED') RETURNING id", [id, orgId, status]); if (result.rows[0]) await audit({ orgId, userId: actorId, action: `alert_${status.toLowerCase()}`, resourceType: "alert", resourceId: id, result: "success" }); return Boolean(result.rows[0]); }
