// Analytics (tenant-scoped, read-only).
//
// organization_id is NEVER read from the request body or query string: it is
// the org that requireOrgMember verified for this user (x-org-id header, then
// a membership lookup). Every SQL statement below filters on that value.
//
// Aggregates are computed from PostgreSQL, the transactional source of truth,
// so analytics keep working when ClickHouse is not configured or is down.
// Values the platform does not record are returned as null (the UI shows
// "Not available yet") rather than estimated.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember } from "../middleware/auth.js";
import { query } from "../db/client.js";

const filtersSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  provider: z.string().max(100).optional(),
  model: z.string().max(300).optional(),
  agent: z.string().max(100).optional(),
  websiteId: z.string().uuid().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  module: z.string().max(100).optional(),
});
type Filters = z.infer<typeof filtersSchema>;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Builds "AND col = $n" fragments for optional filters. */
function where(base: unknown[], parts: [string, unknown | undefined][]) {
  const values = [...base];
  let sql = "";
  for (const [col, v] of parts) {
    if (v === undefined || v === "") continue;
    values.push(v);
    sql += ` AND ${col} = $${values.length}`;
  }
  return { sql, values };
}

/**
 * Cost is derived only from data the backend holds. The model registry records
 * whether a model is FREE; it stores no per-token prices. So cost is exactly 0
 * when every execution in the set used a FREE model, otherwise unknown (null).
 */
function costFrom(paidOrUnknownExecutions: number): number | null {
  return paidOrUnknownExecutions === 0 ? 0 : null;
}

export async function getAiAnalytics(orgId: string, f: Filters) {
  const w = where([orgId, f.days], [["ae.provider", f.provider], ["ae.model_id", f.model], ["ae.agent_type", f.agent]]);
  const scope = `FROM agent_executions ae LEFT JOIN models m ON m.openrouter_id = ae.model_id
    WHERE ae.org_id = $1 AND ae.created_at >= NOW() - make_interval(days => $2::int)${w.sql}`;
  const agg = `COUNT(*)::int AS executions,
    COUNT(*) FILTER (WHERE ae.status = 'failed')::int AS failed,
    COUNT(*) FILTER (WHERE ae.status = 'completed')::int AS completed,
    COALESCE(SUM(ae.prompt_tokens),0)::bigint AS prompt_tokens,
    COALESCE(SUM(ae.completion_tokens),0)::bigint AS completion_tokens,
    ROUND(AVG(ae.latency_ms))::int AS avg_latency_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ae.latency_ms) AS p95_latency_ms,
    COUNT(*) FILTER (WHERE m.free_status IS DISTINCT FROM 'FREE')::int AS non_free`;
  type AggRow = Record<string, unknown>;
  const shape = (r: AggRow) => {
    const executions = num(r.executions);
    return {
      executions,
      completed: num(r.completed),
      failed: num(r.failed),
      failureRate: executions ? num(r.failed) / executions : null,
      promptTokens: num(r.prompt_tokens),
      completionTokens: num(r.completion_tokens),
      totalTokens: num(r.prompt_tokens) + num(r.completion_tokens),
      avgLatencyMs: numOrNull(r.avg_latency_ms),
      p95LatencyMs: r.p95_latency_ms == null ? null : Math.round(Number(r.p95_latency_ms)),
      costUsd: executions ? costFrom(num(r.non_free)) : null,
    };
  };
  const by = async (expr: string) =>
    (await query(`SELECT COALESCE(${expr}::text, 'unknown') AS key, ${agg} ${scope} GROUP BY 1 ORDER BY executions DESC LIMIT 25`, w.values)).rows.map(
      (r) => ({ key: String(r.key), ...shape(r) }),
    );

  const [totals, daily, providers, models, agents] = await Promise.all([
    query(`SELECT ${agg} ${scope}`, w.values),
    query(`SELECT to_char(date_trunc('day', ae.created_at), 'YYYY-MM-DD') AS key, ${agg} ${scope} GROUP BY 1 ORDER BY 1`, w.values),
    by("ae.provider"),
    by("ae.model_id"),
    by("ae.agent_type"),
  ]);
  return {
    source: "postgres",
    totals: shape(totals.rows[0] ?? {}),
    daily: daily.rows.map((r) => ({ date: String(r.key), ...shape(r) })),
    byProvider: providers,
    byModel: models,
    byAgent: agents,
    pricingNote: "Per-token prices are not recorded. Cost is shown only when every execution used a FREE model.",
  };
}

