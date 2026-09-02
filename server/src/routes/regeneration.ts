import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { planRegeneration } from "../ai/regeneration/supervisor.js";
import type { AssessmentHistory } from "../ai/regeneration/types.js";
import type { QualityAssessment } from "../ai/quality/types.js";
import { query } from "../db/client.js";
const member = [authenticate, requireOrgMember]; const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")];
const simulated = z.object({ assessment: z.record(z.unknown()), history: z.array(z.object({ overallScore: z.number(), status: z.string() })).default([]) });
export async function regenerationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/ai/tasks/:id/regeneration", { preHandler: member }, async (request, reply) => { const { rows } = await query(`SELECT * FROM regeneration_runs WHERE task_id=$1 AND org_id=$2 ORDER BY created_at DESC`, [(request.params as { id: string }).id, request.orgId]); return reply.send({ data: rows }); });
  fastify.get("/ai/regeneration/:id", { preHandler: member }, async (request, reply) => { const { rows } = await query(`SELECT * FROM regeneration_runs WHERE id=$1 AND org_id=$2`, [(request.params as { id: string }).id, request.orgId]); if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Regeneration run not found" } }); return reply.send({ data: rows[0] }); });
  fastify.post("/ai/regeneration/simulate", { preHandler: admin }, async (request, reply) => { const parsed = simulated.safeParse(request.body); if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } }); return reply.send({ data: { ...planRegeneration(parsed.data.assessment as unknown as QualityAssessment, parsed.data.history as AssessmentHistory), simulated: true, modelExecuted: false } }); });
}
