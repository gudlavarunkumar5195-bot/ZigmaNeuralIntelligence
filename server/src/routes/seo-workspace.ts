import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getWebsite } from "../services/website.service.js";
import {
  actionHistory,
  aiAvailable,
  aiSummary,
  buildReport,
  EXPORT_DATASETS,
  exportCsv,
  getInsight,
  INSIGHT_STATUSES,
  integrationHealth,
  listActions,
  listInsights,
  overview,
  refreshInsights,
  renderMarkdown,
  REPORT_SECTIONS,
  updateAction,
  updateInsight,
  WorkspaceError,
  type Site,
} from "../services/seo-workspace.service.js";
import { ACTION_CATEGORIES, ACTION_SOURCES, ACTION_STATUSES, DateRangeError, INSIGHT_RULES, RANGE_PRESETS, resolveRange } from "../workspace/core.js";

/**
 * Unified SEO workspace API (mounted under /api/v1/websites). Every route:
 * authenticated, org member re-checked in the database; the website must
 * belong to the caller's organization (404 otherwise) and every source query
 * is scoped by org_id and website_id. Writes need a non-viewer role and are
 * audited. Nothing here calls an external provider except the optional,
 * explicitly requested AI summary.
 */

const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = { preset: z.enum(RANGE_PRESETS).default("28d"), from: day.optional(), to: day.optional(), compare: z.enum(["previous", "none"]).default("previous") };

