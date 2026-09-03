import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { addWebsite, listWebsites, getWebsite, verifyOwnership, isQaBypassAuthorized, canonicalizeQaDomain, QA_CANONICAL_DOMAIN } from "../services/website.service.js";
import { audit } from "../services/audit.service.js";

const addWebsiteSchema = z.object({
  url: z.string().url(),
  verificationMethod: z.enum(["html", "dns", "file", "qa_bypass"]).default("html"),
  orgId: z.string().uuid().optional(),
});

export async function websiteRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [authenticate, requireOrgMember];

  // GET /api/v1/websites?orgId=...
  fastify.get("/", { preHandler }, async (request, reply) => {
    const websites = await listWebsites(request.orgId);
    return reply.send({ data: websites });
  });

  // GET /api/v1/websites/:id
  fastify.get("/:id", { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const website = await getWebsite(id, request.orgId);
    if (!website) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
    }
    return reply.send({ data: website });
  });

  // POST /api/v1/websites
  fastify.post("/", { preHandler: [authenticate, requireOrgMember, requireRole("owner", "admin", "member")] }, async (request, reply) => {
    const parsed = addWebsiteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    if (parsed.data.verificationMethod === "qa_bypass") {
      if (!isQaBypassAuthorized(request.authUser.email, request.authUser.role)) {
        return reply.status(403).send({ error: { code: "QA_BYPASS_FORBIDDEN", message: "QA verification is restricted to authorized QA administrators" } });
      }
      if (canonicalizeQaDomain(parsed.data.url) !== QA_CANONICAL_DOMAIN) {
        return reply.status(422).send({ error: { code: "QA_DOMAIN_NOT_ALLOWED", message: "QA verification is restricted to the approved test domain" } });
      }
    }

    let website;
    try {
      website = await addWebsite({
        orgId: request.orgId,
        userId: request.authUser.id,
        url: parsed.data.url,
        verificationMethod: parsed.data.verificationMethod,
      });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string; message: string };
      return reply.status(e.statusCode ?? 422).send({ error: { code: e.code, message: e.message } });
    }

    await audit({
      userId: request.authUser.id,
      orgId: request.orgId,
      action: "website_created",
      resourceType: "website",
      resourceId: website.id as unknown as string,
      result: "success",
      requestId: request.id,
      ...(parsed.data.verificationMethod === "qa_bypass" ? { action: "QA_WEBSITE_VERIFICATION_BYPASS", metadata: { domain: website.domain, verificationMethod: "qa_bypass", environment: "qa" } } : {}),
    });

    return reply.status(201).send({ data: website });
  });

  // POST /api/v1/websites/:id/verify
  fastify.post("/:id/verify", { preHandler: [authenticate, requireOrgMember, requireRole("owner", "admin", "member")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const website = await getWebsite(id, request.orgId);
    if (!website) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Website not found" } });
    }

    try {
      await verifyOwnership(id, request.orgId);
      await audit({
        userId: request.authUser.id,
        orgId: request.orgId,
        action: "website_verified",
        resourceType: "website",
        resourceId: id,
        result: "success",
      });
      return reply.send({ data: { verified: true } });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string; message: string };
      return reply.status(e.statusCode ?? 422).send({ error: { code: e.code, message: e.message } });
    }
  });
}
