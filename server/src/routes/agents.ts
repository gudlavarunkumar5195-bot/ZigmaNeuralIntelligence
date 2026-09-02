// Phase 3D: Specialist Agent API routes.
//
// All routes require admin or owner role (admin operations on global resources).
// Agent definitions are globally managed; executions are org-scoped.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import {
  listAgentDefinitions,
  getAgentDefinition,
  listAgentsFromDb,
  getAgentFromDb,
  enableAgent,
  disableAgent,
  listAgentVersionsFromDb,
  buildAgentView,
} from "../ai/agents/registry.js";
import { executeAgent } from "../ai/agents/orchestrator.js";
import { planWorkflow } from "../ai/agents/orchestrator.js";
import { AGENT_TYPES } from "../ai/agents/types.js";
import type { AgentType, AgentInput } from "../ai/agents/types.js";
import { query } from "../db/client.js";

const adminPreHandler = [authenticate, requireOrgMember, requireRole("owner", "admin")];
const memberPreHandler = [authenticate, requireOrgMember];

const simulateSchema = z.object({
  agentType: z.enum([...AGENT_TYPES] as [string, ...string[]]),
  taskId: z.string().uuid().optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("LOW"),
  evidenceReferences: z.array(z.string()).default([]),
  context: z.record(z.unknown()).default({}),
  allowedTools: z.array(z.string()).optional(),
  satisfiedDependencies: z.array(z.string()).optional(),
});

const planSchema = z.object({
  agentTypes: z.array(z.enum([...AGENT_TYPES] as [string, ...string[]])).min(1),
});

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /agents — list all agent definitions ──────────────────────────────
  fastify.get("/", { preHandler: memberPreHandler }, async (_req, reply) => {
    const defs = listAgentDefinitions();
    const dbRows = await listAgentsFromDb().catch(() => []);
    const dbMap = new Map(dbRows.map((r) => [r.agent_type, r]));

    const agents = defs.map((def) => buildAgentView(def, dbMap.get(def.agentType)));
    return reply.send({ data: agents });
  });

  // ── GET /agents/types — return all supported agent types ──────────────────
  fastify.get("/types", { preHandler: memberPreHandler }, async (_req, reply) => {
    return reply.send({ data: [...AGENT_TYPES] });
  });

  // ── GET /agents/:agentType — agent detail ─────────────────────────────────
  fastify.get("/:agentType", { preHandler: memberPreHandler }, async (request, reply) => {
    const { agentType } = request.params as { agentType: string };
    const def = getAgentDefinition(agentType as AgentType);
    if (!def) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `Agent ${agentType} not found` } });
    }

    const dbRow = await getAgentFromDb(agentType).catch(() => null);
    const versions = await listAgentVersionsFromDb(agentType).catch(() => []);

    return reply.send({
      data: {
        ...buildAgentView(def, dbRow ?? undefined),
        versions,
        instructionProfileSummary: def.instructionProfile.split("\n")[0],
      },
    });
  });

  // ── GET /agents/:agentType/versions — version history ────────────────────
  fastify.get("/:agentType/versions", { preHandler: memberPreHandler }, async (request, reply) => {
    const { agentType } = request.params as { agentType: string };
    if (!getAgentDefinition(agentType as AgentType)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `Agent ${agentType} not found` } });
    }

    const versions = await listAgentVersionsFromDb(agentType).catch(() => []);
    return reply.send({ data: versions });
  });

  // ── GET /agents/:agentType/executions — execution history (org-scoped) ───
  fastify.get("/:agentType/executions", { preHandler: memberPreHandler }, async (request, reply) => {
    const { agentType } = request.params as { agentType: string };
    const { orgId } = request as { orgId?: string };
    const limitParam = (request.query as { limit?: string }).limit;
    const limit = Math.min(parseInt(limitParam ?? "50", 10) || 50, 200);

    const { rows } = await query(
      `SELECT id, agent_type, model_id, status, attempt_number,
              routing_id, agent_version, failure_type,
              started_at, completed_at, latency_ms, error, created_at
       FROM agent_executions
       WHERE agent_type = $1 AND org_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [agentType, orgId ?? null, limit]
    );
    return reply.send({ data: rows });
  });

  // ── POST /agents/:agentType/enable — enable agent (admin) ────────────────
  fastify.post("/:agentType/enable", { preHandler: adminPreHandler }, async (request, reply) => {
    const { agentType } = request.params as { agentType: string };
    if (!getAgentDefinition(agentType as AgentType)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `Agent ${agentType} not found` } });
    }

    await enableAgent(agentType, request.authUser.id);
    return reply.send({ data: { agentType, enabled: true } });
  });

  // ── POST /agents/:agentType/disable — disable agent (admin) ──────────────
  fastify.post("/:agentType/disable", { preHandler: adminPreHandler }, async (request, reply) => {
    const { agentType } = request.params as { agentType: string };
    if (!getAgentDefinition(agentType as AgentType)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `Agent ${agentType} not found` } });
    }

    const body = (request.body as { reason?: string }) ?? {};
    const reason = body.reason ?? "Disabled by administrator";
    await disableAgent(agentType, reason, request.authUser.id);
    return reply.send({ data: { agentType, enabled: false } });
  });

  // ── POST /agents/simulate — agent simulator (no model execution) ──────────
  // Input: agentType + task requirements
  // Output: agent definition, TaskRequirements, routing decision, expected schema
  // Never executes real tools or modifies infrastructure.
  fastify.post("/simulate", { preHandler: adminPreHandler }, async (request, reply) => {
    const parsed = simulateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    const { agentType, taskId, riskLevel, evidenceReferences, context, allowedTools, satisfiedDependencies } = parsed.data;

    const def = getAgentDefinition(agentType as AgentType);
    if (!def) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `Agent ${agentType} not found` } });
    }

    const result = await executeAgent({
      taskId: taskId ?? crypto.randomUUID(),
      tenantId: (request as { orgId?: string }).orgId ?? "simulate",
      agentType: agentType as AgentType,
      agentVersion: def.version,
      evidenceReferences,
      riskLevel: riskLevel as AgentInput["riskLevel"],
      context,
      allowedTools,
      satisfiedDependencies,
      correlationId: crypto.randomUUID(),
      simulate: true,
    });

    return reply.send({
      data: {
        agentDefinition: buildAgentView(def),
        simulatedResult: result,
        taskRequirements: {
          taskType: agentType,
          complexity: riskLevel,
          riskLevel,
          requiredModelCapabilities: def.requiredModelCapabilities,
          structuredOutputRequired: true,
        },
      },
    });
  });

  // ── POST /agents/plan — workflow dependency planning ──────────────────────
  fastify.post("/plan", { preHandler: adminPreHandler }, async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    const plan = planWorkflow(parsed.data.agentTypes);
    return reply.send({ data: plan });
  });
}
