import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { refreshCatalog, getCatalogStatus } from "../ai/catalog.service.js";
import {
  listModels, getModel, enableModel, disableModel,
  getEligibleModels, getOrgPreferences, upsertOrgPreference,
} from "../ai/registry.service.js";
import { config } from "../config.js";

const disableSchema = z.object({
  reason: z.string().min(1).max(500),
});

const orgPrefSchema = z.object({
  taskType: z.string().min(1).max(100),
  preferredModelId: z.string().uuid().nullable().default(null),
  fallbackModelIds: z.array(z.string().uuid()).default([]),
  freeOnly: z.boolean().default(false),
  minReliability: z.number().min(0).max(100).default(0),
  minBenchmarkScore: z.number().min(0).max(100).default(0),
});

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireOrgMember, requireRole("owner", "admin")];
  const authPreHandler = [authenticate, requireOrgMember];

  // ─── GET /api/v1/models — list registry ────────────────────────────────────
  fastify.get("/", { preHandler: authPreHandler }, async (request, reply) => {
    const { status, eligibility, freeOnly, enabled } = request.query as {
      status?: string; eligibility?: string; freeOnly?: string; enabled?: string;
    };

    const models = await listModels({
      status: status as never,
      eligibility: eligibility as never,
      freeOnly: freeOnly === "true",
      enabled: enabled === undefined ? undefined : enabled === "true",
    });

    // Strip description from list view to keep response lean
    const data = models.map(({ description: _d, ...m }) => m);
    return reply.send({ data });
  });

  // ─── GET /api/v1/models/eligible — eligible models for a task ─────────────
  fastify.get("/eligible", { preHandler: authPreHandler }, async (request, reply) => {
    const { freeOnly } = request.query as { freeOnly?: string };
    const models = await getEligibleModels({ freeOnly: freeOnly === "true" });
    return reply.send({ data: models.map(({ description: _d, ...m }) => m) });
  });

  // ─── GET /api/v1/models/catalog/status ────────────────────────────────────
  fastify.get("/catalog/status", { preHandler: authPreHandler }, async (_request, reply) => {
    const status = await getCatalogStatus();
    return reply.send({ data: status });
  });

  // ─── POST /api/v1/models/catalog/refresh — admin only ─────────────────────
  fastify.post("/catalog/refresh", { preHandler: adminPreHandler }, async (request, reply) => {
    if (!config.OPENROUTER_API_KEY) {
      return reply.status(503).send({
        error: {
          code: "INTEGRATION_REQUIRED",
          message: "OPENROUTER_API_KEY is not configured. Catalog refresh requires live OpenRouter credentials.",
        },
      });
    }

    // Run refresh (may take several seconds)
    const result = await refreshCatalog();

    if (result.status === "failed") {
      return reply.status(502).send({
        error: {
          code: "CATALOG_REFRESH_FAILED",
          message: result.error ?? "Catalog refresh failed",
        },
      });
    }

    return reply.send({ data: result });
  });

  // ─── GET /api/v1/models/:id ────────────────────────────────────────────────
  fastify.get("/:id", { preHandler: authPreHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = await getModel(id);
    if (!model) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Model not found" } });
    }
    return reply.send({ data: model });
  });

  // ─── POST /api/v1/models/:id/enable — admin only ──────────────────────────
  fastify.post("/:id/enable", { preHandler: adminPreHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await enableModel(id, request.authUser.id, request.orgId);
    if (!ok) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Model not found" } });
    }
    return reply.send({ data: { id, enabled: true } });
  });

  // ─── POST /api/v1/models/:id/disable — admin only ─────────────────────────
  fastify.post("/:id/disable", { preHandler: adminPreHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = disableSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "reason is required" } });
    }
    const ok = await disableModel(id, request.authUser.id, body.data.reason, request.orgId);
    if (!ok) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Model not found" } });
    }
    return reply.send({ data: { id, enabled: false } });
  });

  // ─── GET /api/v1/models/preferences/:orgId — tenant preferences ───────────
  fastify.get("/preferences/:orgId", { preHandler: authPreHandler }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    if (orgId !== request.orgId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Cannot access another org's preferences" } });
    }
    const prefs = await getOrgPreferences(orgId);
    return reply.send({ data: prefs });
  });

  // ─── PUT /api/v1/models/preferences/:orgId — admin only ───────────────────
  fastify.put("/preferences/:orgId", { preHandler: adminPreHandler }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    if (orgId !== request.orgId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Cannot modify another org's preferences" } });
    }
    const body = orgPrefSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: body.error.message } });
    }
    await upsertOrgPreference(orgId, body.data, request.authUser.id);
    return reply.send({ data: { updated: true } });
  });
}
