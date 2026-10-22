import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { parseCursorPagination } from "../http/pagination.js";
import { getWebsite } from "../services/website.service.js";
import {
  allowedRange,
  cancelSync,
  daysBetween,
  getLinkStatus,
  getProperty,
  isDay,
  linkProperty,
  listJobFailures,
  listSyncJobs,
  requestSync,
  todayPT,
  unlinkProperty,
} from "../services/search-console.service.js";
import { BREAKDOWNS, compareMetrics, MAX_RANGE_DAYS, performance, SORTS, topRows, type BreakdownDimension } from "../services/search-performance.service.js";
import { sendIntegrationError } from "./integrations.js";

/**
 * Search Console data per website (mounted under /api/v1/websites). Website
 * lookups are org-scoped (another org's id is a 404). Linking needs
 * owner/admin; syncing needs a non-viewer role; reading needs membership.
 */

const day = z.string().refine(isDay, "must be YYYY-MM-DD");
const linkSchema = z.object({ integrationId: z.string().uuid(), siteUrl: z.string().trim().min(1).max(2048) }).strict();
const syncSchema = z.object({ from: day.optional(), to: day.optional() }).strict().refine((b) => !!b.from === !!b.to, "from and to go together");
const rangeSchema = z.object({ from: day, to: day, compareFrom: day.optional(), compareTo: day.optional() });
const perfSchema = rangeSchema.extend({
  query: z.string().max(2048).optional(),
  page: z.string().max(2048).optional(),
  country: z.string().regex(/^[a-z]{3}$/).optional(),
  device: z.enum(["DESKTOP", "MOBILE", "TABLET"]).optional(),
  searchAppearance: z.string().max(100).optional(),
}).strict();
const topSchema = z.object({
  from: day, to: day,
  sort: z.enum(SORTS).default("clicks"),
  order: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.unknown().optional(),
  cursor: z.unknown().optional(),
}).strict();

function checkRange(from: string, to: string): string | null {
  if (from > to) return "from must be on or before to";
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return `ranges are limited to ${MAX_RANGE_DAYS} days`;
  if (from < allowedRange().min) return "Search Console keeps about 16 months of data";
  if (to > todayPT()) return "the range cannot end in the future (Search Console dates are Pacific Time)";
  return null;
}

