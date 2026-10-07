import type { FastifyInstance } from "fastify";
import { authenticate, requireOrgMember } from "../middleware/auth.js";
import { query } from "../db/client.js";

/**
 * Tenant-scoped overview projection.  Values are derived exclusively from
 * persisted scans, findings, score rows, monitoring snapshots, and agent runs.
 */
export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/", { preHandler: [authenticate, requireOrgMember] }, async (request, reply) => {
    const orgId = request.orgId;
    const websiteId = (request.query as { websiteId?: string }).websiteId ?? "";
    const { rows: websites } = await query(
      `SELECT w.id, w.url, w.domain, w.verified, w.created_at,
              s.id AS latest_scan_id, s.status AS latest_scan_status, s.started_at, s.completed_at,
              COALESCE((SELECT ss.score FROM scan_scores ss WHERE ss.scan_id = s.id AND ss.org_id = $1 AND ss.category = 'overall'), NULL) AS overall_score,
              COALESCE((SELECT COUNT(*)::int FROM findings f WHERE f.scan_id = s.id AND f.org_id = $1), 0) AS finding_count,
              COALESCE((SELECT COUNT(*)::int FROM findings f WHERE f.scan_id = s.id AND f.org_id = $1 AND f.severity = 'critical'), 0) AS critical_count
       FROM websites w
       LEFT JOIN LATERAL (
         SELECT * FROM scans WHERE website_id = w.id AND org_id = $1 ORDER BY created_at DESC LIMIT 1
       ) s ON TRUE
       WHERE w.org_id = $1 AND w.active = TRUE
       ORDER BY CASE WHEN w.id::text = $2 THEN 0 ELSE 1 END, w.created_at DESC`,
      [orgId, websiteId],
    );
    const selected = websites[0] ?? null;
    const scanId = selected?.latest_scan_id as string | undefined;
    const selectedWebsiteId = selected?.id as string | undefined;
    const [scores, findings, history, executions] = await Promise.all([
      scanId ? query("SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 AND org_id = $2", [scanId, orgId]) : Promise.resolve({ rows: [] }),
      scanId ? query(`SELECT id, category, severity, title, description, recommendation, module_name, created_at FROM findings WHERE scan_id = $1 AND org_id = $2 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at LIMIT 8`, [scanId, orgId]) : Promise.resolve({ rows: [] }),
      selectedWebsiteId ? query("SELECT captured_at, overall_score, seo_score, security_score, performance_score, accessibility_score, ssl_score FROM monitoring_snapshots WHERE website_id = $1 AND org_id = $2 ORDER BY captured_at ASC", [selectedWebsiteId, orgId]) : Promise.resolve({ rows: [] }),
      query("SELECT id, agent_type, model_id, status, started_at, completed_at, error, created_at FROM agent_executions WHERE org_id = $1 ORDER BY created_at DESC LIMIT 8", [orgId]),
    ]);
    return reply.send({ data: { websites, selectedWebsite: selected, scores: scores.rows, findings: findings.rows, history: history.rows, executions: executions.rows } });
  });
}
