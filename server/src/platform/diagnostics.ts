import { config } from "../config.js";
import { query } from "../db/client.js";
import { getMigrationStatus } from "../services/infrastructure.js";
import { getWorkerHeartbeat } from "../services/scan.service.js";
import { requestSync } from "../services/search-console.service.js";
import { recentServerErrors } from "./error-log.js";
import { AdminError, listIntegrations } from "./integrations.js";

/**
 * Admin diagnostics: every value is measured from this process or the
 * database at request time; anything that cannot be established is reported
 * as unknown, never assumed healthy. No SQL console, no shell, no fetch.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/(postgres(?:ql)?|clickhouse|https?):\/\/[^\s:@/]+:[^\s@/]+@/gi, "$1://[REDACTED]@"],
  [/([?&](?:token|code|state|key|secret|password|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[REDACTED_TOKEN]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

/** Removes credentials, tokens and email addresses from free text, and bounds its length. */
export function redact(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number; error: string }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Math.round(performance.now() - start) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - start), error: (err as Error).name };
  }
}

const RECENT = "interval '7 days'";

async function jobSummary() {
  const [scans, stuck, gsc, monitoring, notifications, outbox] = await Promise.all([
    query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM scans WHERE created_at > NOW() - ${RECENT} GROUP BY status`),
    query<{ n: number }>("SELECT COUNT(*)::int AS n FROM scans WHERE status = 'running' AND execution_lease_until < NOW()"),
    query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM gsc_sync_jobs WHERE created_at > NOW() - ${RECENT} GROUP BY status`),
    query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM monitoring_runs WHERE created_at > NOW() - ${RECENT} GROUP BY status`),
    query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM notification_deliveries WHERE created_at > NOW() - ${RECENT} GROUP BY status`),
    query<{ status: string; n: number; oldest: Date | null }>("SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest FROM analytics_outbox WHERE status <> 'DISPATCHED' GROUP BY status"),
  ]);
  const counts = (rows: Array<{ status: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    window: "7 days",
    scans: { ...counts(scans.rows), stuckWithExpiredLease: stuck.rows[0].n },
    searchConsoleSyncs: counts(gsc.rows),
    monitoringRuns: counts(monitoring.rows),
    notificationDeliveries: counts(notifications.rows),
    analyticsOutbox: { ...counts(outbox.rows), oldestUndispatched: outbox.rows.find((r) => r.status === "PENDING")?.oldest?.toISOString() ?? null },
  };
}

export interface FailedJob {
  kind: "scan" | "gsc_sync" | "monitoring_run" | "notification" | "analytics_outbox";
  id: string;
  orgId: string | null;
  at: string;
  error: string | null;
  retryable: boolean;
  retryNote: string;
}

