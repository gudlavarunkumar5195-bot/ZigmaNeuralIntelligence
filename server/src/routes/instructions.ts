import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { getAgentDefinition } from "../ai/agents/registry.js";
import { AGENT_TYPES } from "../ai/agents/types.js";
import type { AgentType } from "../ai/agents/types.js";
import { composeInstructions } from "../ai/instructions/composer.js";
import { getInstructionProfile, listInstructionProfiles } from "../ai/instructions/profiles.js";
import { planInstructions } from "../ai/instructions/planner.js";
import { query } from "../db/client.js";

const member = [authenticate, requireOrgMember];
const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")];
const simulationSchema = z.object({
  agentType: z.enum([...AGENT_TYPES] as [string, ...string[]]), taskId: z.string().min(1).max(200).default("simulation"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("LOW"), context: z.record(z.unknown()).default({}),
  evidenceReferences: z.array(z.string().max(200)).max(100).default([]), previousFailure: z.string().max(1000).optional(),
});

export async function instructionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/ai/instructions", { preHandler: member }, async (_request, reply) => reply.send({ data: listInstructionProfiles() }));
  fastify.get("/ai/instructions/:agentType", { preHandler: member }, async (request, reply) => {
    const agentType = (request.params as { agentType: string }).agentType;
    const profile = getInstructionProfile(agentType as (typeof AGENT_TYPES)[number]);
    if (!profile) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Instruction profile not found" } });
    return reply.send({ data: profile });
  });
  fastify.get("/ai/instructions/:agentType/versions", { preHandler: member }, async (request, reply) => {
    const agentType = (request.params as { agentType: string }).agentType;
    const profile = getInstructionProfile(agentType as (typeof AGENT_TYPES)[number]);
    if (!profile) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Instruction profile not found" } });
    return reply.send({ data: [{ version: profile.version, status: profile.status, createdAt: profile.createdAt }] });
  });
  fastify.post("/ai/instructions/simulate", { preHandler: admin }, async (request, reply) => {
    const parsed = simulationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    const def = getAgentDefinition(parsed.data.agentType as AgentType);
    const profile = getInstructionProfile(parsed.data.agentType as AgentType)!;
    if (!def) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Agent not found" } });
    const { plan, validation } = planInstructions({ ...parsed.data, agentType: parsed.data.agentType as AgentType, agentVersion: def.version });
    const composition = composeInstructions(profile, plan);
    return reply.send({ data: { profile, plan, validation, composition, simulated: true, modelExecuted: false, toolsExecuted: false } });
  });
  fastify.get("/ai/instruction-plans/:id", { preHandler: member }, async (request, reply) => {
    const { id } = request.params as { id: string }; const orgId = (request as { orgId?: string }).orgId;
    const { rows } = await query(`SELECT p.*, v.status AS validation_status, v.violations, c.ordered_sections FROM instruction_plans p LEFT JOIN LATERAL (SELECT status, violations FROM instruction_validations WHERE instruction_plan_id=p.id ORDER BY created_at DESC LIMIT 1) v ON true LEFT JOIN LATERAL (SELECT ordered_sections FROM instruction_compositions WHERE instruction_plan_id=p.id ORDER BY created_at DESC LIMIT 1) c ON true WHERE p.id=$1 AND p.org_id=$2`, [id, orgId]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Instruction plan not found" } });
    return reply.send({ data: rows[0] });
  });
}