export async function seoWorkspaceRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const pv = uuidParams("id", "insightId");
  const perSession = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `workspace:${createHash("sha256").update(auth).digest("hex")}` : `workspace-ip:${request.ip}`;
  };

  function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data as z.infer<S>;
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "request"}: ${r.error.issues[0].message}` : "Invalid request" } });
    return undefined;
  }
  const withSite = (fn: (request: FastifyRequest, reply: FastifyReply, site: Site) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const w = await getWebsite((request.params as { id: string }).id, request.orgId);
    if (!w) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
    try {
      return await fn(request, reply, { id: w.id, orgId: request.orgId, domain: w.domain, verified: !!w.verified });
    } catch (err) {
      if (err instanceof WorkspaceError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
      if (err instanceof DateRangeError) return reply.status(400).send({ error: { code: "INVALID_RANGE", message: err.message } });
      throw err;
    }
  };
  const log = (request: FastifyRequest, site: Site, action: string, resourceId: string | null, metadata: Record<string, unknown> = {}) =>
    audit({ userId: request.authUser.id, orgId: site.orgId, requestId: request.id, action, resourceType: "seo_workspace", resourceId, result: "success", metadata: { websiteId: site.id, ...metadata } });
  const rangeOf = (q: { preset: (typeof RANGE_PRESETS)[number]; from?: string; to?: string; compare: "previous" | "none" }) => resolveRange(q);

  fastify.get("/:id/seo-workspace/overview", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object(rangeQuery).strict(), request.query, reply);
    if (!q) return;
    return reply.header("cache-control", "no-store").send({ data: await overview(site, rangeOf(q)), meta: { ai: { available: aiAvailable() } } });
  }));

  fastify.get("/:id/seo-workspace/integrations", { preValidation: pv, preHandler: read }, withSite(async (_request, reply, site) =>
    reply.header("cache-control", "no-store").send({ data: await integrationHealth(site) })));

  // ─── Insights ──────────────────────────────────────────────────────────────
  fastify.get("/:id/seo-workspace/insights", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ status: z.enum(INSIGHT_STATUSES).optional(), module: z.enum(["search_console", "technical", "content", "rankings", "backlinks", "ai_visibility"]).optional(), ruleId: z.enum(Object.keys(INSIGHT_RULES) as [string, ...string[]]).optional(), search: z.string().trim().min(1).max(200).optional(), limit: limit(100, 25), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listInsights(site, q);
    return reply.send({ data: r.rows, meta: { total: r.total, lastRun: r.lastRun, rules: r.rules, formula: r.formula, limit: q.limit, offset: q.offset } });
  }));

  fastify.post("/:id/seo-workspace/insights/refresh", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 6, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object(rangeQuery).strict(), request.body, reply);
    if (!q) return;
    const r = await refreshInsights(site, rangeOf(q));
    await log(request, site, "seo_insights_refreshed", null, { detected: r.detected, preset: q.preset });
    return reply.send({ data: r });
  }));

  fastify.get("/:id/seo-workspace/insights/:insightId", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) =>
    reply.send({ data: await getInsight(site, (request.params as { insightId: string }).insightId) })));

  fastify.patch("/:id/seo-workspace/insights/:insightId", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ status: z.enum(["open", "in_progress", "resolved", "dismissed"]).optional(), note: z.string().trim().min(1).max(1000).optional() }).strict().refine((v) => v.status || v.note, "nothing to update"), request.body, reply);
    if (!body) return;
    const insightId = (request.params as { insightId: string }).insightId;
    const r = await updateInsight(site, insightId, request.authUser.id, body);
    await log(request, site, "seo_insight_updated", insightId, { status: body.status, note: !!body.note });
    return reply.send({ data: r });
  }));

  // ─── Actions ───────────────────────────────────────────────────────────────
  fastify.get("/:id/seo-workspace/actions", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ status: z.enum(["active", ...ACTION_STATUSES]).default("active"), category: z.enum(ACTION_CATEGORIES).optional(), source: z.enum(ACTION_SOURCES).optional(), search: z.string().trim().min(1).max(200).optional(), ownerId: z.string().uuid().optional(), limit: limit(100, 25), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listActions(site, { ...q, statuses: q.status === "active" ? ["open", "in_progress"] : [q.status] });
    return reply.send({ data: r.items, meta: { total: r.total, openByCategory: r.openByCategory, limit: q.limit, offset: q.offset, effortNote: "Effort is a heuristic by kind of work." } });
  }));

  const actionRef = z.object({ source: z.enum(ACTION_SOURCES), sourceRef: z.string().trim().min(1).max(300) });
  fastify.get("/:id/seo-workspace/actions/history", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const q = parse(actionRef.strict(), request.query, reply);
    if (!q) return;
    return reply.send({ data: await actionHistory(site, q.source, q.sourceRef) });
  }));

  fastify.patch("/:id/seo-workspace/actions", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const body = parse(actionRef.extend({ status: z.enum(ACTION_STATUSES).optional(), ownerId: z.string().uuid().nullable().optional(), dueDate: day.nullable().optional(), note: z.string().trim().min(1).max(1000).optional() }).strict().refine((v) => v.status || v.ownerId !== undefined || v.dueDate !== undefined || v.note, "nothing to update"), request.body, reply);
    if (!body) return;
    const r = await updateAction(site, request.authUser.id, body);
    await log(request, site, "seo_action_updated", r.stateId, { source: body.source, status: body.status, assigned: body.ownerId !== undefined, dueDate: body.dueDate !== undefined });
    return reply.send({ data: r });
  }));

  // ─── Report, exports, AI summary ───────────────────────────────────────────
  const reportQuery = z.object({ ...rangeQuery, sections: z.string().max(200).optional() }).strict();
  const sectionsOf = (s?: string) => {
    const list = s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [...REPORT_SECTIONS];
    const bad = list.filter((x) => !(REPORT_SECTIONS as readonly string[]).includes(x));
    if (bad.length) throw new WorkspaceError(400, "VALIDATION_ERROR", `Unknown report section: ${bad.join(", ")}`);
    return list;
  };

  fastify.get("/:id/seo-workspace/report", { preValidation: pv, preHandler: read, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(reportQuery, request.query, reply);
    if (!q) return;
    return reply.header("cache-control", "no-store").send({ data: await buildReport(site, rangeOf(q), sectionsOf(q.sections)) });
  }));

  fastify.get("/:id/seo-workspace/report.md", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(reportQuery, request.query, reply);
    if (!q) return;
    const report = await buildReport(site, rangeOf(q), sectionsOf(q.sections));
    await log(request, site, "seo_report_exported", null, { format: "markdown", from: report.range.from, to: report.range.to });
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="seo-report-${site.id.slice(0, 8)}-${report.range.from}-${report.range.to}.md"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(renderMarkdown(report));
  }));

  fastify.get("/:id/seo-workspace/export", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ ...rangeQuery, dataset: z.enum(EXPORT_DATASETS) }).strict(), request.query, reply);
    if (!q) return;
    const range = rangeOf(q);
    const csv = await exportCsv(site, range, q.dataset);
    await log(request, site, "seo_workspace_exported", null, { dataset: q.dataset });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="seo-${q.dataset}-${site.id.slice(0, 8)}-${range.from}-${range.to}.csv"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(csv);
  }));

  fastify.post("/:id/seo-workspace/summary", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object(rangeQuery).strict(), request.body, reply);
    if (!q) return;
    const r = await aiSummary(site, rangeOf(q), request.authUser.id);
    await log(request, site, "seo_ai_summary_created", null, { model: r.model, dropped: r.dropped });
    return reply.send({ data: r });
  }));
}