export async function getRoutingAnalytics(orgId: string, f: Filters) {
  const values = [orgId, f.days];
  const scope = `FROM routing_decisions rd WHERE rd.org_id = $1 AND rd.created_at >= NOW() - make_interval(days => $2::int)`;
  const [totals, models] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS decisions,
        COUNT(*) FILTER (WHERE rd.status = 'RESOLVED')::int AS resolved,
        COUNT(*) FILTER (WHERE rd.decision_source = 'FALLBACK')::int AS fallbacks,
        ROUND(AVG(rd.decision_duration_ms))::int AS avg_decision_ms ${scope}`,
      values,
    ),
    query(
      `SELECT COALESCE(rd.selected_openrouter_id, 'none') AS model,
        COUNT(*)::int AS decisions,
        COUNT(*) FILTER (WHERE rd.decision_source = 'FALLBACK')::int AS fallbacks
       ${scope} GROUP BY 1 ORDER BY decisions DESC LIMIT 25`,
      values,
    ),
  ]);
  // Join execution outcomes per selected model (same org, same window).
  const exec = await query(
    `SELECT ae.model_id AS model, COUNT(*)::int AS executions,
       COUNT(*) FILTER (WHERE ae.status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE ae.attempt_number > 1)::int AS retries,
       ROUND(AVG(ae.latency_ms))::int AS avg_latency_ms,
       COALESCE(SUM(COALESCE(ae.prompt_tokens,0) + COALESCE(ae.completion_tokens,0)),0)::bigint AS tokens,
       COUNT(*) FILTER (WHERE m.free_status IS DISTINCT FROM 'FREE')::int AS non_free
     FROM agent_executions ae LEFT JOIN models m ON m.openrouter_id = ae.model_id
     WHERE ae.org_id = $1 AND ae.created_at >= NOW() - make_interval(days => $2::int) AND ae.model_id IS NOT NULL
     GROUP BY 1`,
    values,
  );
  const execBy = new Map(exec.rows.map((r) => [String(r.model), r]));
  const t = totals.rows[0] ?? {};
  const decisions = num(t.decisions);
  return {
    source: "postgres",
    totals: {
      decisions,
      resolved: num(t.resolved),
      fallbacks: num(t.fallbacks),
      fallbackRate: decisions ? num(t.fallbacks) / decisions : null,
      avgDecisionMs: numOrNull(t.avg_decision_ms),
    },
    models: models.rows.map((r) => {
      const e = execBy.get(String(r.model));
      const executions = num(e?.executions);
      return {
        model: String(r.model),
        decisions: num(r.decisions),
        fallbacks: num(r.fallbacks),
        executions,
        successRate: executions ? num(e?.completed) / executions : null,
        avgLatencyMs: numOrNull(e?.avg_latency_ms),
        tokens: num(e?.tokens),
        costUsd: executions ? costFrom(num(e?.non_free)) : null,
      };
    }),
  };
}

export async function getScanAnalytics(orgId: string, f: Filters) {
  const sw = where([orgId], [["s.website_id", f.websiteId]]);
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE s.created_at >= date_trunc('day', NOW()))::int AS today,
       COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '7 days')::int AS week,
       COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '30 days')::int AS month,
       COUNT(*) FILTER (WHERE s.status = 'failed' AND s.created_at >= NOW() - INTERVAL '30 days')::int AS failed_month
     FROM scans s WHERE s.org_id = $1${sw.sql}`,
    sw.values,
  );
  const dw = where([orgId, f.days], [["s.website_id", f.websiteId]]);
  const daily = await query(
    `SELECT to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') AS date,
       COUNT(*)::int AS scans, COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed
     FROM scans s WHERE s.org_id = $1 AND s.created_at >= NOW() - make_interval(days => $2::int)${dw.sql}
     GROUP BY 1 ORDER BY 1`,
    dw.values,
  );
  const fw = where([orgId, f.days], [["f.website_id", f.websiteId], ["f.severity", f.severity], ["f.module_name", f.module]]);
  const fScope = `FROM findings f JOIN websites w ON w.id = f.website_id AND w.org_id = f.org_id
    WHERE f.org_id = $1 AND f.created_at >= NOW() - make_interval(days => $2::int)${fw.sql}`;
  const group = async (expr: string, extra = "") =>
    (await query(`SELECT ${expr} AS key${extra}, COUNT(*)::int AS count ${fScope} GROUP BY 1${extra ? ", 2" : ""} ORDER BY count DESC LIMIT 20`, fw.values)).rows;
  const [severity, category, module, website] = await Promise.all([
    group("f.severity"),
    group("f.category"),
    group("f.module_name"),
    group("f.website_id::text", ", w.url AS label"),
  ]);
  const c = counts.rows[0] ?? {};
  return {
    source: "postgres",
    counts: { today: num(c.today), week: num(c.week), month: num(c.month), failedMonth: num(c.failed_month) },
    daily: daily.rows.map((r) => ({ date: String(r.date), scans: num(r.scans), failed: num(r.failed) })),
    findingsBySeverity: severity.map((r) => ({ key: String(r.key), count: num(r.count) })),
    findingsByCategory: category.map((r) => ({ key: String(r.key), count: num(r.count) })),
    findingsByModule: module.map((r) => ({ key: String(r.key), count: num(r.count) })),
    findingsByWebsite: website.map((r) => ({ key: String(r.key), label: String(r.label), count: num(r.count) })),
  };
}

