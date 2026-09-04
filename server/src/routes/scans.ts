import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { createScan, getScan, emitScanEvent } from "../services/scan.service.js";
import { getWebsite } from "../services/website.service.js";
import { query } from "../db/client.js";
import { audit } from "../services/audit.service.js";

const createScanSchema = z.object({
  websiteId: z.string().uuid(),
  modules: z.array(z.string()).optional(),
});

export async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [authenticate, requireOrgMember];

  // POST /api/v1/scans
  fastify.post("/", { preHandler: [authenticate, requireOrgMember, requireRole("owner", "admin", "member")] }, async (request, reply) => {
    const parsed = createScanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    const website = await getWebsite(parsed.data.websiteId, request.orgId);
    if (!website) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
    }

    if (!website.verified) {
      return reply.status(422).send({ error: { code: "NOT_VERIFIED", message: "Website ownership must be verified before scanning" } });
    }

    const scan = await createScan({
      websiteId: parsed.data.websiteId,
      orgId: request.orgId,
      triggeredBy: request.authUser.id,
      modules: parsed.data.modules,
    });

    await audit({
      userId: request.authUser.id, orgId: request.orgId,
      action: "scan_created", resourceType: "scan", resourceId: scan.id as unknown as string, result: "success",
    });

    return reply.status(201).send({ data: scan });
  });

  // GET /api/v1/scans/:id
  fastify.get("/:id", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }

    // Attach scores
    const { rows: scores } = await query(
      "SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 AND org_id = $2 ORDER BY category",
      [id, request.orgId]
    );

    return reply.send({ data: { ...scan, scores } });
  });

  fastify.get("/:id/status", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }
    return reply.send({ data: { id: scan.id, status: scan.status, intelligence_status: scan.intelligence_status, started_at: scan.started_at, completed_at: scan.completed_at, error: scan.error, intelligence_error: scan.intelligence_error } });
  });

  fastify.get("/:id/evidence", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }

    const { rows } = await query(
      `SELECT e.*, f.scan_id, f.module_name, f.category, f.severity
       FROM evidence e
       JOIN findings f ON f.id = e.finding_id
       WHERE f.scan_id = $1 AND f.org_id = $2
       ORDER BY e.collected_at DESC`,
      [id, request.orgId]
    );

    return reply.send({ data: rows });
  });

  fastify.get("/:id/report", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Report not found" } });
    }

    const { rows: scores } = await query(
      "SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 AND org_id = $2 ORDER BY category",
      [id, request.orgId]
    );
    const { rows: findings } = await query(
      `SELECT id, category, severity, title, description, recommendation, module_name, affected_urls, confidence, provenance, created_at
       FROM findings WHERE scan_id = $1 AND org_id = $2
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at`,
      [id, request.orgId]
    );
    const { rows: reports } = await query(
      "SELECT id, report_version, status, deterministic_score, summary, error, created_at, updated_at FROM reports WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 ORDER BY report_version DESC LIMIT 1",
      [id, request.orgId, scan.website_id]
    );

    return reply.send({ data: { scan, intelligenceStatus: scan.intelligence_status, scores, findings, report: reports[0] ?? null } });
  });

  fastify.get("/:id/quality", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }

    const { rows } = await query(
      "SELECT * FROM quality_assessments WHERE task_id = $1 AND org_id = $2 ORDER BY created_at DESC",
      [id, request.orgId]
    );

    return reply.send({ data: rows });
  });

  // GET /api/v1/scans/:id/findings
  fastify.get("/:id/findings", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // Org isolation: verify scan belongs to org
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }

    const { rows: findings } = await query(
      `SELECT f.*, json_agg(e.*) FILTER (WHERE e.id IS NOT NULL) AS evidence
       FROM findings f
      LEFT JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.org_id = f.org_id
      LEFT JOIN evidence e ON (e.id = fe.evidence_id OR e.finding_id = f.id) AND e.org_id = f.org_id
      WHERE f.scan_id = $1 AND f.org_id = $2
       GROUP BY f.id
       ORDER BY
         CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
         f.created_at`,
      [id, request.orgId]
    );

    return reply.send({ data: findings });
  });

  // POST /api/v1/scans/:id/cancel
  fastify.post("/:id/cancel", { preHandler: [authenticate, requireOrgMember, requireRole("owner", "admin", "member")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }
    if (!["queued", "running"].includes(scan.status)) {
      return reply.status(422).send({ error: { code: "INVALID_STATE", message: `Scan is ${scan.status} and cannot be cancelled` } });
    }

    await query("UPDATE scans SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [id]);
    await emitScanEvent(id, "scan_cancelled", { scanId: id });

    return reply.send({ data: { ok: true } });
  });

  // GET /api/v1/scans/:id/events — SSE endpoint
  fastify.get("/:id/events", { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const scan = await getScan(id, request.orgId);
    if (!scan) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    let lastId = 0;
    let done = false;

    const write = (type: string, data: unknown, id?: number) => {
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${type}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send any existing events first
    const { rows: existing } = await query(
      "SELECT id, type, payload FROM scan_events WHERE scan_id = $1 ORDER BY id ASC",
      [id]
    );
    for (const ev of existing) {
      write(ev.type, ev.payload, ev.id);
      lastId = ev.id;
    }

    if (["completed", "failed", "partial", "cancelled"].includes(scan.status)) {
      write("done", { status: scan.status });
      reply.raw.end();
      return;
    }

    const poll = setInterval(async () => {
      if (done) return;
      try {
        const { rows: newEvents } = await query(
          "SELECT id, type, payload FROM scan_events WHERE scan_id = $1 AND id > $2 ORDER BY id ASC",
          [id, lastId]
        );
        for (const ev of newEvents) {
          write(ev.type, ev.payload, ev.id);
          lastId = ev.id;
          if (ev.type === "scan_completed" || ev.type === "scan_failed") {
            done = true;
          }
        }

        if (done) {
          const finalScan = await getScan(id, request.orgId);
          write("done", { status: finalScan?.status ?? "unknown" });
          reply.raw.end();
          clearInterval(poll);
        }
      } catch {
        // DB error during SSE — keep connection open
      }
    }, 500);

    request.raw.on("close", () => {
      done = true;
      clearInterval(poll);
    });
  });
}
