import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { config } from "../config.js";
import { googleOAuthStatus, OAuthNotConfiguredError } from "../integrations/google/oauth.js";
import { EncryptionUnavailableError } from "../integrations/crypto.js";
import { GscApiError } from "../integrations/google/search-console.js";
import {
  completeGoogleOAuth,
  disconnectIntegration,
  IntegrationError,
  listAccessibleProperties,
  listIntegrations,
  RETURN_PATHS,
  startGoogleOAuth,
} from "../services/integrations.service.js";

/**
 * Integrations API (mounted under /api/v1/integrations). Organization from the
 * verified membership only; managing connections needs owner/admin; listing is
 * any member. The OAuth callback is the only unauthenticated route: it is
 * authorized by a single-use, 10-minute state plus an httpOnly cookie that
 * binds the flow to the browser that started it, and it only ever redirects
 * to the configured app URL.
 */

export const OAUTH_COOKIE = "zni_gsc_oauth";
export const CALLBACK_PATH = "/api/v1/integrations/google/oauth/callback";
const startSchema = z.object({ returnTo: z.enum(RETURN_PATHS).default("/settings/integrations") }).strict();

/** Where the browser goes after the callback: the app's own origin, never a request value. */
export function appBaseUrl(): string {
  const raw = config.APP_PUBLIC_URL ?? config.CORS_ORIGIN.split(",")[0].trim();
  const u = new URL(raw);
  return `${u.protocol}//${u.host}`;
}

export function sendIntegrationError(reply: FastifyReply, err: unknown) {
  if (err instanceof OAuthNotConfiguredError) {
    return reply.status(503).send({ error: { code: err.code, message: "Google Search Console is not configured on this server", missing: err.missing } });
  }
  if (err instanceof EncryptionUnavailableError || err instanceof IntegrationError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof GscApiError) {
    const map = {
      auth: [409, "INTEGRATION_REAUTH_REQUIRED", "Reconnect the Google account"],
      permission: [403, "PROPERTY_ACCESS_DENIED", "The Google account cannot access this Search Console data"],
      quota: [429, "GOOGLE_QUOTA_EXCEEDED", "Search Console API quota reached; try again later"],
      bad_request: [400, "GOOGLE_BAD_REQUEST", "Search Console rejected the request"],
      transient: [502, "GOOGLE_UNAVAILABLE", "Search Console is temporarily unavailable"],
    } as const;
    const [status, code, message] = map[err.kind];
    if (err.kind === "quota" && err.retryAfterMs) reply.header("Retry-After", String(Math.ceil(err.retryAfterMs / 1_000)));
    return reply.status(status).send({ error: { code, message } });
  }
  throw err;
}

export async function integrationRoutes(fastify: FastifyInstance): Promise<void> {
  const read = [authenticate, requireOrgMember];
  const manage = [authenticate, requireOrgMember, requireRole("owner", "admin")];
  fastify.addHook("preValidation", uuidParams("id"));

  // GET /api/v1/integrations — connections of this org (no secrets) + server configuration status
  fastify.get("/", { preHandler: read }, async (request, reply) => {
    const integrations = await listIntegrations(request.orgId);
    const status = googleOAuthStatus();
    return reply.send({ data: integrations, meta: { googleSearchConsole: { configured: status.configured, missing: status.missing } } });
  });

  // POST /api/v1/integrations/google/oauth/start { returnTo }
  fastify.post("/google/oauth/start", { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = startSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid returnTo" } });
    try {
      const { authorizationUrl, browserNonce } = await startGoogleOAuth({ orgId: request.orgId, userId: request.authUser.id, returnPath: body.data.returnTo });
      reply.setCookie(OAUTH_COOKIE, browserNonce, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        // Lax: the cookie must ride along on Google's top-level redirect back.
        sameSite: "lax",
        path: CALLBACK_PATH,
        maxAge: 600,
        signed: true,
      });
      return reply.send({ data: { authorizationUrl } });
    } catch (err) {
      return sendIntegrationError(reply, err);
    }
  });

  // GET /api/v1/integrations/google/oauth/callback?state=&code=|error=
  fastify.get("/google/oauth/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const raw = request.cookies?.[OAUTH_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(OAUTH_COOKIE, { path: CALLBACK_PATH });
    let result;
    try {
      result = await completeGoogleOAuth({ state: str(q.state), code: str(q.code), error: str(q.error), browserNonce: unsigned?.valid ? unsigned.value ?? undefined : undefined });
    } catch (err) {
      request.log.error({ event: "oauth_callback_failed", error: (err as Error).name }, "Google OAuth callback failed");
      result = { outcome: "error" as const, returnPath: "/settings/integrations" as const, reason: "server_error" };
    }
    const params = new URLSearchParams({ gsc: result.outcome });
    if ("reason" in result) params.set("reason", result.reason);
    // Never cache, never leak the callback URL (with its code) to the next page.
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return reply.redirect(`${appBaseUrl()}/#${result.returnPath}?${params}`, 303);
  });

  // GET /api/v1/integrations/:id/properties — live from Google
  fastify.get("/:id/properties", { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const properties = await listAccessibleProperties(request.orgId, id);
      if (!properties) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Integration not found" } });
      return reply.send({ data: properties });
    } catch (err) {
      return sendIntegrationError(reply, err);
    }
  });

  // DELETE /api/v1/integrations/:id — revoke at Google and delete credentials + data
  fastify.delete("/:id", { preHandler: manage }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await disconnectIntegration(request.orgId, id, request.authUser.id);
    if (!result) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Integration not found" } });
    return reply.send({ data: result });
  });
}
