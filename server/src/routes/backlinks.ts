import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { CursorValidationError } from "../http/pagination.js";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getWebsite } from "../services/website.service.js";
import { backlinkSources } from "../backlinks/providers.js";
import { SCORE_WEIGHTS } from "../backlinks/core.js";
import {
  backlinkGap,
  BacklinkError,
  createImport,
  exportCsv,
  getSummary,
  getVerificationJob,
  LINK_SORTS,
  LINK_STATES,
  listChanges,
  listDatasets,
  listLinks,
  listReferringDomains,
  opportunities,
  previewImport,
  requestVerification,
  type WebsiteRef,
} from "../services/backlinks.service.js";

/**
 * Backlink intelligence API (mounted under /api/v1/websites). Every route:
 * authenticated, org member re-checked in the database, the website must
 * belong to the caller's organization (404 otherwise), and every query is
 * scoped by org_id and website_id. Writes need a non-viewer role, are
 * rate-limited and audited. Data comes only from imports and our own checks.
 */

const domain = z.string().trim().min(3).max(253);
const competitorsParam = z.string().max(2_000).optional().transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5) : []));
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);

const importBody = z.object({
  csv: z.string().min(1),
  subject: z.enum(["own", "competitor"]),
  competitorDomain: domain.optional(),
  filename: z.string().trim().max(255).optional(),
  sourceLabel: z.string().trim().min(1).max(80),
  coverage: z.enum(["complete", "partial", "unknown"]),
  exportedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 86_400_000, "exportedAt must be a past date").optional(),
}).strict();
const previewBody = importBody.pick({ csv: true, subject: true, competitorDomain: true }).strict();

