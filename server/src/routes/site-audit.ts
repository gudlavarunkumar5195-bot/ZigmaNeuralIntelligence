import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { parseCursorPagination } from "../http/pagination.js";
import { getWebsite } from "../services/website.service.js";
import { audit } from "../services/audit.service.js";
import {
  getCrawlOverview,
  getIssue,
  getIssueHistory,
  ISSUE_CATEGORIES,
  listCrawlPages,
  listIssues,
  PAGE_OUTCOMES,
  PAGE_STATUS_FILTERS,
  setIssueIgnored,
} from "../services/site-audit.service.js";

/**
 * Technical site audit API (mounted under /api/v1/websites).
 * Every route: authenticated, org member (re-checked in the database), the
 * website must belong to the caller's organization (otherwise 404, never
 * 403, so other tenants' ids are not confirmed), and every query filters on
 * org_id. The organization only ever comes from the verified x-org-id
 * membership, never from a body. Writes require a non-viewer role, are
 * row-locked and audited.
 */

const urlContains = z.string().trim().min(1).max(200).optional();
const issueFilterSchema = z.object({
  status: z.enum(["OPEN", "FIXED", "IGNORED"]).optional(),
  rule: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  category: z.enum(ISSUE_CATEGORIES as [string, ...string[]]).optional(),
  url: urlContains,
  limit: z.unknown().optional(),
  cursor: z.unknown().optional(),
}).strict();
const pageFilterSchema = z.object({
  status: z.enum(PAGE_STATUS_FILTERS).optional(),
  outcome: z.enum(PAGE_OUTCOMES).optional(),
  indexable: z.enum(["true", "false"]).optional(),
  url: urlContains,
  limit: z.unknown().optional(),
  cursor: z.unknown().optional(),
}).strict();
const ignoreSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

function notFound(reply: FastifyReply, what = "Website") {
  return reply.status(404).send({ error: { code: "NOT_FOUND", message: `${what} not found` } });
}
function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message } });
}

export async function siteAuditRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  fastify.addHook("preValidation", uuidParams("id", "issueId"));

  // GET /api/v1/websites/:id/crawl — latest crawl, the previous one, what the
  // latest changed, and the most recent crawl scan (may still be running).
  fastify.get("/:id/crawl", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const overview = await getCrawlOverview(request.orgId, id);
    return reply.send({ data: overview.latest, meta: { previous: overview.previous, changes: overview.changes, latestScan: overview.latestScan } });
  });

  // GET /api/v1/websites/:id/crawl/pages?status=&outcome=&indexable=&url=&limit=&cursor=
  fastify.get("/:id/crawl/pages", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filters = pageFilterSchema.safeParse(request.query ?? {});
    if (!filters.success) return invalid(reply, "Invalid page filter");
    const page = parseCursorPagination(request.query);
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const overview = await getCrawlOverview(request.orgId, id);
    if (!overview.latest) return reply.send({ data: [], meta: { limit: page.limit, nextCursor: null, scanId: null } });
    const scanId = overview.latest.scan_id as string;
    const { pages, nextCursor } = await listCrawlPages(
      request.orgId,
      scanId,
      {
        statusClass: filters.data.status,
        outcome: filters.data.outcome,
        indexable: filters.data.indexable === undefined ? undefined : filters.data.indexable === "true",
        urlContains: filters.data.url,
      },
      page,
    );
    return reply.send({ data: pages, meta: { limit: page.limit, nextCursor, scanId } });
  });

  // GET /api/v1/websites/:id/issues?status=&severity=&category=&rule=&url=&limit=&cursor=
  fastify.get("/:id/issues", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filters = issueFilterSchema.safeParse(request.query ?? {});
    if (!filters.success) return invalid(reply, "Invalid issue filter");
    const page = parseCursorPagination(request.query);
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const { issues, counts, total, nextCursor } = await listIssues(
      request.orgId,
      id,
      {
        status: filters.data.status,
        ruleId: filters.data.rule,
        severity: filters.data.severity,
        category: filters.data.category as (typeof ISSUE_CATEGORIES)[number] | undefined,
        urlContains: filters.data.url,
      },
      page,
    );
    return reply.send({ data: issues, meta: { limit: page.limit, nextCursor, counts, total } });
  });

  // GET /api/v1/websites/:id/issues/:issueId
  fastify.get("/:id/issues/:issueId", { preHandler: read }, async (request, reply) => {
    const { id, issueId } = request.params as { id: string; issueId: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const issue = await getIssue(request.orgId, id, issueId);
    if (!issue) return notFound(reply, "Issue");
    return reply.send({ data: issue });
  });

  // GET /api/v1/websites/:id/issues/:issueId/history
  fastify.get("/:id/issues/:issueId/history", { preHandler: read }, async (request, reply) => {
    const { id, issueId } = request.params as { id: string; issueId: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const history = await getIssueHistory(request.orgId, id, issueId);
    if (!history) return notFound(reply, "Issue");
    return reply.send({ data: history });
  });

  const transition = (ignore: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, issueId } = request.params as { id: string; issueId: string };
    let reason: string | undefined;
    if (ignore) {
      const parsed = ignoreSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, "A reason (1-500 characters) is required to ignore an issue");
      reason = parsed.data.reason;
    }
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const updated = await setIssueIgnored({ orgId: request.orgId, websiteId: id, issueId, actorId: request.authUser.id, ignore, reason });
    if (!updated) return notFound(reply, "Issue");
    await audit({
      userId: request.authUser.id,
      orgId: request.orgId,
      action: ignore ? "site_issue_ignored" : "site_issue_reopened",
      resourceType: "site_issue",
      resourceId: issueId,
      result: "success",
      metadata: { websiteId: id },
    });
    return reply.send({ data: updated });
  };

  // POST /api/v1/websites/:id/issues/:issueId/ignore  { reason }
  fastify.post("/:id/issues/:issueId/ignore", { preHandler: write }, transition(true));
  // POST /api/v1/websites/:id/issues/:issueId/reopen
  fastify.post("/:id/issues/:issueId/reopen", { preHandler: write }, transition(false));
}
