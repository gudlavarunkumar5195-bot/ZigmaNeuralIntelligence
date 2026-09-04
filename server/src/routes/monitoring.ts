import type { FastifyInstance } from "fastify"
import { z } from "zod"
import {
  authenticate,
  requireOrgMember,
  requireRole,
} from "../middleware/auth.js"
import {
  MonitoringConfigInput,
  createMonitoringConfig,
  getMonitoring,
  listMonitoring,
  listChanges,
  listAlerts,
  runMonitoringNow,
  setMonitoringState,
  updateAlert,
  updateMonitoringConfig,
  getAlert,
  listAlertRules,
  createAlertRule,
  updateAlertRule,
} from "../services/monitoring.service.js"

const member = [authenticate, requireOrgMember]
const operator = [
  authenticate,
  requireOrgMember,
  requireRole("owner", "admin", "member"),
]
const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")]
const idParam = z.object({ id: z.string().uuid() })

export async function monitoringRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/", { preHandler: member }, async (request, reply) =>
    reply.send({ data: await listMonitoring(request.orgId) }),
  )
  fastify.get("/alerts", { preHandler: member }, async (request, reply) =>
    reply.send({ data: await listAlerts(request.orgId) }),
  )
  fastify.post("/", { preHandler: operator }, async (request, reply) => {
    const parsed = MonitoringConfigInput.safeParse(request.body)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: parsed.error.message },
        })
    return reply
      .status(201)
      .send({
        data: await createMonitoringConfig(
          request.orgId,
          request.authUser.id,
          parsed.data,
        ),
      })
  })
  fastify.get("/:id", { preHandler: member }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: "Invalid monitoring id" },
        })
    const config = await getMonitoring(parsed.data.id, request.orgId)
    if (!config)
      return reply
        .status(404)
        .send({
          error: {
            code: "NOT_FOUND",
            message: "Monitoring configuration not found",
          },
        })
    return reply.send({ data: config })
  })
  fastify.patch("/:id", { preHandler: admin }, async (request, reply) => {
    const parsed = MonitoringConfigInput.partial()
      .omit({ websiteId: true })
      .safeParse(request.body)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: parsed.error.message },
        })
    const ok = await updateMonitoringConfig(
      (request.params as { id: string }).id,
      request.orgId,
      request.authUser.id,
      parsed.data,
    )
    return ok
      ? reply.send({ data: { updated: true } })
      : reply
          .status(404)
          .send({
            error: {
              code: "NOT_FOUND",
              message: "Monitoring configuration not found",
            },
          })
  })
  fastify.post("/:id/pause", { preHandler: admin }, async (request, reply) =>
    reply.send({
      data: {
        updated: await setMonitoringState(
          (request.params as { id: string }).id,
          request.orgId,
          request.authUser.id,
          "PAUSED",
        ),
      },
    }),
  )
  fastify.post("/:id/resume", { preHandler: admin }, async (request, reply) =>
    reply.send({
      data: {
        updated: await setMonitoringState(
          (request.params as { id: string }).id,
          request.orgId,
          request.authUser.id,
          "ACTIVE",
        ),
      },
    }),
  )
  fastify.post("/:id/disable", { preHandler: admin }, async (request, reply) =>
    reply.send({
      data: {
        updated: await setMonitoringState(
          (request.params as { id: string }).id,
          request.orgId,
          request.authUser.id,
          "DISABLED",
        ),
      },
    }),
  )
  fastify.post("/:id/run", { preHandler: operator }, async (request, reply) =>
    reply
      .status(202)
      .send({
        data: await runMonitoringNow(
          (request.params as { id: string }).id,
          request.orgId,
          request.authUser.id,
        ),
      }),
  )
  fastify.get("/:id/changes", { preHandler: member }, async (request, reply) =>
    reply.send({
      data: await listChanges(
        (request.params as { id: string }).id,
        request.orgId,
      ),
    }),
  )
  fastify.get("/:id/alerts", { preHandler: member }, async (request, reply) =>
    reply.send({
      data: await listAlerts(
        request.orgId,
        (request.params as { id: string }).id,
      ),
    }),
  )
  fastify.get("/:id/rules", { preHandler: admin }, async (request, reply) =>
    reply.send({
      data: await listAlertRules(
        (request.params as { id: string }).id,
        request.orgId,
      ),
    }),
  )
  fastify.post("/:id/rules", { preHandler: admin }, async (request, reply) => {
    const parsed = z
      .object({
        ruleType: z.string().min(1).max(60),
        threshold: z.number().finite().nullable().optional(),
      })
      .safeParse(request.body)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: parsed.error.message },
        })
    const rule = await createAlertRule(
      (request.params as { id: string }).id,
      request.orgId,
      parsed.data,
    )
    return rule
      ? reply.status(201).send({ data: rule })
      : reply
          .status(404)
          .send({
            error: {
              code: "NOT_FOUND",
              message: "Monitoring configuration not found",
            },
          })
  })
  fastify.patch("/rules/:id", { preHandler: admin }, async (request, reply) => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        threshold: z.number().finite().nullable().optional(),
      })
      .strict()
      .safeParse(request.body)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: parsed.error.message },
        })
    return reply.send({
      data: {
        updated: await updateAlertRule(
          (request.params as { id: string }).id,
          request.orgId,
          parsed.data,
        ),
      },
    })
  })

  fastify.post(
    "/alerts/:id/acknowledge",
    { preHandler: operator },
    async (request, reply) =>
      reply.send({
        data: {
          updated: await updateAlert(
            (request.params as { id: string }).id,
            request.orgId,
            request.authUser.id,
            "ACKNOWLEDGED",
          ),
        },
      }),
  )
  fastify.post(
    "/alerts/:id/resolve",
    { preHandler: operator },
    async (request, reply) =>
      reply.send({
        data: {
          updated: await updateAlert(
            (request.params as { id: string }).id,
            request.orgId,
            request.authUser.id,
            "RESOLVED",
          ),
        },
      }),
  )
  fastify.post(
    "/alerts/:id/dismiss",
    { preHandler: operator },
    async (request, reply) =>
      reply.send({
        data: {
          updated: await updateAlert(
            (request.params as { id: string }).id,
            request.orgId,
            request.authUser.id,
            "DISMISSED",
          ),
        },
      }),
  )
  fastify.get("/alert/:id", { preHandler: member }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success)
      return reply
        .status(400)
        .send({
          error: { code: "VALIDATION_ERROR", message: "Invalid alert id" },
        })
    const alert = await getAlert(parsed.data.id, request.orgId)
    return alert
      ? reply.send({ data: alert })
      : reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Alert not found" } })
  })
}
