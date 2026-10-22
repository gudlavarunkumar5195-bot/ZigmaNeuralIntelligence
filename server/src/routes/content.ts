import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CursorValidationError } from "../http/pagination.js";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getWebsite } from "../services/website.service.js";
import { CONTENT_RULES, RULES_VERSION } from "../content/core.js";
import {
  assignMember,
  ContentError,
  createBrief,
  createTopic,
  exportCsv,
  findingHistory,
  getBrief,
  getBriefRevision,
  getOpportunity,
  getPage,
  getTopic,
  listBriefs,
  listFindings,
  listOpportunities,
  listPages,
  listRuns,
  listTopics,
  overview,
  PAGE_SORTS,
  renameTopic,
  requestAudit,
  saveBriefRevision,
  setBriefStatus,
  suggestWithAi,
  thresholds,
  updateFinding,
  updateOpportunity,
  type Site,
} from "../services/content.service.js";

/**
 * Content intelligence API (mounted under /api/v1/websites). Every route:
 * authenticated, org member re-checked in the database, the website must
 * belong to the caller's organization (404 otherwise) and every query is
 * scoped by org_id and website_id. Writes need a non-viewer role, are
 * validated strictly, rate-limited where expensive and audited.
 */

const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);

export async function contentRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const pv = uuidParams("id", "pageId", "findingId", "opportunityId", "topicId", "briefId");
  // Expensive writes are limited per session (bearer token hash), not per shared IP.
  const perSession = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `content:${createHash("sha256").update(auth).digest("hex")}` : `content-ip:${request.ip}`;
  };

  function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data as z.infer<S>;
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "request"}: ${r.error.issues[0].message}` : "Invalid request" } });
    return undefined;
  }
  // Site lookup (404 across tenants) and safe errors around every handler.
  const withSite = (fn: (request: FastifyRequest, reply: FastifyReply, site: Site) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const w = await getWebsite((request.params as { id: string }).id, request.orgId);
    if (!w) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
    try {
      return await fn(request, reply, { id: w.id, orgId: request.orgId, domain: w.domain });
    } catch (err) {
      if (err instanceof ContentError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
      if (err instanceof CursorValidationError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
      throw err;
    }
  };
  const log = (request: FastifyRequest, site: Site, action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown> = {}) =>
    audit({ userId: request.authUser.id, orgId: site.orgId, requestId: request.id, action, resourceType, resourceId, result: "success", metadata: { websiteId: site.id, ...metadata } });

  fastify.get("/:id/content/overview", { preValidation: pv, preHandler: read }, withSite(async (_r, reply, site) =>
    reply.send({ data: { ...(await overview(site)), rules: Object.values(CONTENT_RULES), rulesVersion: RULES_VERSION, thresholds: thresholds() } })));

  // ─── Inventory ─────────────────────────────────────────────────────────────
  fastify.get("/:id/content/pages", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ search: z.string().trim().min(1).max(200).optional(), state: z.enum(["ok", "not_html", "http_error", "fetch_failed", "blocked_by_robots", "redirected", "not_reached"]).optional(), indexable: z.enum(["true", "false"]).optional(), severity: z.enum(["high", "medium", "low", "info"]).optional(), sort: z.enum(PAGE_SORTS).default("url"), limit: limit(200, 50), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listPages(site, { ...q, indexable: q.indexable === undefined ? undefined : q.indexable === "true" });
    return reply.send({ data: r.pages, meta: { total: r.total, offset: q.offset, limit: q.limit, searchConsole: r.searchConsole } });
  }));

  fastify.get("/:id/content/pages/:pageId", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => reply.send({ data: await getPage(site, (request.params as { pageId: string }).pageId) })));

  // ─── Analysis runs ─────────────────────────────────────────────────────────
  fastify.get("/:id/content/runs", { preValidation: pv, preHandler: read }, withSite(async (_r, reply, site) => reply.send({ data: await listRuns(site) })));

  fastify.post("/:id/content/runs", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const r = await requestAudit(site, request.authUser.id);
    if (!r.deduplicated) await log(request, site, "content_audit_requested", "content_audit_run", r.run.id);
    return reply.status(r.deduplicated ? 200 : 202).send({ data: r });
  }));

  // ─── Findings ──────────────────────────────────────────────────────────────
  fastify.get("/:id/content/findings", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ status: z.enum(["open", "in_progress", "resolved", "ignored"]).optional(), severity: z.enum(["high", "medium", "low", "info"]).optional(), category: z.string().regex(/^[a-z_]{1,40}$/).optional(), rule: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(), pageId: z.string().uuid().optional(), limit: limit(200, 50), cursor: z.string().max(500).optional() }).strict(), request.query, reply);
    if (!q) return;
    const r = await listFindings(site, q);
    return reply.send({ data: r.findings, meta: { nextCursor: r.nextCursor } });
  }));

  fastify.get("/:id/content/findings/:findingId/history", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => reply.send({ data: await findingHistory(site, (request.params as { findingId: string }).findingId) })));

  fastify.patch("/:id/content/findings/:findingId", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ status: z.enum(["open", "in_progress", "ignored"]), reason: z.string().trim().max(500).optional() }).strict(), request.body, reply);
    if (!body) return;
    const id = (request.params as { findingId: string }).findingId;
    const r = await updateFinding(site, id, request.authUser.id, body);
    await log(request, site, "content_finding_updated", "content_finding", id, r);
    return reply.send({ data: r });
  }));

  // ─── Opportunities ─────────────────────────────────────────────────────────
  fastify.get("/:id/content/opportunities", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ status: z.enum(["open", "in_progress", "done", "dismissed", "obsolete"]).optional(), kind: z.string().regex(/^[a-z_]{1,40}$/).optional(), minPriority: z.coerce.number().int().min(0).max(100).optional(), limit: limit(200, 50), offset }).strict(), request.query, reply);
    if (!q) return;
    const r = await listOpportunities(site, q);
    return reply.send({ data: r.opportunities, meta: { total: r.total, offset: q.offset, limit: q.limit } });
  }));

  fastify.get("/:id/content/opportunities/:opportunityId", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => reply.send({ data: await getOpportunity(site, (request.params as { opportunityId: string }).opportunityId) })));

  fastify.patch("/:id/content/opportunities/:opportunityId", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ status: z.enum(["open", "in_progress", "done", "dismissed"]).optional(), ownerId: z.string().uuid().nullable().optional(), feedback: z.enum(["useful", "not_useful"]).optional(), note: z.string().trim().max(1000).optional() }).strict().refine((b) => b.status || b.ownerId !== undefined || b.feedback, "nothing to update"), request.body, reply);
    if (!body) return;
    const id = (request.params as { opportunityId: string }).opportunityId;
    await updateOpportunity(site, id, request.authUser.id, body);
    await log(request, site, "content_opportunity_updated", "content_opportunity", id, { status: body.status ?? null, feedback: body.feedback ?? null });
    return reply.send({ data: await getOpportunity(site, id) });
  }));

  // ─── Topics ────────────────────────────────────────────────────────────────
  fastify.get("/:id/content/topics", { preValidation: pv, preHandler: read }, withSite(async (_r, reply, site) => reply.send({ data: await listTopics(site) })));

  fastify.post("/:id/content/topics", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120) }).strict(), request.body, reply);
    if (!body) return;
    const t = await createTopic(site, body.name);
    await log(request, site, "content_topic_created", "content_topic", t.id);
    return reply.status(201).send({ data: t });
  }));

  fastify.get("/:id/content/topics/:topicId", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => reply.send({ data: await getTopic(site, (request.params as { topicId: string }).topicId) })));

  fastify.patch("/:id/content/topics/:topicId", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120) }).strict(), request.body, reply);
    if (!body) return;
    const id = (request.params as { topicId: string }).topicId;
    await renameTopic(site, id, body.name);
    await log(request, site, "content_topic_renamed", "content_topic", id);
    return reply.send({ data: { renamed: true } });
  }));

  fastify.post("/:id/content/topics/:topicId/members", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ memberType: z.enum(["page", "query"]), memberKey: z.string().trim().min(1).max(300), action: z.enum(["assign", "exclude"]) }).strict()
      .refine((b) => b.memberType !== "page" || z.string().uuid().safeParse(b.memberKey).success, "memberKey must be a page id"), request.body, reply);
    if (!body) return;
    const id = (request.params as { topicId: string }).topicId;
    const r = await assignMember(site, id, body);
    await log(request, site, "content_topic_member_changed", "content_topic", id, { memberType: body.memberType, action: body.action });
    return reply.send({ data: r });
  }));

  // ─── Briefs ────────────────────────────────────────────────────────────────
  fastify.get("/:id/content/briefs", { preValidation: pv, preHandler: read }, withSite(async (_r, reply, site) => reply.send({ data: await listBriefs(site) })));

  fastify.post("/:id/content/briefs", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ pageId: z.string().uuid().optional(), topicId: z.string().uuid().optional(), opportunityId: z.string().uuid().optional(), title: z.string().trim().max(300).optional() }).strict(), request.body, reply);
    if (!body) return;
    const id = await createBrief(site, request.authUser.id, body);
    await log(request, site, "content_brief_created", "content_brief", id);
    return reply.status(201).send({ data: await getBrief(site, id) });
  }));

  fastify.get("/:id/content/briefs/:briefId", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => reply.send({ data: await getBrief(site, (request.params as { briefId: string }).briefId) })));

  fastify.get("/:id/content/briefs/:briefId/revisions/:revision", { preValidation: pv, preHandler: read }, withSite(async (request, reply, site) => {
    const rev = z.coerce.number().int().min(1).max(100_000).safeParse((request.params as { revision: string }).revision);
    if (!rev.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid revision" } });
    return reply.send({ data: await getBriefRevision(site, (request.params as { briefId: string }).briefId, rev.data) });
  }));

  fastify.put("/:id/content/briefs/:briefId", { preValidation: pv, preHandler: write, bodyLimit: 256_000 }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ baseRevision: z.number().int().min(1), body: z.record(z.unknown()), title: z.string().trim().max(300).optional(), note: z.string().trim().max(500).optional() }).strict(), request.body, reply);
    if (!body) return;
    const id = (request.params as { briefId: string }).briefId;
    const r = await saveBriefRevision(site, id, request.authUser.id, body);
    await log(request, site, "content_brief_revised", "content_brief", id, r);
    return reply.send({ data: await getBrief(site, id) });
  }));

  fastify.post("/:id/content/briefs/:briefId/status", { preValidation: pv, preHandler: write }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ status: z.enum(["draft", "in_review", "approved"]) }).strict(), request.body, reply);
    if (!body) return;
    const id = (request.params as { briefId: string }).briefId;
    const r = await setBriefStatus(site, id, request.authUser.id, body.status);
    await log(request, site, "content_brief_status_changed", "content_brief", id, r);
    return reply.send({ data: await getBrief(site, id) });
  }));

  fastify.post("/:id/content/briefs/:briefId/ai-suggestions", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: perSession } } }, withSite(async (request, reply, site) => {
    const body = parse(z.object({ baseRevision: z.number().int().min(1) }).strict(), request.body, reply);
    if (!body) return;
    const id = (request.params as { briefId: string }).briefId;
    const r = await suggestWithAi(site, id, request.authUser.id, body.baseRevision);
    await log(request, site, "content_brief_ai_suggested", "content_brief", id, r);
    return reply.send({ data: await getBrief(site, id) });
  }));

  // ─── Export ────────────────────────────────────────────────────────────────
  fastify.get("/:id/content/export", { preValidation: pv, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, withSite(async (request, reply, site) => {
    const q = parse(z.object({ kind: z.enum(["pages", "findings", "opportunities"]), status: z.string().regex(/^[a-z_]{1,20}$/).optional(), severity: z.enum(["high", "medium", "low", "info"]).optional() }).strict(), request.query, reply);
    if (!q) return;
    const csv = await exportCsv(site, q.kind, q);
    await log(request, site, "content_exported", "website", site.id, { kind: q.kind });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="content-${q.kind}-${site.id.slice(0, 8)}.csv"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(csv);
  }));
}
