import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { assessQuality } from "../ai/quality/evaluator.js";
import type { AgentResult } from "../ai/agents/types.js";
import { query } from "../db/client.js";
const member = [authenticate, requireOrgMember]; const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")];
const resultSchema = z.object({ taskId: z.string().min(1), agentType: z.string().min(1), agentVersion: z.string().min(1), status: z.enum(["SUCCESS", "PARTIAL", "FAILED", "SKIPPED"]), findings: z.array(z.object({ findingId: z.string(), title: z.string(), category: z.string(), severity: z.string(), description: z.string(), evidenceIds: z.array(z.string()), confidence: z.number(), status: z.string() })), evidenceReferences: z.array(z.string()), recommendations: z.array(z.string()), confidence: z.number(), warnings: z.array(z.string()), limitations: z.array(z.string()) });
const simulation = z.object({ result: resultSchema, requiredCoverage: z.number().int().nonnegative().optional(), coveredResources: z.number().int().nonnegative().optional(), evidenceValid: z.boolean().optional(), evidenceFresh: z.boolean().optional(), securityViolation: z.boolean().optional(), unauthorizedTool: z.boolean().optional(), instructionValid: z.boolean().optional() });
export async function qualityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/ai/tasks/:id/quality", { preHandler: member }, async (request, reply) => { const { rows } = await query(`SELECT * FROM quality_assessments WHERE task_id=$1 AND org_id=$2 ORDER BY created_at DESC`, [(request.params as { id: string }).id, request.orgId]); return reply.send({ data: rows }); });
  fastify.get("/ai/executions/:id/quality", { preHandler: member }, async (request, reply) => { const { rows } = await query(`SELECT * FROM quality_assessments WHERE execution_id=$1 AND org_id=$2 ORDER BY created_at DESC`, [(request.params as { id: string }).id, request.orgId]); return reply.send({ data: rows }); });
  fastify.get("/ai/quality/:id", { preHandler: member }, async (request, reply) => { const { rows } = await query(`SELECT * FROM quality_assessments WHERE id=$1 AND org_id=$2`, [(request.params as { id: string }).id, request.orgId]); if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Quality assessment not found" } }); return reply.send({ data: rows[0] }); });
  fastify.post("/ai/quality/simulate", { preHandler: admin }, async (request, reply) => { const parsed = simulation.safeParse(request.body); if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } }); const assessment = assessQuality({ ...parsed.data, result: parsed.data.result as AgentResult }); return reply.send({ data: { ...assessment, simulated: true, modelExecuted: false } }); });
}