export async function searchConsoleRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const member = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const manage = [authenticate, requireOrgMember, requireRole("owner", "admin")];
  fastify.addHook("preValidation", uuidParams("id", "jobId"));
  const bad = (reply: import("fastify").FastifyReply, message: string, code = "VALIDATION_ERROR") => reply.status(400).send({ error: { code, message } });
  const notFound = (reply: import("fastify").FastifyReply, what = "Website") => reply.status(404).send({ error: { code: "NOT_FOUND", message: `${what} not found` } });
  const notLinked = (reply: import("fastify").FastifyReply) => reply.status(404).send({ error: { code: "SEARCH_CONSOLE_NOT_LINKED", message: "No Search Console property is linked to this website" } });

  // GET /api/v1/websites/:id/search-console — link, Google account, freshness, jobs
  fastify.get("/:id/search-console", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const website = await getWebsite(id, request.orgId);
    if (!website) return notFound(reply);
    const status = await getLinkStatus(request.orgId, id);
    return reply.send({ data: status, meta: { websiteVerified: website.verified } });
  });

  // PUT /api/v1/websites/:id/search-console { integrationId, siteUrl }
  fastify.put("/:id/search-console", { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = linkSchema.safeParse(request.body ?? {});
    if (!body.success) return bad(reply, "integrationId (uuid) and siteUrl are required");
    try {
      const linked = await linkProperty({ orgId: request.orgId, websiteId: id, integrationId: body.data.integrationId, siteUrl: body.data.siteUrl, actorId: request.authUser.id });
      if (!linked) return notFound(reply);
      return reply.send({ data: linked });
    } catch (err) {
      return sendIntegrationError(reply, err);
    }
  });

  // DELETE /api/v1/websites/:id/search-console — unlink and delete stored data
  fastify.delete("/:id/search-console", { preHandler: manage }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    if (!(await unlinkProperty(request.orgId, id, request.authUser.id))) return notLinked(reply);
    return reply.status(204).send();
  });

  // POST /api/v1/websites/:id/search-console/sync { from?, to? } — one active sync per property
  fastify.post("/:id/search-console/sync", { preHandler: member, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = syncSchema.safeParse(request.body ?? {});
    if (!body.success) return bad(reply, "from and to must both be YYYY-MM-DD dates", "INVALID_DATE_RANGE");
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    try {
      const { job, deduplicated } = await requestSync({ orgId: request.orgId, websiteId: id, actorId: request.authUser.id, kind: "manual", from: body.data.from, to: body.data.to });
      return reply.status(deduplicated ? 200 : 202).send({ data: job, meta: { deduplicated } });
    } catch (err) {
      return sendIntegrationError(reply, err);
    }
  });

  // GET /api/v1/websites/:id/search-console/sync-jobs?limit=&cursor=
  fastify.get("/:id/search-console/sync-jobs", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const page = parseCursorPagination(request.query);
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const result = await listSyncJobs(request.orgId, id, page);
    if (!result) return notLinked(reply);
    return reply.send({ data: result.jobs, meta: { limit: page.limit, nextCursor: result.nextCursor } });
  });

  // GET /api/v1/websites/:id/search-console/sync-jobs/:jobId/failures
  fastify.get("/:id/search-console/sync-jobs/:jobId/failures", { preHandler: read }, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const property = await getProperty(request.orgId, id);
    if (!property) return notLinked(reply);
    const jobs = await listSyncJobs(request.orgId, id, { limit: 100 });
    if (!jobs?.jobs.some((j) => (j as { id: string }).id === jobId)) return notFound(reply, "Sync");
    return reply.send({ data: await listJobFailures(request.orgId, jobId) });
  });

  // POST /api/v1/websites/:id/search-console/sync-jobs/:jobId/cancel
  fastify.post("/:id/search-console/sync-jobs/:jobId/cancel", { preHandler: member }, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    try {
      const job = await cancelSync(request.orgId, id, jobId);
      if (!job) return notFound(reply, "Sync");
      return reply.send({ data: job });
    } catch (err) {
      return sendIntegrationError(reply, err);
    }
  });

  // GET /api/v1/websites/:id/search-console/performance?from=&to=[&compareFrom=&compareTo=][&query=|page=|country=|device=|searchAppearance=]
  fastify.get("/:id/search-console/performance", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = perfSchema.safeParse(request.query ?? {});
    if (!parsed.success) return bad(reply, "Invalid parameters: from/to are YYYY-MM-DD; filters are query, page, country (ISO 3166-1 alpha-3, lowercase), device (DESKTOP|MOBILE|TABLET) or searchAppearance");
    const p = parsed.data;
    const rangeError = checkRange(p.from, p.to);
    if (rangeError) return bad(reply, rangeError, "INVALID_DATE_RANGE");
    if (!!p.compareFrom !== !!p.compareTo) return bad(reply, "compareFrom and compareTo go together", "INVALID_DATE_RANGE");
    if (p.compareFrom && p.compareTo) {
      const e = checkRange(p.compareFrom, p.compareTo);
      if (e) return bad(reply, `compare range: ${e}`, "INVALID_DATE_RANGE");
    }
    const filters = (["query", "page", "country", "device", "searchAppearance"] as const).filter((k) => p[k] !== undefined);
    // Each stored breakdown is date x one dimension; combining filters would need data we do not fetch.
    if (filters.length > 1) return bad(reply, "Filter by one of query, page, country, device or searchAppearance at a time", "UNSUPPORTED_DIMENSIONS");
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const property = await getProperty(request.orgId, id);
    if (!property) return notLinked(reply);
    const filter = filters[0] ? { dimension: filters[0] as BreakdownDimension, value: p[filters[0]]! } : undefined;
    const current = await performance({ orgId: request.orgId, propertyId: property.id, from: p.from, to: p.to, filter });
    const previous = p.compareFrom && p.compareTo ? await performance({ orgId: request.orgId, propertyId: property.id, from: p.compareFrom, to: p.compareTo, filter }) : null;
    return reply.send({
      data: { current, previous, comparison: previous ? compareMetrics(current.totals, previous.totals) : null },
      meta: { source: "google_search_console", siteUrl: property.site_url, searchType: "web", firstIncompleteDate: property.first_incomplete_date, lastSyncSuccessAt: property.last_sync_success_at },
    });
  });

  // GET /api/v1/websites/:id/search-console/top/:dimension?from=&to=&sort=&order=&search=&limit=&cursor=
  fastify.get("/:id/search-console/top/:dimension", { preHandler: read }, async (request, reply) => {
    const { id, dimension } = request.params as { id: string; dimension: string };
    if (!BREAKDOWNS.includes(dimension as BreakdownDimension)) return bad(reply, `dimension must be one of ${BREAKDOWNS.join(", ")}`, "UNSUPPORTED_DIMENSIONS");
    const parsed = topSchema.safeParse(request.query ?? {});
    if (!parsed.success) return bad(reply, "Invalid parameters: from/to are YYYY-MM-DD; sort is clicks|impressions|ctr|position; order asc|desc");
    const page = parseCursorPagination(request.query);
    const rangeError = checkRange(parsed.data.from, parsed.data.to);
    if (rangeError) return bad(reply, rangeError, "INVALID_DATE_RANGE");
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const property = await getProperty(request.orgId, id);
    if (!property) return notLinked(reply);
    const result = await topRows({ orgId: request.orgId, propertyId: property.id, dimension: dimension as BreakdownDimension, ...parsed.data, limit: page.limit, cursor: page.cursor });
    return reply.send({
      data: result.rows,
      meta: { limit: page.limit, nextCursor: result.nextCursor, coverage: result.coverage, source: "google_search_console", firstIncompleteDate: property.first_incomplete_date },
    });
  });
}
