import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import type { OutgoingHttpHeaders } from "node:http"
import { z } from "zod"
import {
  authenticate,
  requireOrgMember,
  requireRole,
} from "../middleware/auth.js"
import { createScan, getScan, emitScanEvent, ScanAdmissionError, SCAN_MODULE_NAMES } from "../services/scan.service.js"
import { getWebsite } from "../services/website.service.js"
import { query } from "../db/client.js"
import { audit } from "../services/audit.service.js"
import { config } from "../config.js"

const createScanSchema = z.object({
  websiteId: z.string().uuid(),
  modules: z
    .array(z.enum(SCAN_MODULE_NAMES))
    .min(1)
    .max(8)
    .transform((modules) => [...new Set(modules)])
    .optional(),
})

const idParam = z.object({ id: z.string().uuid() })

/** Rejects non-UUID :id params with 400 instead of a Postgres 22P02 (500). */
async function validateIdParam(request: FastifyRequest, reply: FastifyReply) {
  if (!idParam.safeParse(request.params).success) {
    return reply
      .status(400)
      .send({ error: { code: "VALIDATION_ERROR", message: "Invalid scan id" } })
  }
}

// ─── SSE stream registry ─────────────────────────────────────────────────────

export const SSE_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "scan_completed",
  "scan_failed",
  "scan_cancelled",
])
export const SSE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "partial",
  "cancelled",
])

interface StreamEntry {
  userId: string
  orgId: string
  end: () => void
}
const openStreams = new Set<StreamEntry>()
let streamsClosing = false

export function openScanStreamCount(): number {
  return openStreams.size
}

/** Ends every open SSE stream and refuses new ones (graceful shutdown). */
export function closeAllScanStreams(): number {
  streamsClosing = true
  const entries = [...openStreams]
  for (const entry of entries) entry.end()
  openStreams.clear()
  return entries.length
}

/** Test hook: re-enable stream admission after closeAllScanStreams(). */
export function resetScanStreamsForTests(): void {
  streamsClosing = false
  openStreams.clear()
}

function streamLimitFor(userId: string, orgId: string): string | null {
  if (streamsClosing) return "Server is shutting down"
  const perUser = config.SSE_MAX_STREAMS_PER_USER ?? 3
  const perOrg = config.SSE_MAX_STREAMS_PER_ORG ?? 10
  const global = config.SSE_MAX_STREAMS_GLOBAL ?? 40
  let user = 0
  let org = 0
  for (const e of openStreams) {
    if (e.userId === userId) user++
    if (e.orgId === orgId) org++
  }
  if (user >= perUser) return "Too many concurrent event streams for this user"
  if (org >= perOrg) return "Too many concurrent event streams for this organization"
  if (openStreams.size >= global) return "Server event stream capacity reached"
  return null
}

// onSend hooks do not run for hijacked replies, so mirror the app's security headers.
const SSE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
}