export async function backlinkRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const write = [authenticate, requireOrgMember, requireRole("owner", "admin", "member")];
  const importLimit = config.BACKLINK_IMPORT_MAX_BYTES * 1.5 + 4_096; // JSON escaping overhead

  async function site(request: FastifyRequest, reply: FastifyReply): Promise<WebsiteRef | null> {
    const id = (request.params as { id: string }).id;
    const w = await getWebsite(id, request.orgId);
    if (!w) {
      void reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
      return null;
    }
    return { id: w.id, orgId: request.orgId, domain: w.domain };
  }

  function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data as z.infer<S>;
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "request"}: ${r.error.issues[0].message}` : "Invalid request" } });
    return undefined;
  }

  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof BacklinkError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof CursorValidationError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    throw err;
  }

  const opts = { preValidation: uuidParams("id") };
  // Heavy writes are limited per session (bearer token hash), so one user cannot exhaust another's budget behind a shared IP.
  const perSession = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `backlinks:${createHash("sha256").update(auth).digest("hex")}` : `backlinks-ip:${request.ip}`;
  };

  fastify.get("/:id/backlinks/sources", { ...opts, preHandler: read }, async (request, reply) => {
    if (!(await site(request, reply))) return;
    return reply.send({ data: { sources: backlinkSources(), scoreWeights: SCORE_WEIGHTS, limits: { maxRows: config.BACKLINK_IMPORT_MAX_ROWS, maxBytes: config.BACKLINK_IMPORT_MAX_BYTES, staleAfterDays: config.BACKLINK_STALE_DAYS, verifyMaxLinks: config.BACKLINK_VERIFY_MAX_LINKS } } });
  });

  fastify.get("/:id/backlinks/summary", { ...opts, preHandler: read }, async (request, reply) => {
    const w = await site(request, reply);
    if (!w) return;
    return reply.send({ data: await getSummary(w) });
  });

  fastify.get("/:id/backlinks/datasets", { ...opts, preHandler: read }, async (request, reply) => {
    const w = await site(request, reply);
    if (!w) return;
    return reply.send({ data: await listDatasets(w) });
  });

  fastify.get("/:id/backlinks/links", { ...opts, preHandler: read }, async (request, reply) => {
    const q = parse(z.object({
      dataset: z.string().uuid().optional(), subject: domain.optional(), linkType: z.enum(["follow", "nofollow", "sponsored", "ugc", "unknown"]).optional(),
      state: z.enum(LINK_STATES).optional(), domain: domain.optional(), search: z.string().trim().min(1).max(200).optional(),
      sort: z.enum(LINK_SORTS).default("source_domain"), order: z.enum(["asc", "desc"]).default("asc"), limit: limit(200, 50), cursor: z.string().max(500).optional(),
    }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      const r = await listLinks(w, { datasetId: q.dataset, subject: q.subject, linkType: q.linkType, state: q.state, domain: q.domain?.toLowerCase(), search: q.search, sort: q.sort, order: q.order, limit: q.limit, cursor: q.cursor });
      return reply.send({ data: { dataset: r.dataset, links: r.links }, meta: { nextCursor: r.nextCursor } });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/:id/backlinks/referring-domains", { ...opts, preHandler: read }, async (request, reply) => {
    const q = parse(z.object({ dataset: z.string().uuid().optional(), subject: domain.optional(), search: z.string().trim().min(1).max(200).optional(), sort: z.enum(["links", "domain", "last_seen"]).default("links"), limit: limit(200, 50), offset }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    const r = await listReferringDomains(w, { datasetId: q.dataset, subject: q.subject, search: q.search, sort: q.sort, limit: q.limit, offset: q.offset });
    return reply.send({ data: { dataset: r.dataset, domains: r.domains }, meta: { total: r.total, offset: q.offset, limit: q.limit } });
  });

  fastify.get("/:id/backlinks/changes", { ...opts, preHandler: read }, async (request, reply) => {
    const q = parse(z.object({ type: z.enum(["new", "lost", "potentially_lost", "anchor_changed", "target_changed", "attributes_changed"]).optional(), subject: domain.optional(), limit: limit(200, 50), cursor: z.string().max(500).optional() }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      const r = await listChanges(w, q);
      return reply.send({ data: r.changes, meta: { nextCursor: r.nextCursor } });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/:id/backlinks/gap", { ...opts, preHandler: read, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const q = parse(z.object({ competitors: competitorsParam, category: z.enum(["shared", "competitor_only", "own_only"]).optional(), limit: limit(500, 100), offset }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      return reply.send({ data: await backlinkGap(w, q) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/:id/backlinks/opportunities", { ...opts, preHandler: read, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const q = parse(z.object({
      competitors: competitorsParam, topics: z.string().trim().max(500).optional(), kind: z.enum(["competitor_only", "reclaim"]).optional(),
      minScore: z.coerce.number().int().min(0).max(100).optional(), linkType: z.enum(["follow", "any"]).default("any"), limit: limit(200, 50), offset,
    }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      return reply.send({ data: await opportunities(w, q) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post("/:id/backlinks/imports/preview", { ...opts, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: perSession } } }, async (request, reply) => {
    const body = parse(previewBody, request.body, reply);
    if (!body) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      return reply.send({ data: previewImport(w, body) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post("/:id/backlinks/imports", { ...opts, preHandler: write, bodyLimit: importLimit, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: perSession } } }, async (request, reply) => {
    const body = parse(importBody, request.body, reply);
    if (!body) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      const r = await createImport(w, request.authUser.id, body);
      if (!r.duplicateImport) {
        await audit({ userId: request.authUser.id, orgId: w.orgId, requestId: request.id, action: "backlink_import_created", resourceType: "backlink_dataset", resourceId: r.dataset.id, result: "success",
          metadata: { websiteId: w.id, subject: r.dataset.subject_domain, accepted: r.dataset.rows_accepted, rejected: r.dataset.rows_rejected, changes: r.changes } });
      }
      return reply.status(r.duplicateImport ? 200 : 201).send({ data: r });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post("/:id/backlinks/verifications", { ...opts, preHandler: write, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parse(z.object({ datasetId: z.string().uuid() }).strict(), request.body, reply);
    if (!body) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      const r = await requestVerification(w, body.datasetId, request.authUser.id);
      if (!r.deduplicated) await audit({ userId: request.authUser.id, orgId: w.orgId, requestId: request.id, action: "backlink_verification_requested", resourceType: "backlink_dataset", resourceId: body.datasetId, result: "success", metadata: { websiteId: w.id, links: r.job.links_total } });
      return reply.status(r.deduplicated ? 200 : 202).send({ data: r });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/:id/backlinks/verifications/:jobId", { preValidation: uuidParams("id", "jobId"), preHandler: read }, async (request, reply) => {
    const w = await site(request, reply);
    if (!w) return;
    const job = await getVerificationJob(w, (request.params as { jobId: string }).jobId);
    if (!job) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Verification job not found" } });
    return reply.send({ data: job });
  });

  fastify.get("/:id/backlinks/export", { ...opts, preHandler: write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const q = parse(z.object({ kind: z.enum(["links", "referring_domains", "opportunities", "changes"]), subject: domain.optional(), competitors: competitorsParam }).strict(), request.query, reply);
    if (!q) return;
    const w = await site(request, reply);
    if (!w) return;
    try {
      const csv = await exportCsv(w, q.kind, { subject: q.subject, competitors: q.competitors });
      await audit({ userId: request.authUser.id, orgId: w.orgId, requestId: request.id, action: "backlink_exported", resourceType: "website", resourceId: w.id, result: "success", metadata: { kind: q.kind } });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="backlinks-${q.kind}-${w.id.slice(0, 8)}.csv"`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .send(csv);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
