// Phase 3C: Routing API routes.
// POST /simulate — deterministic only, no model execution
// GET  /decisions — routing history (admin)
// GET  /decisions/:id — single decision (admin)
// GET  /policy — current routing policy (admin)
// POST /policy — update routing policy (admin)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { resolveRouting } from "../ai/router/index.js";
import {
  listRoutingDecisions,
  getRoutingDecision,
} from "../ai/router/index.js";
import { getActivePolicy, updateActivePolicy } from "../ai/router/routing-policy.js";
import { TASK_TYPES } from "../ai/router/types.js";

// ─── Validation schemas ────────────────────────────────────────────────────────

const capabilitySchema = z.enum([
  "REASONING", "CODING", "VISION", "TOOL_CALLING", "STRUCTURED_OUTPUT",
  "LONG_CONTEXT", "SEO", "SECURITY", "ACCESSIBILITY", "PERFORMANCE",
]);

const taskRequirementsSchema = z.object({
  taskType: z.enum([...TASK_TYPES] as [string, ...string[]]),
  agentType: z.string().max(100).optional(),
  complexity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  requiredCapabilities: z.array(capabilitySchema).default([]),
  preferredCapabilities: z.array(capabilitySchema).default([]),
  structuredOutputRequired: z.boolean().default(false),
  toolCallingRequired: z.boolean().default(false),
  visionRequired: z.boolean().default(false),
  minimumContextLength: z.number().int().min(0).optional(),
  minimumReliability: z.number().min(0).max(1).optional(),
  minimumQualityScore: z.number().min(0).max(100).optional(),
  freeOnly: z.boolean().optional(),
  allowedProviders: z.array(z.string().max(100)).optional(),
  excludedModels: z.array(z.string().max(300)).optional(),
  preferredModelId: z.string().max(300).optional(),
  maximumLatencyMs: z.number().int().min(0).optional(),
  orgId: z.string().uuid().optional(),
});

const policyUpdateSchema = z.object({
  freeOnly: z.boolean().optional(),
  minReliability: z.number().min(0).max(1).optional(),
  minQuality: z.number().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  requireCrossModelVerification: z.boolean().optional(),
  allowedProviders: z.array(z.string().max(100)).nullable().optional(),
  excludedModels: z.array(z.string().max(300)).nullable().optional(),
  description: z.string().max(500).optional(),
  weights: z.object({
    benchmark: z.number().min(0).max(1).optional(),
    reliability: z.number().min(0).max(1).optional(),
    capability: z.number().min(0).max(1).optional(),
    historical: z.number().min(0).max(1).optional(),
    structuredOutput: z.number().min(0).max(1).optional(),
    latency: z.number().min(0).max(1).optional(),
    context: z.number().min(0).max(1).optional(),
    preference: z.number().min(0).max(1).optional(),
  }).optional(),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function routingRoutes(fastify: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireOrgMember, requireRole("owner", "admin")];

  // ── POST /simulate ──────────────────────────────────────────────────────────
  // Administrator-only routing simulator.
  // Runs deterministic filter + scoring only — does NOT call OX Alpha.
  // Does NOT persist a routing decision.
  fastify.post("/simulate", { preHandler: adminPreHandler }, async (request, reply) => {
    const parsed = taskRequirementsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUIREMENTS", message: parsed.error.message },
      });
    }

    const startMs = Date.now();
    try {
      const decision = await resolveRouting({
        requirements: parsed.data as never,
        simulate: true,
        correlationId: crypto.randomUUID(),
      });

      return reply.send({
        data: {
          ...decision,
          simulatedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          note: "Simulation only — no model was selected for execution, no decision persisted",
        },
      });
    } catch (err) {
      fastify.log.error({ err }, "Routing simulation failed");
      return reply.status(500).send({
        error: { code: "ROUTING_ERROR", message: "Routing simulation failed" },
      });
    }
  });

  // ── GET /decisions ──────────────────────────────────────────────────────────
  fastify.get("/decisions", { preHandler: adminPreHandler }, async (request, reply) => {
    const { limit, orgId } = request.query as { limit?: string; orgId?: string };
    const parsedLimit = Math.min(parseInt(limit ?? "50", 10) || 50, 200);

    try {
      const decisions = await listRoutingDecisions(parsedLimit, orgId);
      return reply.send({ data: decisions });
    } catch (err) {
      fastify.log.error({ err }, "Failed to list routing decisions");
      return reply.status(500).send({
        error: { code: "DB_ERROR", message: "Failed to fetch routing history" },
      });
    }
  });

  // ── GET /decisions/:id ──────────────────────────────────────────────────────
  fastify.get("/decisions/:id", { preHandler: adminPreHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const decision = await getRoutingDecision(id);
      if (!decision) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Routing decision not found" },
        });
      }
      return reply.send({ data: decision });
    } catch (err) {
      fastify.log.error({ err }, "Failed to fetch routing decision");
      return reply.status(500).send({
        error: { code: "DB_ERROR", message: "Failed to fetch routing decision" },
      });
    }
  });

  // ── GET /policy ─────────────────────────────────────────────────────────────
  fastify.get("/policy", { preHandler: adminPreHandler }, async (request, reply) => {
    const { orgId } = request.query as { orgId?: string };
    try {
      const policy = await getActivePolicy(orgId);
      return reply.send({ data: policy });
    } catch (err) {
      fastify.log.error({ err }, "Failed to fetch routing policy");
      return reply.status(500).send({
        error: { code: "DB_ERROR", message: "Failed to fetch routing policy" },
      });
    }
  });

  // ── POST /policy ────────────────────────────────────────────────────────────
  fastify.post("/policy", { preHandler: adminPreHandler }, async (request, reply) => {
    const parsed = policyUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_POLICY", message: parsed.error.message },
      });
    }

    const actorId = (request as unknown as { user?: { id?: string } }).user?.id ?? "unknown";
    const { orgId } = request.query as { orgId?: string };

    try {
      const policy = await updateActivePolicy(parsed.data, actorId, orgId);
      return reply.status(200).send({ data: policy });
    } catch (err) {
      fastify.log.error({ err }, "Failed to update routing policy");
      return reply.status(500).send({
        error: { code: "DB_ERROR", message: "Failed to update routing policy" },
      });
    }
  });

  // ── GET /task-types ─────────────────────────────────────────────────────────
  // Returns supported task types — useful for the simulator UI.
  fastify.get("/task-types", { preHandler: adminPreHandler }, async (_request, reply) => {
    return reply.send({ data: TASK_TYPES });
  });
}