export async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [authenticate, requireOrgMember, validateIdParam]

  // POST /api/v1/scans
  fastify.post(
    "/",
    {
      preHandler: [
        authenticate,
        requireOrgMember,
        requireRole("owner", "admin", "member"),
      ],
    },
    async (request, reply) => {
      const parsed = createScanSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .status(400)
          .send({
            error: { code: "VALIDATION_ERROR", message: parsed.error.message },
          })
      }

      const website = await getWebsite(parsed.data.websiteId, request.orgId)
      if (!website) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Website not found" } })
      }

      if (!website.verified) {
        return reply
          .status(422)
          .send({
            error: {
              code: "NOT_VERIFIED",
              message: "Website ownership must be verified before scanning",
            },
          })
      }

      let scan
      try {
        scan = await createScan({
          websiteId: parsed.data.websiteId,
          orgId: request.orgId,
          triggeredBy: request.authUser.id,
          modules: parsed.data.modules,
        })
      } catch (error) {
        if (error instanceof ScanAdmissionError) {
          return reply.status(429).header("Retry-After", "60").send({ error: { code: "SCAN_LIMIT_REACHED", message: error.message } })
        }
        throw error
      }

      await audit({
        userId: request.authUser.id,
        orgId: request.orgId,
        action: "scan_created",
        resourceType: "scan",
        resourceId: scan.id as unknown as string,
        result: "success",
      })

      return reply.status(201).send({ data: scan })
    },
  )

  // GET /api/v1/scans/:id
  fastify.get("/:id", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
    }

    // Attach scores
    const { rows: scores } = await query(
      "SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 AND org_id = $2 ORDER BY category",
      [id, request.orgId],
    )

    return reply.send({ data: { ...scan, scores } })
  })

  fastify.get("/:id/status", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
    }
    return reply.send({
      data: {
        id: scan.id,
        status: scan.status,
        intelligence_status: scan.intelligence_status,
        started_at: scan.started_at,
        completed_at: scan.completed_at,
        error: scan.error,
        intelligence_error: scan.intelligence_error,
      },
    })
  })

  fastify.get("/:id/evidence", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
    }

    const { rows } = await query(
      `SELECT e.*, f.scan_id, f.module_name, f.category, f.severity
       FROM evidence e
       JOIN findings f ON f.id = e.finding_id
       WHERE f.scan_id = $1 AND f.org_id = $2
       ORDER BY e.collected_at DESC`,
      [id, request.orgId],
    )

    return reply.send({ data: rows })
  })

  fastify.get("/:id/report", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Report not found" } })
    }

    const { rows: scores } = await query(
      "SELECT category, score, status, finding_count, critical_count FROM scan_scores WHERE scan_id = $1 AND org_id = $2 ORDER BY category",
      [id, request.orgId],
    )
    const { rows: findings } = await query(
      `SELECT id, category, severity, title, description, recommendation, module_name, affected_urls, confidence, provenance, created_at
       FROM findings WHERE scan_id = $1 AND org_id = $2
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at`,
      [id, request.orgId],
    )
    const { rows: reports } = await query(
      "SELECT id, report_version, status, deterministic_score, summary, error, created_at, updated_at FROM reports WHERE scan_id = $1 AND org_id = $2 AND website_id = $3 ORDER BY report_version DESC LIMIT 1",
      [id, request.orgId, scan.website_id],
    )

    return reply.send({
      data: {
        scan,
        intelligenceStatus: scan.intelligence_status,
        scores,
        findings,
        report: reports[0] ?? null,
      },
    })
  })

  fastify.get("/:id/quality", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
    }

    const { rows } = await query(
      "SELECT * FROM quality_assessments WHERE task_id = $1 AND org_id = $2 ORDER BY created_at DESC",
      [id, request.orgId],
    )

    return reply.send({ data: rows })
  })

  // GET /api/v1/scans/:id/findings
  fastify.get("/:id/findings", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string }

    // Org isolation: verify scan belongs to org
    const scan = await getScan(id, request.orgId)
    if (!scan) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
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
      [id, request.orgId],
    )

    return reply.send({ data: findings })
  })

  // POST /api/v1/scans/:id/cancel
  fastify.post(
    "/:id/cancel",
    {
      preHandler: [
        authenticate,
        requireOrgMember,
        requireRole("owner", "admin", "member"),
        validateIdParam,
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const scan = await getScan(id, request.orgId)
      if (!scan) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
      }
      if (!["queued", "running"].includes(scan.status)) {
        return reply
          .status(422)
          .send({
            error: {
              code: "INVALID_STATE",
              message: `Scan is ${scan.status} and cannot be cancelled`,
            },
          })
      }

      await query(
        "UPDATE scans SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND org_id = $2 AND status IN ('queued','running')",
        [id, request.orgId],
      )
      await emitScanEvent(id, "scan_cancelled", { scanId: id })
      await import("../services/monitoring.service.js")
        .then(({ finalizeMonitoringRun }) =>
          finalizeMonitoringRun(id, request.orgId, "cancelled"),
        )
        .catch(() => undefined)

      return reply.send({ data: { ok: true } })
    },
  )

  // GET /api/v1/scans/:id/events — SSE endpoint
  fastify.get(
    "/:id/events",
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string }

      const scan = await getScan(id, request.orgId)
      if (!scan) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
      }

      // Admission + registration happen synchronously (no await in between) so
      // concurrent requests cannot all slip under the caps.
      const limited = streamLimitFor(request.authUser.id, request.orgId)
      if (limited) {
        return reply
          .status(429)
          .header("Retry-After", "5")
          .send({ error: { code: "STREAM_LIMIT_REACHED", message: limited } })
      }

      let finished = false
      let timer: NodeJS.Timeout | undefined
      let lastId = 0
      const raw = reply.raw

      const entry: StreamEntry = {
        userId: request.authUser.id,
        orgId: request.orgId,
        end: () => finish(),
      }
      openStreams.add(entry)

      const release = () => {
        finished = true
        if (timer) clearTimeout(timer)
        openStreams.delete(entry)
      }
      function finish() {
        if (!finished) {
          release()
          try {
            if (!raw.writableEnded && !raw.destroyed) raw.end()
          } catch (err) {
            request.log.warn({ err, scanId: id }, "SSE end failed")
          }
        } else if (!raw.writableEnded && !raw.destroyed) {
          raw.end()
        }
      }

      // Register disconnect/error handlers before any await.
      raw.on("close", release)
      raw.on("error", (err) => {
        request.log.warn({ err, scanId: id }, "SSE socket error")
        release()
      })
      request.raw.on("close", release)

      // Hijack so Fastify does not also try to reply, but keep the headers that
      // earlier hooks (CORS, request id) already put on the reply.
      reply.hijack()
      raw.writeHead(200, {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        ...SSE_SECURITY_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      // Flush headers now so clients see the stream open even if the first poll is slow/fails.
      raw.flushHeaders()

      const write = (chunk: string): boolean => {
        if (finished || raw.destroyed || raw.writableEnded) return false
        try {
          raw.write(chunk)
          return true
        } catch (err) {
          request.log.warn({ err, scanId: id }, "SSE write failed")
          release()
          return false
        }
      }
      const writeEvent = (type: string, data: unknown, evId?: number): boolean =>
        write(
          `${evId !== undefined ? `id: ${evId}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        )

      const pollMs = Math.max(1_500, config.SSE_POLL_INTERVAL_MS ?? 2_000)

      const tick = async (): Promise<void> => {
        if (finished) return
        try {
          const { rows: events } = await query<{ id: number; type: string; payload: unknown }>(
            "SELECT id, type, payload FROM scan_events WHERE scan_id = $1 AND id > $2 ORDER BY id ASC",
            [id, lastId],
          )
          let terminal = false
          for (const ev of events) {
            if (!writeEvent(ev.type, ev.payload, ev.id)) return
            lastId = ev.id
            if (SSE_TERMINAL_EVENTS.has(ev.type)) terminal = true
          }

          // Always re-check the row: a missed/never-emitted terminal event
          // (or one committed after the replay query) must not hang the stream.
          const { rows } = await query<{ status: string }>(
            "SELECT status FROM scans WHERE id = $1 AND org_id = $2",
            [id, request.orgId],
          )
          const status = rows[0]?.status
          if (terminal || (status !== undefined && SSE_TERMINAL_STATUSES.has(status)) || rows.length === 0) {
            // Drain events committed between the two queries so `done` is last.
            if (!terminal) {
              const { rows: late } = await query<{ id: number; type: string; payload: unknown }>(
                "SELECT id, type, payload FROM scan_events WHERE scan_id = $1 AND id > $2 ORDER BY id ASC",
                [id, lastId],
              )
              for (const ev of late) {
                if (!writeEvent(ev.type, ev.payload, ev.id)) return
                lastId = ev.id
              }
            }
            writeEvent("done", { status: status ?? "unknown" })
            finish()
            return
          }
          write(": keepalive\n\n")
        } catch (err) {
          // Transient DB error: keep the stream, but never swallow silently.
          request.log.error({ err, scanId: id }, "SSE poll failed")
        }
        if (!finished) timer = setTimeout(() => void tick(), pollMs)
      }

      // Initial replay shares the poll path (terminal checks included).
      await tick()
      return reply
    },
  )
}