export async function getMonitoringAnalytics(orgId: string, f: Filters) {
  const w = where([orgId, f.days], [["mr.website_id", f.websiteId]]);
  const runs = await query(
    `SELECT COUNT(*)::int AS runs,
       COUNT(*) FILTER (WHERE mr.status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE mr.status = 'FAILED')::int AS failed
     FROM monitoring_runs mr WHERE mr.org_id = $1 AND mr.created_at >= NOW() - make_interval(days => $2::int)${w.sql}`,
    w.values,
  );
  const daily = await query(
    `SELECT to_char(date_trunc('day', mr.created_at), 'YYYY-MM-DD') AS date,
       COUNT(*) FILTER (WHERE mr.status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE mr.status = 'FAILED')::int AS failed
     FROM monitoring_runs mr WHERE mr.org_id = $1 AND mr.created_at >= NOW() - make_interval(days => $2::int)${w.sql}
     GROUP BY 1 ORDER BY 1`,
    w.values,
  );
  const sw = where([orgId, f.days], [["ms.website_id", f.websiteId]]);
  const ssl = await query(
    `SELECT ROUND(AVG(ms.ssl_score))::int AS avg_ssl, COUNT(ms.ssl_score)::int AS samples
     FROM monitoring_snapshots ms WHERE ms.org_id = $1 AND ms.captured_at >= NOW() - make_interval(days => $2::int)${sw.sql}`,
    sw.values,
  );
  const aw = where([orgId, f.days], [["a.website_id", f.websiteId]]);
  const incidents = await query(
    `SELECT a.severity AS key, COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE a.status IN ('OPEN','ACKNOWLEDGED'))::int AS open
     FROM alerts a WHERE a.org_id = $1 AND a.detected_at >= NOW() - make_interval(days => $2::int)${aw.sql}
     GROUP BY 1 ORDER BY count DESC`,
    aw.values,
  );
  const r = runs.rows[0] ?? {};
  const finished = num(r.completed) + num(r.failed);
  return {
    source: "postgres",
    runs: num(r.runs),
    completed: num(r.completed),
    failed: num(r.failed),
    availability: finished ? num(r.completed) / finished : null,
    failureRate: finished ? num(r.failed) / finished : null,
    sslScore: num(ssl.rows[0]?.samples) ? numOrNull(ssl.rows[0]?.avg_ssl) : null,
    // Not measured by the current monitoring engine; reported honestly.
    responseTimeMs: null,
    dnsHealth: null,
    httpHealth: null,
    daily: daily.rows.map((d) => ({ date: String(d.date), completed: num(d.completed), failed: num(d.failed) })),
    incidentsBySeverity: incidents.rows.map((i) => ({ key: String(i.key), count: num(i.count), open: num(i.open) })),
    openIncidents: incidents.rows.reduce((s, i) => s + num(i.open), 0),
  };
}

export async function analyticsRoutes(fastify: FastifyInstance) {
  const preHandler = [authenticate, requireOrgMember];
  const handle = (fn: (orgId: string, f: Filters) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = filtersSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid analytics filters" } });
    return { data: await fn(request.orgId!, parsed.data) };
  };

  fastify.get("/overview", { preHandler }, handle(async (orgId, f) => {
    const [ai, scans, monitoring] = await Promise.all([getAiAnalytics(orgId, { days: f.days }), getScanAnalytics(orgId, { days: f.days }), getMonitoringAnalytics(orgId, { days: f.days })]);
    return {
      source: "postgres",
      days: f.days,
      scans: scans.counts,
      scanDaily: scans.daily,
      findingsBySeverity: scans.findingsBySeverity,
      ai: ai.totals,
      aiDaily: ai.daily.map((d) => ({ date: d.date, executions: d.executions, failed: d.failed, totalTokens: d.totalTokens })),
      monitoring: { availability: monitoring.availability, runs: monitoring.runs, openIncidents: monitoring.openIncidents },
    };
  }));
  fastify.get("/ai", { preHandler }, handle(getAiAnalytics));
  fastify.get("/routing", { preHandler }, handle(getRoutingAnalytics));
  fastify.get("/scans", { preHandler }, handle(getScanAnalytics));
  fastify.get("/monitoring", { preHandler }, handle(getMonitoringAnalytics));
}