async function recentFailures(limit = 25): Promise<FailedJob[]> {
  const [scans, gsc, monitoring, outbox] = await Promise.all([
    query<{ id: string; org_id: string; at: Date; error: string | null }>(`SELECT id, org_id, COALESCE(completed_at, created_at) AS at, error FROM scans WHERE status = 'failed' AND created_at > NOW() - ${RECENT} ORDER BY created_at DESC LIMIT $1`, [limit]),
    query<{ id: string; org_id: string; at: Date; error: string | null; error_code: string | null }>(`SELECT id, org_id, COALESCE(finished_at, created_at) AS at, error, error_code FROM gsc_sync_jobs WHERE status = 'failed' AND created_at > NOW() - ${RECENT} ORDER BY created_at DESC LIMIT $1`, [limit]),
    query<{ id: string; org_id: string; at: Date; error: string | null }>(`SELECT id, org_id, COALESCE(completed_at, created_at) AS at, error FROM monitoring_runs WHERE status = 'FAILED' AND created_at > NOW() - ${RECENT} ORDER BY created_at DESC LIMIT $1`, [limit]),
    query<{ id: string; org_id: string; at: Date; error: string | null }>("SELECT id::text, org_id, created_at AS at, last_error AS error FROM analytics_outbox WHERE status = 'DEAD' ORDER BY created_at DESC LIMIT $1", [limit]),
  ]);
  const out: FailedJob[] = [
    ...scans.rows.map((r) => ({ kind: "scan" as const, id: r.id, orgId: r.org_id, at: r.at.toISOString(), error: redact(r.error), retryable: false, retryNote: "Start a new scan from the website page; retrying here could duplicate a scan." })),
    ...gsc.rows.map((r) => ({ kind: "gsc_sync" as const, id: r.id, orgId: r.org_id, at: r.at.toISOString(), error: redact(r.error_code ? `${r.error_code}: ${r.error ?? ""}` : r.error), retryable: true, retryNote: "Queues a new sync for the same date range (at most one active sync per property)." })),
    ...monitoring.rows.map((r) => ({ kind: "monitoring_run" as const, id: r.id, orgId: r.org_id, at: r.at.toISOString(), error: redact(r.error), retryable: false, retryNote: "The schedule runs again automatically; use Monitoring → Run now for an immediate run." })),
    ...outbox.rows.map((r) => ({ kind: "analytics_outbox" as const, id: r.id, orgId: r.org_id, at: r.at.toISOString(), error: redact(r.error), retryable: true, retryNote: "Returns the event to the dispatch queue; ClickHouse rows are keyed by event id." })),
  ];
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Missing or risky configuration, by name only. */
export function configurationWarnings(): Array<{ severity: "warning" | "info"; message: string }> {
  const w: Array<{ severity: "warning" | "info"; message: string }> = [];
  if (!config.PLATFORM_ADMIN_USER_IDS.length) w.push({ severity: "warning", message: "PLATFORM_ADMIN_USER_IDS is empty: nobody can use platform administration." });
  if (!process.env.INTEGRATION_ENCRYPTION_KEYS) w.push({ severity: "warning", message: "INTEGRATION_ENCRYPTION_KEYS is not set: provider credentials and Google connections cannot be stored." });
  if (config.NODE_ENV === "production" && !config.TRUST_PROXY) w.push({ severity: "warning", message: "TRUST_PROXY is off in production: rate limits key on the proxy address and HTTPS cannot be detected." });
  if (!config.APP_PUBLIC_URL) w.push({ severity: "info", message: "APP_PUBLIC_URL is not set; the first CORS_ORIGIN is used for links." });
  w.push({ severity: "info", message: "No email provider is integrated: password-reset links and alert emails are not delivered." });
  if (config.AI_ALLOW_PAID_MODELS) w.push({ severity: "warning", message: "AI_ALLOW_PAID_MODELS is on: AI calls may incur provider charges." });
  return w;
}

export async function getDiagnostics() {
  const [db, migrations, jobs, failures, integrations, adminEvents] = await Promise.all([
    timed(() => query("SELECT 1")),
    timed(() => getMigrationStatus()),
    timed(jobSummary),
    timed(() => recentFailures()),
    timed(listIntegrations),
    timed(() =>
      query<{ timestamp: Date; action: string; result: string; user_id: string | null; resource_type: string | null; request_id: string | null }>(
        `SELECT timestamp, action, result, user_id, resource_type, request_id FROM audit_log
          WHERE action LIKE 'admin\\_%' OR action LIKE 'platform\\_%' OR action IN ('integration_connected','integration_disconnected','catalog_refresh','model_enabled','model_disabled')
          ORDER BY timestamp DESC LIMIT 25`,
      ),
    ),
  ]);
  const heartbeat = getWorkerHeartbeat();
  const tickAgeMs = heartbeat.lastTickAt ? Date.now() - heartbeat.lastTickAt.getTime() : null;
  return {
    generatedAt: new Date().toISOString(),
    process: { uptimeSeconds: Math.round(process.uptime()), node: process.version, environment: config.NODE_ENV, memoryRssMb: Math.round(process.memoryUsage().rss / 1_048_576) },
    database: db.ok ? { status: "ok", latencyMs: db.ms } : { status: "failed", latencyMs: db.ms, error: db.error },
    migrations: migrations.ok ? migrations.value : { status: "unavailable", error: migrations.error },
    worker: {
      // Heartbeat of THIS process only; other instances are not visible here.
      running: heartbeat.running,
      startedAt: heartbeat.startedAt?.toISOString() ?? null,
      lastTickAt: heartbeat.lastTickAt?.toISOString() ?? null,
      status: !heartbeat.running ? "not_running_in_this_process" : tickAgeMs !== null && tickAgeMs > Math.max(60_000, heartbeat.intervalMs * 10) ? "stalled" : heartbeat.lastTickAt ? "ok" : "starting",
      lastError: heartbeat.lastTickError ? { errorClass: heartbeat.lastTickError, at: heartbeat.lastTickErrorAt?.toISOString() ?? null } : null,
    },
    jobs: jobs.ok ? jobs.value : { status: "unavailable", error: jobs.error },
    failedJobs: failures.ok ? failures.value : [],
    integrations: integrations.ok
      ? integrations.value.map((i) => ({ id: i.id, name: i.name, management: i.management, configured: i.configured, featureEnabled: i.featureEnabled, lastCheck: i.lastCheck, lastSuccessAt: i.lastSuccessAt }))
      : [],
    serverErrors: recentServerErrors(),
    configurationWarnings: configurationWarnings(),
    adminEvents: adminEvents.ok ? adminEvents.value.rows : [],
  };
}

/** A copy safe to attach to a support ticket: no org/user ids, no free text that was not redacted. */
export async function exportDiagnostics() {
  const d = await getDiagnostics();
  return {
    ...d,
    failedJobs: d.failedJobs.map((j) => ({ kind: j.kind, at: j.at, error: redact(j.error) })),
    adminEvents: d.adminEvents.map((e) => ({ timestamp: e.timestamp, action: e.action, result: e.result, requestId: e.request_id })),
    note: "Redacted export: identifiers of organizations and users, secrets, tokens and email addresses are removed.",
  };
}

/** Retries a failed job only where retrying cannot duplicate work. */
export async function retryJob(kind: string, id: string, actorId: string): Promise<{ kind: string; result: Record<string, unknown> }> {
  if (kind === "analytics_outbox") {
    if (!/^\d{1,18}$/.test(id)) throw new AdminError(400, "VALIDATION_ERROR", "Invalid event id.");
    const { rowCount } = await query("UPDATE analytics_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(), last_error = NULL WHERE id = $1 AND status = 'DEAD'", [id]);
    if (!rowCount) throw new AdminError(409, "NOT_RETRYABLE", "This event is not dead-lettered (it may already have been retried).");
    return { kind, result: { requeued: true } };
  }
  if (kind === "gsc_sync") {
    const { rows } = await query<{ org_id: string; website_id: string; date_from: string; date_to: string }>(
      `SELECT j.org_id, p.website_id, to_char(j.date_from, 'YYYY-MM-DD') AS date_from, to_char(j.date_to, 'YYYY-MM-DD') AS date_to
         FROM gsc_sync_jobs j JOIN gsc_properties p ON p.id = j.property_id AND p.org_id = j.org_id
        WHERE j.id = $1 AND j.status = 'failed'`,
      [id],
    );
    if (!rows[0]) throw new AdminError(409, "NOT_RETRYABLE", "No failed Search Console sync with this id.");
    try {
      const r = await requestSync({ orgId: rows[0].org_id, websiteId: rows[0].website_id, actorId, kind: "manual", from: rows[0].date_from, to: rows[0].date_to });
      return { kind, result: { jobId: r.job.id, deduplicated: r.deduplicated } };
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e.statusCode && e.statusCode < 500) throw new AdminError(409, e.code ?? "NOT_RETRYABLE", e.message ?? "The sync cannot be retried.");
      throw err;
    }
  }
  throw new AdminError(400, "NOT_RETRYABLE", "Only Search Console syncs and dead-lettered analytics events can be retried here.");
}
