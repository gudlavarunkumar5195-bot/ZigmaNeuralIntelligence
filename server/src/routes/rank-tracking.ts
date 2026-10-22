import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { CursorValidationError } from "../http/pagination.js";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { rankSources } from "../ranking/providers.js";
import { KNOWN_FEATURES } from "../ranking/core.js";
import {
  acknowledgeAlert,
  addCompetitor,
  addKeywords,
  cancelJob,
  competitorComparison,
  createAlertRule,
  createProject,
  dashboard,
  exportCsv,
  importObservations,
  keywordHistory,
  listAlertEvents,
  listAlertRules,
  listCompetitors,
  listImports,
  listJobs,
  listKeywords,
  listProjects,
  listRankings,
  parseKeywordCsv,
  previewObservationImport,
  RankError,
  removeCompetitor,
  requestRefresh,
  requireProject,
  serpFeatures,
  setAlertRule,
  updateKeyword,
  updateProject,
  usageToday,
  validTimezone,
} from "../services/rank-tracking.service.js";

/**
 * Rank tracking API (mounted under /api/v1/rank-tracking). Every route:
 * authenticated, org member re-checked in the database (x-org-id); a project
 * is only found through the caller's organization (404 otherwise). Writes
 * need a non-viewer role, are validated strictly, rate-limited where
 * expensive and audited. Rankings come only from imports or a provider.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)), "invalid date");
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);

const projectBody = z.object({
  websiteId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  searchEngine: z.enum(["google", "bing"]),
  country: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).nullish(),
  language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/).nullish(),
  device: z.enum(["desktop", "mobile"]).nullish(),
  location: z.string().trim().min(1).max(200).nullish(),
  timezone: z.string().trim().min(1).max(64).refine(validTimezone, "unknown time zone").default("UTC"),
  frequency: z.enum(["manual", "daily", "weekly"]).default("manual"),
}).strict();

const ruleParams = z.object({
  position: z.coerce.number().int().min(1).max(100).optional(),
  direction: z.enum(["into", "out_of"]).optional(),
  positions: z.coerce.number().int().min(1).max(100).optional(),
  consecutive: z.coerce.number().int().min(1).max(10).optional(),
  competitor: z.string().trim().max(253).optional(),
}).strict();

export async function rankTrackingRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const pv = uuidParams("projectId", "keywordId", "ruleId", "eventId", "jobId");
  const perSession = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `rank:${createHash("sha256").update(auth).digest("hex")}` : `rank-ip:${request.ip}`;
  };

  function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data as z.infer<S>;
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "request"}: ${r.error.issues[0].message}` : "Invalid request" } });
    return undefined;
  }
  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof RankError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof CursorValidationError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    throw err;
  }
  const log = (request: FastifyRequest, action: string, resourceId: string | null, metadata: Record<string, unknown>) =>
    audit({ userId: request.authUser.id, orgId: request.orgId, requestId: request.id, action, resourceType: "rank_project", resourceId, result: "success", metadata });
  const project = (request: FastifyRequest) => requireProject(request.orgId, (request.params as { projectId: string }).projectId);

  // Wraps a handler: project lookup (404 across tenants) and safe errors.
  const withProject = <T>(fn: (request: FastifyRequest, reply: FastifyReply, p: Awaited<ReturnType<typeof project>>) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(request, reply, await project(request));
      } catch (err) {
        return fail(reply, err);
      }
    };

  fastify.get("/sources", { preHandler: read }, async (request, reply) =>
    reply.send({ data: { sources: rankSources(), usage: await usageToday(request.orgId), features: KNOWN_FEATURES, limits: { keywordsPerProject: config.RANK_MAX_KEYWORDS_PER_PROJECT, competitorsPerProject: config.RANK_MAX_COMPETITORS, requestsPerDay: config.RANK_MAX_REQUESTS_PER_ORG_PER_DAY, importRows: config.RANK_IMPORT_MAX_ROWS, importBytes: config.RANK_IMPORT_MAX_BYTES } } }));

  // ─── Projects ──────────────────────────────────────────────────────────────
  fastify.get("/projects", { preHandler: read }, async (request, reply) => {
    const q = parse(z.object({ websiteId: z.string().uuid().optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await listProjects(request.orgId, q.websiteId) });
  });

  fastify.post("/projects", { preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parse(projectBody, request.body, reply);
    if (!body) return;
    try {
      const p = await createProject(request.orgId, request.authUser.id, body);
      await log(request, "rank_project_created", p.id, { websiteId: p.website_id, searchEngine: p.search_engine, country: p.country, device: p.device, frequency: p.frequency });
      return reply.status(201).send({ data: p });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/projects/:projectId", { preValidation: pv, preHandler: read }, withProject(async (_req, reply, p) => reply.send({ data: p })));

  fastify.patch("/projects/:projectId", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), timezone: z.string().trim().max(64).refine(validTimezone, "unknown time zone").optional(), frequency: z.enum(["manual", "daily", "weekly"]).optional(), status: z.enum(["active", "paused", "archived"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    const updated = await updateProject(request.orgId, p.id, body);
    await log(request, "rank_project_updated", p.id, body);
    return reply.send({ data: updated });
  }));

  // ─── Keywords ──────────────────────────────────────────────────────────────
  fastify.get("/projects/:projectId/keywords", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ search: z.string().trim().min(1).max(200).optional(), group: z.string().trim().max(80).optional(), status: z.enum(["active", "paused"]).optional(), limit: limit(200, 50), cursor: z.string().max(500).optional() }).strict(), request.query, reply);
    if (!q) return;
    const r = await listKeywords(request.orgId, p.id, q);
    return reply.send({ data: r.keywords, meta: { nextCursor: r.nextCursor, groups: r.groups } });
  }));

  fastify.post("/projects/:projectId/keywords", { preValidation: pv, preHandler: write, bodyLimit: 512_000, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ keywords: z.array(z.object({ keyword: z.string().max(400), group: z.string().max(80).nullish(), landingPage: z.string().max(2048).nullish() }).strict()).min(1).max(1000) }).strict(), request.body, reply);
    if (!body) return;
    const r = await addKeywords(request.orgId, p, body.keywords, "manual", request.authUser.id);
    await log(request, "rank_keywords_added", p.id, { added: r.added, restored: r.restored });
    return reply.status(201).send({ data: r });
  }));

  fastify.post("/projects/:projectId/keywords/import", { preValidation: pv, preHandler: write, bodyLimit: 3_000_000, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: perSession } } }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ csv: z.string().min(1) }).strict(), request.body, reply);
    if (!body) return;
    const r = await addKeywords(request.orgId, p, parseKeywordCsv(body.csv), "csv", request.authUser.id);
    await log(request, "rank_keywords_imported", p.id, { added: r.added, restored: r.restored, invalid: r.invalid.length });
    return reply.status(201).send({ data: r });
  }));

  fastify.patch("/projects/:projectId/keywords/:keywordId", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ group: z.string().trim().max(80).nullable().optional(), landingPage: z.string().trim().max(2048).nullable().optional(), status: z.enum(["active", "paused"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    await updateKeyword(request.orgId, p, (request.params as { keywordId: string }).keywordId, body);
    return reply.send({ data: { updated: true } });
  }));

  // Removal keeps the keyword's history (soft delete) and needs explicit confirmation.
  fastify.delete("/projects/:projectId/keywords/:keywordId", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    if (!parse(z.object({ confirm: z.literal(true) }).strict(), request.body, reply)) return;
    const keywordId = (request.params as { keywordId: string }).keywordId;
    await updateKeyword(request.orgId, p, keywordId, { status: "removed" });
    await log(request, "rank_keyword_removed", p.id, { keywordId });
    return reply.send({ data: { removed: true } });
  }));

  // ─── Competitors ───────────────────────────────────────────────────────────
  fastify.get("/projects/:projectId/competitors", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => reply.send({ data: await listCompetitors(request.orgId, p.id) })));

  fastify.post("/projects/:projectId/competitors", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ domain: z.string().trim().min(3).max(253) }).strict(), request.body, reply);
    if (!body) return;
    const r = await addCompetitor(request.orgId, p, body.domain, request.authUser.id);
    if (r.added) await log(request, "rank_competitor_added", p.id, { domain: r.domain });
    return reply.status(r.added ? 201 : 200).send({ data: r });
  }));

  fastify.delete("/projects/:projectId/competitors/:domain", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const domain = z.string().regex(/^[a-z0-9.-]{1,253}$/).safeParse((request.params as { domain: string }).domain);
    if (!domain.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid domain" } });
    const r = await removeCompetitor(request.orgId, p.id, domain.data);
    if (r.removed) await log(request, "rank_competitor_removed", p.id, { domain: domain.data });
    return reply.send({ data: r });
  }));

  // ─── Observation imports ───────────────────────────────────────────────────
  const importLimit = config.RANK_IMPORT_MAX_BYTES * 1.5 + 4_096;
  fastify.post("/projects/:projectId/observations/preview", { preValidation: pv, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ csv: z.string().min(1) }).strict(), request.body, reply);
    if (!body) return;
    return reply.send({ data: await previewObservationImport(request.orgId, p, body.csv) });
  }));

  fastify.post("/projects/:projectId/observations/import", { preValidation: pv, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ csv: z.string().min(1), filename: z.string().trim().max(255).optional(), sourceLabel: z.string().trim().min(1).max(80), createMissingKeywords: z.boolean().default(true) }).strict(), request.body, reply);
    if (!body) return;
    const r = await importObservations(request.orgId, p, request.authUser.id, body);
    if (!r.duplicateImport) await log(request, "rank_observations_imported", p.id, { importId: r.importId, inserted: r.inserted, rejected: r.rejected, alerts: r.alertsCreated });
    return reply.status(r.duplicateImport ? 200 : 201).send({ data: r });
  }));

  fastify.get("/projects/:projectId/imports", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => reply.send({ data: await listImports(request.orgId, p.id) })));

  // ─── Rankings, history, features, competitors ─────────────────────────────
  fastify.get("/projects/:projectId/dashboard", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ group: z.string().trim().max(80).optional(), from: day.optional(), to: day.optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await dashboard(request.orgId, p, q) });
  }));

  fastify.get("/projects/:projectId/rankings", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ group: z.string().trim().max(80).optional(), change: z.enum(["improved", "declined", "unchanged", "entered", "dropped_out", "unavailable"]).optional(), search: z.string().trim().min(1).max(200).optional(), sort: z.enum(["keyword", "position", "change"]).default("keyword"), limit: limit(200, 50), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listRankings(request.orgId, p, q);
    return reply.send({ data: r.rows, meta: { total: r.total, limit: q.limit, offset: q.offset } });
  }));

  fastify.get("/projects/:projectId/keywords/:keywordId/history", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ from: day.optional(), to: day.optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await keywordHistory(request.orgId, p.id, (request.params as { keywordId: string }).keywordId, q) });
  }));

  fastify.get("/projects/:projectId/serp-features", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => reply.send({ data: await serpFeatures(request.orgId, p) })));

  fastify.get("/projects/:projectId/competitor-comparison", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ competitor: z.string().trim().max(253).optional() }).strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await competitorComparison(request.orgId, p, q.competitor) });
  }));

  // ─── Collection jobs ───────────────────────────────────────────────────────
  fastify.post("/projects/:projectId/refresh", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withProject(async (request, reply, p) => {
    const r = await requestRefresh(request.orgId, p, request.authUser.id);
    if (!r.deduplicated) await log(request, "rank_refresh_requested", p.id, { jobId: r.job.id, keywords: r.job.keywords_total });
    return reply.status(r.deduplicated ? 200 : 202).send({ data: r });
  }));

  fastify.get("/projects/:projectId/jobs", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => reply.send({ data: await listJobs(request.orgId, p.id) })));

  fastify.post("/projects/:projectId/jobs/:jobId/cancel", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const r = await cancelJob(request.orgId, p.id, jobId);
    if (r.cancelled) await log(request, "rank_job_cancelled", p.id, { jobId });
    return reply.send({ data: r });
  }));

  // ─── Alerts ────────────────────────────────────────────────────────────────
  fastify.get("/projects/:projectId/alert-rules", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => reply.send({ data: await listAlertRules(request.orgId, p.id) })));

  fastify.post("/projects/:projectId/alert-rules", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ type: z.enum(["threshold_cross", "position_change", "url_change", "became_unavailable", "competitor_overtake", "collection_failures"]), params: ruleParams.default({}), keywordId: z.string().uuid().nullish(), notify: z.enum(["in_app", "none"]).default("in_app") }).strict(), request.body, reply);
    if (!body) return;
    const rule = await createAlertRule(request.orgId, p, request.authUser.id, body);
    await log(request, "rank_alert_rule_created", p.id, { ruleId: rule.id, type: body.type });
    return reply.status(201).send({ data: rule });
  }));

  fastify.patch("/projects/:projectId/alert-rules/:ruleId", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), notify: z.enum(["in_app", "none"]).optional() }).strict(), request.body, reply);
    if (!body) return;
    const ruleId = (request.params as { ruleId: string }).ruleId;
    await setAlertRule(request.orgId, p.id, ruleId, body);
    await log(request, "rank_alert_rule_updated", p.id, { ruleId, ...body });
    return reply.send({ data: { updated: true } });
  }));

  fastify.get("/projects/:projectId/alerts", { preValidation: pv, preHandler: read }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ unacknowledged: z.enum(["true", "false"]).optional(), limit: limit(200, 50), cursor: z.string().max(500).optional() }).strict(), request.query, reply);
    if (!q) return;
    const r = await listAlertEvents(request.orgId, p.id, { unacknowledged: q.unacknowledged === "true", limit: q.limit, cursor: q.cursor });
    return reply.send({ data: r.events, meta: { nextCursor: r.nextCursor } });
  }));

  fastify.post("/projects/:projectId/alerts/:eventId/acknowledge", { preValidation: pv, preHandler: write }, withProject(async (request, reply, p) =>
    reply.send({ data: await acknowledgeAlert(request.orgId, p.id, (request.params as { eventId: string }).eventId, request.authUser.id) })));

  // ─── Export ────────────────────────────────────────────────────────────────
  fastify.get("/projects/:projectId/export", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, withProject(async (request, reply, p) => {
    const q = parse(z.object({ kind: z.enum(["rankings", "history", "keywords"]) }).strict(), request.query, reply);
    if (!q) return;
    const csv = await exportCsv(request.orgId, p, q.kind);
    await log(request, "rank_exported", p.id, { kind: q.kind });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="rank-${q.kind}-${p.id.slice(0, 8)}.csv"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(csv);
  }));
}
