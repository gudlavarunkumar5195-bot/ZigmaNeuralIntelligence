import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { parsePagination } from "../http/pagination.js";
import { getWebsite } from "../services/website.service.js";
import { audit } from "../services/audit.service.js";
import {
  getIssueHistory,
  getLatestCrawlSummary,
  listCrawlPages,
  listIssues,
  PAGE_STATUS_FILTERS,
  setIssueIgnored,
} from "../services/site-audit.service.js";

/**
 * Technical site audit API (mounted under /api/v1/websites).
 * Every route: authenticated, org member (re-checked in the database), the
 * website must belong to the caller's organization, and every query filters
 * on org_id. Writes require a non-viewer role and are audited.
 */

const issueFilterSchema = z.object({
  status: z.enum(["OPEN", "FIXED", "IGNORED"]).optional(),
  rule: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
});
const pageFilterSchema = z.object({ status: z.enum(PAGE_STATUS_FILTERS).optional() });
const ignoreSchema = z.object({ reason: z.string().trim().min(1).max(500) });

function notFound(reply: import("fastify").FastifyReply, what = "Website") {
  return reply.status(404).send({ error: { code: "NOT_FOUND", message: `${what} not found` } });
}

export async function siteAuditRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  fastify.addHook("preValidation", uuidParams("id", "issueId"));

  // GET /api/v1/websites/:id/crawl — latest crawl summary
  fastify.get("/:id/crawl", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const summary = await getLatestCrawlSummary(request.orgId, id);
    return reply.send({ data: summary });
  });

  // GET /api/v1/websites/:id/crawl/pages?status=4xx&page=&pageSize=
  fastify.get("/:id/crawl/pages", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filters = pageFilterSchema.safeParse(request.query ?? {});
    if (!filters.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid page filter" } });
    const pagination = parsePagination(request.query);
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const summary = await getLatestCrawlSummary(request.orgId, id);
    if (!summary) return reply.send({ data: [], meta: { ...pagination, scanId: null } });
    const pages = await listCrawlPages(request.orgId, summary.scan_id as string, { statusClass: filters.data.status }, pagination);
    return reply.send({ data: pages, meta: { ...pagination, scanId: summary.scan_id } });
  });

  // GET /api/v1/websites/:id/issues?status=&rule=&severity=&page=&pageSize=
  fastify.get("/:id/issues", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filters = issueFilterSchema.safeParse(request.query ?? {});
    if (!filters.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid issue filter" } });
    const pagination = parsePagination(request.query);
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const { issues, counts } = await listIssues(
      request.orgId,
      id,
      { status: filters.data.status, ruleId: filters.data.rule, severity: filters.data.severity },
      pagination,
    );
    return reply.send({ data: issues, meta: { ...pagination, counts } });
  });

  // GET /api/v1/websites/:id/issues/:issueId/history
  fastify.get("/:id/issues/:issueId/history", { preHandler: read }, async (request, reply) => {
    const { id, issueId } = request.params as { id: string; issueId: string };
    if (!(await getWebsite(id, request.orgId))) return notFound(reply);
    const history = await getIssueHistory(request.orgId, id, issueId);
    if (!history) return notFound(reply, "Issue");
    return reply.send({ data: history });
  });

  const transition = (ignore: boolean) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const { id, issueId } = request.params as { id: string; issueId: string };
    let reason: string | undefined;
    if (ignore) {
      const parsed = ignoreSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "A reason (1-500 characters) is required to ignore an issue" } });
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
