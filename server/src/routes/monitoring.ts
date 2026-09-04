import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { MonitoringConfigInput, createMonitoringConfig, getMonitoring, listMonitoring, listChanges, listAlerts, runMonitoringNow, setMonitoringState, updateAlert, updateMonitoringConfig } from "../services/monitoring.service.js";

const member = [authenticate, requireOrgMember];
const operator = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")];

export async function monitoringRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/", { preHandler: member }, async (request, reply) => reply.send({ data: await listMonitoring(request.orgId) }));
  fastify.get("/alerts", { preHandler: member }, async (request, reply) => reply.send({ data: await listAlerts(request.orgId) }));
  fastify.post("/", { preHandler: operator }, async (request, reply) => {
    const parsed = MonitoringConfigInput.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    return reply.status(201).send({ data: await createMonitoringConfig(request.orgId, request.authUser.id, parsed.data) });
  });
  fastify.get("/:id", { preHandler: member }, async (request, reply) => {
    const config = await getMonitoring((request.params as { id: string }).id, request.orgId);
    if (!config) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Monitoring configuration not found" } });
    return reply.send({ data: config });
  });
  fastify.patch("/:id", { preHandler: admin }, async (request, reply) => {
    const parsed = MonitoringConfigInput.partial().omit({ websiteId: true }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    const ok = await updateMonitoringConfig((request.params as { id: string }).id, request.orgId, request.authUser.id, parsed.data);
    return ok ? reply.send({ data: { updated: true } }) : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Monitoring configuration not found" } });
  });
  fastify.post("/:id/pause", { preHandler: admin }, async (request, reply) => reply.send({ data: { updated: await setMonitoringState((request.params as { id: string }).id, request.orgId, request.authUser.id, "PAUSED") } }));
  fastify.post("/:id/resume", { preHandler: admin }, async (request, reply) => reply.send({ data: { updated: await setMonitoringState((request.params as { id: string }).id, request.orgId, request.authUser.id, "ACTIVE") } }));
  fastify.post("/:id/run", { preHandler: operator }, async (request, reply) => reply.status(202).send({ data: await runMonitoringNow((request.params as { id: string }).id, request.orgId, request.authUser.id) }));
  fastify.get("/:id/changes", { preHandler: member }, async (request, reply) => reply.send({ data: await listChanges((request.params as { id: string }).id, request.orgId) }));
  fastify.get("/:id/alerts", { preHandler: member }, async (request, reply) => reply.send({ data: await listAlerts(request.orgId, (request.params as { id: string }).id) }));

  fastify.post("/alerts/:id/acknowledge", { preHandler: operator }, async (request, reply) => reply.send({ data: { updated: await updateAlert((request.params as { id: string }).id, request.orgId, request.authUser.id, "ACKNOWLEDGED") } }));
  fastify.post("/alerts/:id/resolve", { preHandler: operator }, async (request, reply) => reply.send({ data: { updated: await updateAlert((request.params as { id: string }).id, request.orgId, request.authUser.id, "RESOLVED") } }));
  fastify.post("/alerts/:id/dismiss", { preHandler: operator }, async (request, reply) => reply.send({ data: { updated: await updateAlert((request.params as { id: string }).id, request.orgId, request.authUser.id, "DISMISSED") } }));
}
