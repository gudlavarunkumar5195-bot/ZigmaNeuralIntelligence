import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { parseCursorPagination } from "../http/pagination.js";
import { config } from "../config.js";
import { isValidKeyword, MAX_KEYWORD_LENGTH } from "../research/keywords.js";
import { capabilityMatrix } from "../research/providers/registry.js";
import { CAPABILITIES, METRICS, ResearchError } from "../research/providers/types.js";
import {
  addListItems,
  compareRuns,
  createKeywordList,
  deleteKeywordList,
  exportRunCsv,
  getKeywordList,
  getRunRow,
  listKeywordLists,
  listResults,
  listRuns,
  MAX_COMPETITORS,
  MAX_OVERVIEW_KEYWORDS,
  removeListItem,
  RESULT_SORTS,
  RUN_KINDS,
  runResearch,
  type RunKind,
} from "../services/keyword-research.service.js";
import { generateInsights, getInsights } from "../services/research-insights.service.js";
import { audit } from "../services/audit.service.js";

/**
 * Keyword research API (mounted under /api/v1/keyword-research). The
 * organization comes from the verified membership only; every run, result,
 * list and website lookup filters on it (other organizations' ids are 404).
 * Running research (which uses quota and provider calls), exporting and
 * editing lists need a non-viewer role.
 */

const keyword = z.string().max(MAX_KEYWORD_LENGTH * 2).refine(isValidKeyword, "invalid keyword");
const domain = z.string().trim().toLowerCase().max(253).regex(/^(https?:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,63}\/?$/, "invalid domain");
const base = {
  websiteId: z.string().uuid(),
  provider: z.string().max(64).optional(),
  limit: z.number().int().min(1).optional(),
  country: z.string().regex(/^[a-z]{2}$/).optional(),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  device: z.enum(["desktop", "mobile", "tablet"]).optional(),
};
const BODIES: Record<RunKind, z.ZodTypeAny> = {
  overview: z.object({ ...base, keyword: keyword.optional(), keywords: z.array(keyword).min(1).max(MAX_OVERVIEW_KEYWORDS).optional() }).strict()
    .refine((b) => !!b.keyword !== !!b.keywords, "give keyword or keywords"),
  ideas: z.object({ ...base, seed: keyword }).strict(),
  related: z.object({ ...base, keyword }).strict(),
  organic: z.object({ ...base }).strict(),
  gap: z.object({ ...base, competitors: z.array(domain).min(1).max(MAX_COMPETITORS) }).strict(),
};
const runsQuery = z.object({ websiteId: z.string().uuid().optional(), kind: z.enum(RUN_KINDS).optional(), limit: z.unknown().optional(), cursor: z.unknown().optional() }).strict();
const resultsQuery = z.object({
  sort: z.enum(RESULT_SORTS).default("seq"),
  order: z.enum(["asc", "desc"]).default("asc"),
  intent: z.enum(["informational", "navigational", "commercial", "transactional", "unclassified"]).optional(),
  gap: z.enum(["shared", "missing", "unique"]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.unknown().optional(),
  cursor: z.unknown().optional(),
}).strict();
const listSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const itemsSchema = z.object({ runId: z.string().uuid(), keywords: z.array(keyword).min(1).max(500) }).strict();

export function sendResearchError(reply: FastifyReply, err: unknown) {
  if (err instanceof ResearchError) {
    const runId = (err as { runId?: string }).runId;
    if (err.code === "QUOTA_EXCEEDED") reply.header("Retry-After", "3600");
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...(runId ? { runId } : {}) } });
  }
  throw err;
}

