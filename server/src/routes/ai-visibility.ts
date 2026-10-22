import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { CursorValidationError } from "../http/pagination.js";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { IMPORT_SURFACES, METRIC_DEFINITIONS, PRIORITY_FORMULA, PROMPT_VERSION, SURFACES } from "../visibility/core.js";
import { providerRegistry } from "../visibility/providers.js";
import {
  addCompetitor,
  aiAvailable,
  cancelRun,
  citedDomains,
  competitorComparison,
  createAiSummary,
  createBrand,
  createQueries,
  createRun,
  exportCsv,
  getMetrics,
  getObservation,
  getOpportunity,
  getOverview,
  getRun,
  importObservations,
  listAiSummaries,
  listBrands,
  listCompetitors,
  listImports,
  listObservations,
  listOpportunities,
  listQueries,
  listRuns,
  listSources,
  previewImport,
  previewRun,
  queryVersions,
  reprocessMentions,
  requireBrand,
  setObservationExcluded,
  setSchedule,
  updateBrand,
  updateCompetitor,
  updateOpportunity,
  updateQuery,
  usageToday,
  verifySource,
  VisibilityError,
} from "../services/ai-visibility.service.js";

/**
 * AI search visibility API (mounted under /api/v1/ai-visibility). Every
 * route: authenticated, org member re-checked in the database (x-org-id); a
 * brand is only found through the caller's organization (404 otherwise).
 * Writes need a non-viewer role, are validated strictly, rate-limited where
 * expensive and audited. Provider calls only happen in confirmed runs.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)), "invalid date");
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);
const language = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);
const country = z.string().trim().toLowerCase().regex(/^[a-z]{2}$/);
const term = z.string().max(120);
const providerId = z.string().regex(/^[a-z0-9_]{1,40}$/);

const brandBody = z.object({
  name: z.string().trim().min(1).max(120),
  domains: z.array(z.string().max(253)).max(10).optional(),
  aliases: z.array(term).max(20).optional(),
  products: z.array(term).max(30).optional(),
  excludeTerms: z.array(term).max(20).optional(),
  disambiguation: z.string().max(1000).nullish(),
  topics: z.array(z.string().max(80)).max(30).optional(),
  locations: z.array(z.string().max(120)).max(10).optional(),
  language: language.nullish(),
  country: country.nullish(),
  websiteId: z.string().uuid().nullish(),
  ownerId: z.string().uuid().nullish(),
}).strict();

const competitorBody = brandBody.pick({ name: true, domains: true, aliases: true, products: true, excludeTerms: true, disambiguation: true }).strict();

const queryItem = z.object({
  text: z.string().max(500),
  topic: z.string().trim().max(80).nullish(),
  language: language.nullish(),
  country: country.nullish(),
  providers: z.array(providerId).max(10).optional(),
}).strict();

const windowQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  provider: providerId.optional(),
  surface: providerId.optional(),
  method: z.enum(["provider_api", "manual_import"]).optional(),
  queryId: z.string().uuid().optional(),
}).strict();

const runBody = z.object({
  provider: providerId,
  queryIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  repeats: z.coerce.number().int().min(1).max(5).default(1),
});

export async function aiVisibilityRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const pv = uuidParams("brandId", "competitorId", "queryId", "runId", "observationId", "sourceId", "opportunityId");
  const perSession = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `aiv:${createHash("sha256").update(auth).digest("hex")}` : `aiv-ip:${request.ip}`;
  };

  function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data as z.infer<S>;
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "request"}: ${r.error.issues[0].message}` : "Invalid request" } });
    return undefined;
  }
  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof VisibilityError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof CursorValidationError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    throw err;
  }
  const log = (request: FastifyRequest, action: string, resourceId: string | null, metadata: Record<string, unknown>) =>
    audit({ userId: request.authUser.id, orgId: request.orgId, requestId: request.id, action, resourceType: "aiv_brand", resourceId, result: "success", metadata });
  const brandOf = (request: FastifyRequest) => requireBrand(request.orgId, (request.params as { brandId: string }).brandId);
  const param = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name];

  // Wraps a handler: brand lookup (404 across tenants) and safe errors.
  const withBrand = <T>(fn: (request: FastifyRequest, reply: FastifyReply, b: Awaited<ReturnType<typeof requireBrand>>) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(request, reply, await brandOf(request));
      } catch (err) {
        return fail(reply, err);
      }
    };

  fastify.get("/providers", { preHandler: read }, async (request, reply) =>
    reply.send({
      data: {
        providers: await providerRegistry(),
        usage: await usageToday(request.orgId),
        surfaces: SURFACES,
        importSurfaces: IMPORT_SURFACES,
        promptVersion: PROMPT_VERSION,
        metricDefinitions: METRIC_DEFINITIONS,
        priorityFormula: PRIORITY_FORMULA,
        ai: { available: aiAvailable() },
        limits: {
          brands: config.AIV_MAX_BRANDS_PER_ORG, competitors: config.AIV_MAX_COMPETITORS, queriesPerBrand: config.AIV_MAX_QUERIES_PER_BRAND, requestsPerRun: config.AIV_MAX_REQUESTS_PER_RUN,
          requestsPerDay: config.AIV_MAX_REQUESTS_PER_ORG_PER_DAY, importRows: config.AIV_IMPORT_MAX_ROWS, importBytes: config.AIV_IMPORT_MAX_BYTES, minSample: config.AIV_MIN_SAMPLE,
          responseMaxChars: config.AIV_RESPONSE_MAX_CHARS, verificationsPerDay: config.AIV_VERIFY_MAX_PER_DAY,
        },
      },
    }));

  // ─── Brands ────────────────────────────────────────────────────────────────
  fastify.get("/brands", { preHandler: read }, async (request, reply) => {
    const q = parse(z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await listBrands(request.orgId, q.includeArchived === "true") });
  });

  fastify.post("/brands", { preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parse(brandBody, request.body, reply);
    if (!body) return;
    try {
      const b = await createBrand(request.orgId, request.authUser.id, body);
      await log(request, "aiv_brand_created", b.id, { name: b.name, domains: b.domains });
      return reply.status(201).send({ data: b });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/brands/:brandId", { preValidation: pv, preHandler: read }, withBrand(async (_req, reply, b) => reply.send({ data: b })));

  fastify.patch("/brands/:brandId", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(brandBody.partial().extend({ status: z.enum(["active", "disabled", "archived"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    const updated = await updateBrand(request.orgId, b, request.authUser.id, body);
    await log(request, "aiv_brand_updated", b.id, { fields: Object.keys(body), status: body.status });
    return reply.send({ data: updated });
  }));

  fastify.get("/brands/:brandId/overview", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await getOverview(request.orgId, b) })));

  fastify.put("/brands/:brandId/schedule", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(z.discriminatedUnion("schedule", [
      z.object({ schedule: z.literal("off") }).strict(),
      // Enabling recurring provider calls needs explicit confirmation of the limits shown.
      z.object({ schedule: z.literal("weekly"), provider: providerId, repeats: z.number().int().min(1).max(5), maxRequests: z.number().int().min(1).max(1000), confirm: z.literal(true) }).strict(),
    ]), request.body, reply);
    if (!body) return;
    const updated = await setSchedule(request.orgId, b, request.authUser.id, body);
    await log(request, "aiv_schedule_changed", b.id, { schedule: body.schedule, ...(body.schedule === "weekly" ? { provider: body.provider, repeats: body.repeats, maxRequests: body.maxRequests } : {}) });
    return reply.send({ data: updated });
  }));

  fastify.post("/brands/:brandId/reprocess", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const r = await reprocessMentions(request.orgId, b.id, request.authUser.id);
    await log(request, "aiv_mentions_reprocessed", b.id, r);
    return reply.send({ data: r });
  }));

  // ─── Competitors ───────────────────────────────────────────────────────────
  fastify.get("/brands/:brandId/competitors", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await listCompetitors(request.orgId, b.id, q.includeArchived === "true") });
  }));

  fastify.post("/brands/:brandId/competitors", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(competitorBody, request.body, reply);
    if (!body) return;
    const c = await addCompetitor(request.orgId, b, request.authUser.id, body);
    await log(request, "aiv_competitor_added", b.id, { competitorId: c.id, name: c.name });
    return reply.status(201).send({ data: c });
  }));

  fastify.patch("/brands/:brandId/competitors/:competitorId", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(competitorBody.partial().extend({ status: z.enum(["active", "disabled", "archived"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    const c = await updateCompetitor(request.orgId, b, param(request, "competitorId"), request.authUser.id, body);
    await log(request, "aiv_competitor_updated", b.id, { competitorId: c.id, fields: Object.keys(body), status: body.status });
    return reply.send({ data: c });
  }));

  // ─── Queries ───────────────────────────────────────────────────────────────
  fastify.get("/brands/:brandId/queries", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(z.object({ status: z.enum(["active", "paused", "archived"]).optional(), topic: z.string().trim().max(80).optional(), search: z.string().trim().min(1).max(200).optional(), limit: limit(200, 50), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listQueries(request.orgId, b, q);
    return reply.send({ data: r.rows, meta: { total: r.total, topics: r.topics, limit: q.limit, offset: q.offset } });
  }));

  fastify.post("/brands/:brandId/queries", { preValidation: pv, preHandler: write, bodyLimit: 512_000, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(z.object({ queries: z.array(queryItem).min(1).max(500) }).strict(), request.body, reply);
    if (!body) return;
    const r = await createQueries(request.orgId, b, request.authUser.id, body.queries);
    await log(request, "aiv_queries_added", b.id, { added: r.added, invalid: r.invalid.length });
    return reply.status(201).send({ data: { added: r.added, alreadyExists: r.alreadyExists, invalid: r.invalid } });
  }));

  fastify.patch("/brands/:brandId/queries/:queryId", { preValidation: pv, preHandler: write }, withBrand(async (request, reply, b) => {
    const body = parse(queryItem.partial().extend({ status: z.enum(["active", "paused", "archived"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    const r = await updateQuery(request.orgId, b, param(request, "queryId"), request.authUser.id, body);
    await log(request, "aiv_query_updated", b.id, { queryId: r.id, versionCreated: r.versionCreated, status: body.status });
    return reply.send({ data: r });
  }));

  fastify.get("/brands/:brandId/queries/:queryId/versions", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await queryVersions(request.orgId, b, param(request, "queryId")) })));

  // ─── Collection runs ───────────────────────────────────────────────────────
  fastify.post("/brands/:brandId/runs/preview", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(runBody.strict(), request.body, reply);
    if (!body) return;
    return reply.send({ data: await previewRun(request.orgId, b, body) });
  }));

  fastify.post("/brands/:brandId/runs", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    // `confirm: true` records that the caller saw the preview (requests, quota, cost note).
    const body = parse(runBody.extend({ confirm: z.literal(true), idempotencyKey: z.string().trim().min(8).max(100).optional() }).strict(), request.body, reply);
    if (!body) return;
    const r = await createRun(request.orgId, b, request.authUser.id, body);
    if (!r.deduplicated) await log(request, "aiv_run_requested", b.id, { runId: (r.run as { id: string }).id, provider: body.provider, requests: (r.run as { items_total: number }).items_total });
    return reply.status(r.deduplicated ? 200 : 202).send({ data: r });
  }));

  fastify.get("/brands/:brandId/runs", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await listRuns(request.orgId, b.id) })));
  fastify.get("/brands/:brandId/runs/:runId", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await getRun(request.orgId, b.id, param(request, "runId")) })));

  fastify.post("/brands/:brandId/runs/:runId/cancel", { preValidation: pv, preHandler: write }, withBrand(async (request, reply, b) => {
    const r = await cancelRun(request.orgId, b.id, param(request, "runId"));
    if (r.cancelled) await log(request, "aiv_run_cancelled", b.id, { runId: param(request, "runId") });
    return reply.send({ data: r });
  }));

  // ─── Observations ──────────────────────────────────────────────────────────
  fastify.get("/brands/:brandId/observations", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(windowQuery.extend({
      mentions: z.string().uuid().optional(),
      notMentioned: z.enum(["true", "false"]).optional(),
      hasCitations: z.enum(["true", "false"]).optional(),
      includeExcluded: z.enum(["true", "false"]).optional(),
      limit: limit(100, 25),
      cursor: z.string().max(500).optional(),
    }).strict(), request.query, reply);
    if (!q) return;
    const r = await listObservations(request.orgId, b, {
      ...q, notMentioned: q.notMentioned === "true", hasCitations: q.hasCitations === undefined ? undefined : q.hasCitations === "true", includeExcluded: q.includeExcluded === "true",
    }, { limit: q.limit, cursor: q.cursor });
    return reply.send({ data: r.observations, meta: { nextCursor: r.nextCursor } });
  }));

  fastify.get("/brands/:brandId/observations/:observationId", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await getObservation(request.orgId, b, param(request, "observationId")) })));

  fastify.post("/brands/:brandId/observations/:observationId/exclude", { preValidation: pv, preHandler: write }, withBrand(async (request, reply, b) => {
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), request.body, reply);
    if (!body) return;
    const r = await setObservationExcluded(request.orgId, b, param(request, "observationId"), request.authUser.id, true, body.reason);
    if (r.changed) await log(request, "aiv_observation_excluded", b.id, { observationId: param(request, "observationId") });
    return reply.send({ data: r });
  }));

  fastify.post("/brands/:brandId/observations/:observationId/include", { preValidation: pv, preHandler: write }, withBrand(async (request, reply, b) => {
    const r = await setObservationExcluded(request.orgId, b, param(request, "observationId"), request.authUser.id, false, null);
    if (r.changed) await log(request, "aiv_observation_included", b.id, { observationId: param(request, "observationId") });
    return reply.send({ data: r });
  }));

  // ─── Citations and sources ─────────────────────────────────────────────────
  fastify.get("/brands/:brandId/sources", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(z.object({
      host: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/).optional(),
      search: z.string().trim().min(1).max(200).optional(),
      verification: z.enum(["unverified", "reachable_mentions_brand", "reachable_no_mention", "unreachable", "blocked_by_robots", "not_html", "unsafe_url", "error"]).optional(),
      owner: z.enum(["target", "competitor", "other"]).optional(),
      from: day.optional(),
      to: day.optional(),
      sort: z.enum(["citations", "recent"]).default("citations"),
      limit: limit(200, 50),
      offset,
    }).strict(), request.query, reply);
    if (!q) return;
    const r = await listSources(request.orgId, b, q);
    return reply.send({ data: r.rows, meta: { total: r.total, limit: q.limit, offset: q.offset } });
  }));

  fastify.get("/brands/:brandId/domains", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(windowQuery, request.query, reply);
    if (!q) return;
    return reply.send({ data: await citedDomains(request.orgId, b, q) });
  }));

  // Fetches one cited page on request (SSRF-safe, robots.txt honoured, daily cap).
  fastify.post("/brands/:brandId/sources/:sourceId/verify", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const r = await verifySource(request.orgId, b, param(request, "sourceId"), request.authUser.id);
    await log(request, "aiv_source_verified", b.id, { sourceId: r.sourceId, status: r.status });
    return reply.send({ data: r });
  }));

  // ─── Metrics and comparison ────────────────────────────────────────────────
  fastify.get("/brands/:brandId/metrics", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, withBrand(async (request, reply, b) => {
    const q = parse(windowQuery, request.query, reply);
    if (!q) return;
    return reply.send({ data: await getMetrics(request.orgId, b, q) });
  }));

  fastify.get("/brands/:brandId/competitor-comparison", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, withBrand(async (request, reply, b) => {
    const q = parse(windowQuery, request.query, reply);
    if (!q) return;
    return reply.send({ data: await competitorComparison(request.orgId, b, q) });
  }));

  // ─── Opportunities ─────────────────────────────────────────────────────────
  fastify.get("/brands/:brandId/opportunities", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => {
    const q = parse(z.object({ status: z.enum(["open", "in_progress", "done", "dismissed", "obsolete"]).optional(), kind: z.enum(["frequently_cited_source", "mentioned_not_cited", "competitor_only_queries", "insufficient_data", "unreachable_cited_source"]).optional() }).strict(), request.query, reply);
    if (!q) return;
    const r = await listOpportunities(request.orgId, b, q);
    return reply.send({ data: r.rows, meta: { formula: r.formula } });
  }));

  fastify.get("/brands/:brandId/opportunities/:opportunityId", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await getOpportunity(request.orgId, b, param(request, "opportunityId")) })));

  fastify.patch("/brands/:brandId/opportunities/:opportunityId", { preValidation: pv, preHandler: write }, withBrand(async (request, reply, b) => {
    const body = parse(z.object({ status: z.enum(["open", "in_progress", "done", "dismissed"]).optional(), ownerId: z.string().uuid().nullable().optional(), note: z.string().trim().min(1).max(1000).optional() }).strict().refine((v) => v.status || v.ownerId !== undefined || v.note, "nothing to update"), request.body, reply);
    if (!body) return;
    const r = await updateOpportunity(request.orgId, b, param(request, "opportunityId"), request.authUser.id, body);
    await log(request, "aiv_opportunity_updated", b.id, { opportunityId: param(request, "opportunityId"), status: body.status, assigned: body.ownerId !== undefined, note: !!body.note });
    return reply.send({ data: r });
  }));

  // ─── Imports ───────────────────────────────────────────────────────────────
  const importLimit = config.AIV_IMPORT_MAX_BYTES * 1.5 + 4_096;
  const importContent = z.string().min(1).max(config.AIV_IMPORT_MAX_BYTES, `The file is larger than ${config.AIV_IMPORT_MAX_BYTES} bytes.`);
  fastify.post("/brands/:brandId/imports/preview", { preValidation: pv, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(z.object({ content: importContent, format: z.enum(["csv", "json"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    return reply.send({ data: await previewImport(request.orgId, b, body) });
  }));

  fastify.post("/brands/:brandId/imports", { preValidation: pv, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const body = parse(z.object({ content: importContent, format: z.enum(["csv", "json"]).optional(), filename: z.string().trim().max(255).optional(), sourceLabel: z.string().trim().min(1).max(80), createMissingQueries: z.boolean().default(true) }).strict(), request.body, reply);
    if (!body) return;
    const r = await importObservations(request.orgId, b, request.authUser.id, body);
    if (!r.duplicateImport) await log(request, "aiv_observations_imported", b.id, { importId: r.importId, inserted: r.inserted, rejected: r.rejected, duplicates: r.duplicates });
    return reply.status(r.duplicateImport ? 200 : 201).send({ data: r });
  }));

  fastify.get("/brands/:brandId/imports", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await listImports(request.orgId, b.id) })));

  // ─── AI-assisted analysis ──────────────────────────────────────────────────
  fastify.get("/brands/:brandId/ai/summaries", { preValidation: pv, preHandler: read }, withBrand(async (request, reply, b) => reply.send({ data: await listAiSummaries(request.orgId, b.id), meta: { available: aiAvailable() } })));

  fastify.post("/brands/:brandId/ai/summaries", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withBrand(async (request, reply, b) => {
    const r = await createAiSummary(request.orgId, b, request.authUser.id);
    await log(request, "aiv_ai_summary_created", b.id, { summaryId: r.id, model: r.model });
    return reply.status(201).send({ data: r });
  }));

  // ─── Export ────────────────────────────────────────────────────────────────
  fastify.get("/brands/:brandId/export", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, withBrand(async (request, reply, b) => {
    const q = parse(z.object({ kind: z.enum(["observations", "sources", "metrics"]) }).strict(), request.query, reply);
    if (!q) return;
    const csv = await exportCsv(request.orgId, b, q.kind);
    await log(request, "aiv_exported", b.id, { kind: q.kind });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="ai-visibility-${q.kind}-${b.id.slice(0, 8)}.csv"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(csv);
  }));
}
