import type { FastifyInstance } from "fastify";
import { authenticate, requireOrgMember } from "../middleware/auth.js";
import { query } from "../db/client.js";

export async function reportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/:scanId", { preHandler: [authenticate, requireOrgMember] }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const { rows: scans } = await query<{
      id: string; website_id: string; domain: string; url: string; status: string;
      started_at: string | null; completed_at: string | null; created_at: string;
    }>(
      `SELECT s.id, s.website_id, w.domain, w.url, s.status, s.started_at, s.completed_at, s.created_at
       FROM scans s JOIN websites w ON w.id = s.website_id
       WHERE s.id = $1 AND s.org_id = $2 AND w.org_id = $2`,
      [scanId, request.orgId],
    );

    const scan = scans[0];
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Report not found" } });
    }

    const [scores, findings] = await Promise.all([
      query("SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 ORDER BY category", [scanId]),
      query(
        `SELECT id, category, severity, title, description, recommendation, module_name, affected_urls, confidence, provenance, created_at
         FROM findings WHERE scan_id = $1 AND org_id = $2
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at`,
        [scanId, request.orgId],
      ),
    ]);

    return reply.send({ data: { scan, scores: scores.rows, findings: findings.rows } });
  });
}