export async function keywordResearchRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const member = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  fastify.addHook("preValidation", uuidParams("id", "otherId", "listId"));
  const notFound = (reply: FastifyReply, what = "Research run") => reply.status(404).send({ error: { code: "NOT_FOUND", message: `${what} not found` } });
  const invalid = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: "VALIDATION_ERROR", message } });

  // GET /api/v1/keyword-research/capabilities
  fastify.get("/capabilities", { preHandler: read }, async (_request, reply) => {
    return reply.send({ data: { providers: capabilityMatrix(), capabilities: CAPABILITIES, metrics: METRICS, limits: { maxResults: config.KEYWORD_RESEARCH_MAX_RESULTS, runsPerDay: config.KEYWORD_RESEARCH_MAX_RUNS_PER_ORG_PER_DAY, maxCompetitors: MAX_COMPETITORS, maxOverviewKeywords: MAX_OVERVIEW_KEYWORDS } } });
  });

  // POST /api/v1/keyword-research/{overview|ideas|related|organic|gap}
  for (const kind of RUN_KINDS) {
    fastify.post(`/${kind}`, { preHandler: member, bodyLimit: 32_768, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
      const parsed = BODIES[kind].safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 500));
      const b = parsed.data as Record<string, unknown> & { websiteId: string; limit?: number };
      if (b.limit !== undefined && b.limit > (config.KEYWORD_RESEARCH_MAX_RESULTS ?? 500)) return invalid(reply, `limit must be at most ${config.KEYWORD_RESEARCH_MAX_RESULTS}`);
      try {
        const out = await runResearch({
          orgId: request.orgId,
          userId: request.authUser.id,
          websiteId: b.websiteId,
          kind,
          input: { keyword: b.keyword as string | undefined, keywords: b.keywords as string[] | undefined, seed: b.seed as string | undefined, competitors: b.competitors as string[] | undefined },
          targeting: { country: b.country as string | undefined, language: b.language as string | undefined, device: b.device as "desktop" | "mobile" | "tablet" | undefined },
          provider: b.provider as string | undefined,
          limit: b.limit,
        });
        if (!out) return notFound(reply, "Website");
        const run = await getRunRow(request.orgId, out.runId);
        const first = run && run.status !== "running" ? await listResults(request.orgId, out.runId, { sort: "seq", order: "asc", limit: 50 }) : { results: [], nextCursor: null };
        return reply.status(out.reused ? 200 : 201).send({ data: { run, results: first.results }, meta: { reused: out.reused, nextCursor: first.nextCursor } });
      } catch (err) {
        return sendResearchError(reply, err);
      }
    });
  }

  // GET /api/v1/keyword-research/runs?websiteId=&kind=&limit=&cursor=
  fastify.get("/runs", { preHandler: read }, async (request, reply) => {
    const q = runsQuery.safeParse(request.query ?? {});
    if (!q.success) return invalid(reply, "Invalid filters");
    const page = parseCursorPagination(request.query);
    const { runs, nextCursor } = await listRuns(request.orgId, { websiteId: q.data.websiteId, kind: q.data.kind }, page);
    return reply.send({ data: runs, meta: { limit: page.limit, nextCursor } });
  });

  // GET /api/v1/keyword-research/runs/:id?sort=&order=&intent=&gap=&search=&limit=&cursor=
  fastify.get("/runs/:id", { preHandler: read }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = resultsQuery.safeParse(request.query ?? {});
    if (!q.success) return invalid(reply, "Invalid result filters");
    const page = parseCursorPagination(request.query);
    const run = await getRunRow(request.orgId, id);
    if (!run) return notFound(reply);
    const { results, nextCursor } = await listResults(request.orgId, id, { sort: q.data.sort, order: q.data.order, intent: q.data.intent, gapCategory: q.data.gap, search: q.data.search, limit: page.limit, cursor: page.cursor });
    const provider = capabilityMatrix().find((p) => p.id === run.provider) ?? null;
    return reply.send({ data: { run, results, insight: await getInsights(request.orgId, id) }, meta: { limit: page.limit, nextCursor, provider } });
  });

  // GET /api/v1/keyword-research/runs/:id/compare/:otherId
  fastify.get("/runs/:id/compare/:otherId", { preHandler: read }, async (request, reply) => {
    const { id, otherId } = request.params as { id: string; otherId: string };
    try {
      const diff = await compareRuns(request.orgId, id, otherId);
      if (!diff) return notFound(reply);
      return reply.send({ data: diff });
    } catch (err) {
      return sendResearchError(reply, err);
    }
  });

  // GET /api/v1/keyword-research/runs/:id/export — CSV (non-viewer roles)
  fastify.get("/runs/:id/export", { preHandler: member, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const out = await exportRunCsv(request.orgId, id);
    if (!out) return notFound(reply);
    await audit({ userId: request.authUser.id, orgId: request.orgId, action: "keyword_research_exported", resourceType: "research_run", resourceId: id, result: "success" });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="keyword-research-${out.run.kind}-${id.slice(0, 8)}.csv"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(out.csv);
  });

  // POST /api/v1/keyword-research/runs/:id/insights — optional AI prioritization
  fastify.post("/runs/:id/insights", { preHandler: member, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const insight = await generateInsights(request.orgId, id, request.authUser.id);
      if (!insight) return notFound(reply);
      return reply.send({ data: insight });
    } catch (err) {
      return sendResearchError(reply, err);
    }
  });

  // Saved keyword lists
  fastify.get("/lists", { preHandler: read }, async (request, reply) => reply.send({ data: await listKeywordLists(request.orgId) }));

  fastify.post("/lists", { preHandler: member, bodyLimit: 4_096 }, async (request, reply) => {
    const b = listSchema.safeParse(request.body ?? {});
    if (!b.success) return invalid(reply, "name (1-100 characters) is required");
    try {
      return reply.status(201).send({ data: await createKeywordList(request.orgId, request.authUser.id, b.data.name) });
    } catch (err) {
      return sendResearchError(reply, err);
    }
  });

  fastify.get("/lists/:listId", { preHandler: read }, async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const list = await getKeywordList(request.orgId, listId);
    return list ? reply.send({ data: list }) : notFound(reply, "List");
  });

  fastify.post("/lists/:listId/items", { preHandler: member, bodyLimit: 65_536 }, async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const b = itemsSchema.safeParse(request.body ?? {});
    if (!b.success) return invalid(reply, "runId and 1-500 keywords are required");
    try {
      const out = await addListItems(request.orgId, request.authUser.id, listId, b.data.runId, b.data.keywords);
      return out ? reply.send({ data: out }) : notFound(reply, "List or research run");
    } catch (err) {
      return sendResearchError(reply, err);
    }
  });

  fastify.delete("/lists/:listId/items", { preHandler: member }, async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const k = (request.query as { keyword?: unknown })?.keyword;
    if (typeof k !== "string" || !isValidKeyword(k)) return invalid(reply, "keyword is required");
    return (await removeListItem(request.orgId, listId, k)) ? reply.status(204).send() : notFound(reply, "List item");
  });

  fastify.delete("/lists/:listId", { preHandler: member }, async (request, reply) => {
    const { listId } = request.params as { listId: string };
    return (await deleteKeywordList(request.orgId, listId)) ? reply.status(204).send() : notFound(reply, "List");
  });
}
