// Admin Control Center (platform-wide), mounted under /api/v1/admin.
//
// Every route: a valid access token, a platform administrator
// (PLATFORM_ADMIN_USER_IDS) whose account is still active in the database,
// strict input validation, sanitized errors and an audit event for every
// change. Authentication is a bearer header (never a cookie), so these
// routes are not reachable by cross-site request forgery. Nothing here
// returns a secret, runs SQL or shell commands, or fetches arbitrary URLs.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { CursorValidationError } from "../http/pagination.js";
import { authenticate, requirePlatformAdmin } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { credentialAad as googleCredentialAad } from "../services/integrations.service.js";
import { reencryptAllCredentials } from "../platform/credential-store.js";
import { exportDiagnostics, getDiagnostics, retryJob } from "../platform/diagnostics.js";
import { AdminError, listIntegrations, removeCredential, saveCredential, setCredentialEnabled, testIntegration } from "../platform/integrations.js";
import { EmailNotConfiguredError, emailDeliveryConfigured, sendPasswordResetEmail } from "../platform/mailer.js";
import { changeRole, generateAccountCredentials, getUser, listUsers, revokeSessions, setUserActive } from "../platform/users.js";
import { createPasswordResetToken } from "../services/auth.service.js";

/** The admin's own account must still be active (the token alone is not enough). */
async function requireActiveAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { rows } = await query<{ active: boolean }>("SELECT active FROM users WHERE id = $1", [request.authUser.id]);
  if (!rows[0]?.active) return reply.status(403).send({ error: { code: "ACCOUNT_DISABLED", message: "This account is disabled." } });
}

const preHandler = [authenticate, requirePlatformAdmin, requireActiveAdmin];
const sensitive = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });
const confirmBody = z.object({ confirm: z.literal(true) }).strict();

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AdminError || err instanceof EmailNotConfiguredError) {
    const e = err as AdminError;
    return reply.status(e.statusCode).send({ error: { code: e.code, message: e.message, details: e.details } });
  }
  if (err instanceof CursorValidationError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
  throw err;
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data as z.infer<S>;
  void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: r.error.issues[0]?.message ?? "Invalid request", details: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  return undefined;
}

const providerParam = z.object({ provider: z.string().regex(/^[a-z0-9_]{1,40}$/) });

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  const act = (request: FastifyRequest, action: string, result: "success" | "failure", extra: { resourceType?: string; resourceId?: string | null; orgId?: string | null; metadata?: Record<string, unknown> } = {}) =>
    audit({ userId: request.authUser.id, requestId: request.id, action, result, resourceType: extra.resourceType ?? null, resourceId: extra.resourceId ?? null, orgId: extra.orgId ?? null, metadata: extra.metadata ?? null });

  // ─── Overview & diagnostics ────────────────────────────────────────────────
  fastify.get("/diagnostics", { preHandler }, async (_request, reply) => reply.header("cache-control", "no-store").send({ data: await getDiagnostics() }));

  fastify.get("/diagnostics/export", { preHandler, config: sensitive(10) }, async (request, reply) => {
    const data = await exportDiagnostics();
    await act(request, "admin_diagnostics_exported", "success");
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="zigmaneural-diagnostics-${data.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}.json"`)
      .send(data);
  });

  fastify.post("/diagnostics/jobs/:kind/:id/retry", { preHandler, config: sensitive(20) }, async (request, reply) => {
    const params = parse(z.object({ kind: z.enum(["gsc_sync", "analytics_outbox"]), id: z.string().min(1).max(64) }), request.params, reply);
    if (!params) return;
    if (params.kind === "gsc_sync" && !z.string().uuid().safeParse(params.id).success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid job id" } });
    try {
      const out = await retryJob(params.kind, params.id, request.authUser.id);
      await act(request, "admin_job_retried", "success", { resourceType: params.kind, metadata: { kind: params.kind, id: params.id } });
      return reply.send({ data: out });
    } catch (err) {
      await act(request, "admin_job_retried", "failure", { resourceType: params.kind, metadata: { kind: params.kind, id: params.id, code: (err as AdminError).code ?? "ERROR" } });
      return sendError(reply, err);
    }
  });

  // ─── Integrations & API keys ───────────────────────────────────────────────
  fastify.get("/integrations", { preHandler }, async (_request, reply) => reply.header("cache-control", "no-store").send({ data: await listIntegrations() }));

  // Save = validate with the provider first; stored only when accepted.
  fastify.put("/integrations/:provider/credential", { preHandler, bodyLimit: 4_096, config: sensitive(10) }, async (request, reply) => {
    const p = parse(providerParam, request.params, reply);
    const body = p && parse(z.object({ secret: z.string().max(512) }).strict(), request.body, reply);
    if (!p || !body) return;
    try {
      const out = await saveCredential(p.provider, body.secret.trim(), request.authUser.id);
      await act(request, "admin_credential_saved", "success", { resourceType: "platform_credential", metadata: { provider: p.provider, suffix: out.integration.credential?.suffix ?? null } });
      return reply.header("cache-control", "no-store").send({ data: out });
    } catch (err) {
      await act(request, "admin_credential_saved", "failure", { resourceType: "platform_credential", metadata: { provider: p.provider, code: (err as AdminError).code ?? "ERROR", status: (err as AdminError).details?.status ?? null } });
      return sendError(reply, err);
    }
  });

  fastify.post("/integrations/:provider/test", { preHandler, config: sensitive(20) }, async (request, reply) => {
    const p = parse(providerParam, request.params, reply);
    if (!p) return;
    try {
      const result = await testIntegration(p.provider, request.authUser.id);
      await act(request, "admin_integration_tested", result.status === "valid" ? "success" : "failure", { resourceType: "integration", metadata: { provider: p.provider, status: result.status } });
      return reply.send({ data: { result, integration: (await listIntegrations()).find((i) => i.id === p.provider) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  for (const [path, enabled] of [["enable", true], ["disable", false]] as const) {
    fastify.post(`/integrations/:provider/${path}`, { preHandler, config: sensitive(20) }, async (request, reply) => {
      const p = parse(providerParam, request.params, reply);
      if (!p) return;
      try {
        await setCredentialEnabled(p.provider, enabled);
        await act(request, enabled ? "admin_integration_enabled" : "admin_integration_disabled", "success", { resourceType: "integration", metadata: { provider: p.provider } });
        return reply.send({ data: (await listIntegrations()).find((i) => i.id === p.provider) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  }

  fastify.delete("/integrations/:provider/credential", { preHandler, config: sensitive(10) }, async (request, reply) => {
    const p = parse(providerParam, request.params, reply);
    const body = p && parse(confirmBody, request.body, reply);
    if (!p || !body) return;
    try {
      const out = await removeCredential(p.provider);
      await act(request, "admin_credential_removed", "success", { resourceType: "platform_credential", metadata: { provider: p.provider, removed: out.removed } });
      return reply.send({ data: { ...out, integration: (await listIntegrations()).find((i) => i.id === p.provider) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post("/integrations/encryption/reencrypt", { preHandler, config: sensitive(2) }, async (request, reply) => {
    if (!parse(confirmBody, request.body, reply)) return;
    const out = await reencryptAllCredentials(googleCredentialAad);
    await act(request, "admin_credentials_reencrypted", out.failed ? "failure" : "success", { metadata: out });
    return reply.send({ data: out });
  });

  // ─── Users & access ────────────────────────────────────────────────────────
  fastify.get("/users", { preHandler }, async (request, reply) => {
    const q = parse(z.object({ search: z.string().trim().max(200).optional(), status: z.enum(["active", "inactive"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(500).optional() }), request.query, reply);
    if (!q) return;
    try {
      const out = await listUsers({ search: q.search || undefined, status: q.status, limit: q.limit, cursor: q.cursor });
      return reply.send({ data: out.users, meta: { nextCursor: out.nextCursor } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get("/users/:id", { preHandler, preValidation: uuidParams("id") }, async (request, reply) => {
    try {
      return reply.send({ data: await getUser((request.params as { id: string }).id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  for (const [path, active] of [["activate", true], ["deactivate", false]] as const) {
    fastify.post(`/users/:id/${path}`, { preHandler, preValidation: uuidParams("id"), config: sensitive(20) }, async (request, reply) => {
      if (!parse(confirmBody, request.body, reply)) return;
      const userId = (request.params as { id: string }).id;
      try {
        const out = await setUserActive(request.authUser.id, userId, active);
        await act(request, active ? "admin_user_activated" : "admin_user_deactivated", "success", { resourceType: "user", resourceId: userId, metadata: out });
        return reply.send({ data: out });
      } catch (err) {
        await act(request, active ? "admin_user_activated" : "admin_user_deactivated", "failure", { resourceType: "user", resourceId: userId, metadata: { code: (err as AdminError).code ?? "ERROR" } });
        return sendError(reply, err);
      }
    });
  }

  fastify.post("/users/:id/revoke-sessions", { preHandler, preValidation: uuidParams("id"), config: sensitive(20) }, async (request, reply) => {
    if (!parse(confirmBody, request.body, reply)) return;
    const userId = (request.params as { id: string }).id;
    try {
      const out = await revokeSessions(userId);
      await act(request, "admin_sessions_revoked", "success", { resourceType: "user", resourceId: userId, metadata: out });
      return reply.send({ data: out });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.patch("/users/:id/memberships/:orgId", { preHandler, preValidation: uuidParams("id", "orgId"), config: sensitive(20) }, async (request, reply) => {
    const body = parse(z.object({ role: z.enum(["owner", "admin", "member", "viewer"]), confirm: z.literal(true) }).strict(), request.body, reply);
    if (!body) return;
    const { id: userId, orgId } = request.params as { id: string; orgId: string };
    try {
      const out = await changeRole(userId, orgId, body.role);
      await act(request, "admin_role_changed", "success", { resourceType: "user", resourceId: userId, orgId, metadata: out });
      return reply.send({ data: out });
    } catch (err) {
      await act(request, "admin_role_changed", "failure", { resourceType: "user", resourceId: userId, orgId, metadata: { code: (err as AdminError).code ?? "ERROR", to: body.role } });
      return sendError(reply, err);
    }
  });

  // Emails a reset link to the user. The token is never shown to the administrator.
  fastify.post("/users/:id/password-reset", { preHandler, preValidation: uuidParams("id"), config: sensitive(10) }, async (request, reply) => {
    if (!parse(confirmBody, request.body, reply)) return;
    const userId = (request.params as { id: string }).id;
    try {
      if (!emailDeliveryConfigured()) throw new EmailNotConfiguredError();
      const { rows } = await query<{ email: string; active: boolean }>("SELECT email, active FROM users WHERE id = $1", [userId]);
      if (!rows[0]) throw new AdminError(404, "USER_NOT_FOUND", "User not found.");
      if (!rows[0].active) throw new AdminError(409, "USER_INACTIVE", "Activate the account before sending a reset link.");
      const raw = await createPasswordResetToken(userId, request.authUser.id);
      await sendPasswordResetEmail(rows[0].email, `${config.APP_PUBLIC_URL ?? ""}/reset-password?token=${raw}`);
      await act(request, "admin_password_reset_initiated", "success", { resourceType: "user", resourceId: userId });
      return reply.send({ data: { sent: true } });
    } catch (err) {
      await act(request, "admin_password_reset_initiated", "failure", { resourceType: "user", resourceId: userId, metadata: { code: (err as AdminError).code ?? "ERROR" } });
      return sendError(reply, err);
    }
  });

  // One-click login credentials for the designated account only.
  fastify.get("/account-credentials", { preHandler }, async (_request, reply) => {
    const { rows } = await query<{ id: string; active: boolean; last_login_at: Date | null }>("SELECT id, active, last_login_at FROM users WHERE email = $1", [config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL]);
    return reply.send({ data: { email: config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL, exists: !!rows[0], active: rows[0]?.active ?? null, lastLoginAt: rows[0]?.last_login_at ?? null } });
  });

  // Limited per admin session (the bearer token's hash), so one admin cannot exhaust another's budget.
  const sessionKey = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return auth ? `admin-cred:${createHash("sha256").update(auth).digest("hex")}` : `admin-cred-ip:${request.ip}`;
  };
  fastify.post("/account-credentials", { preHandler, bodyLimit: 1_024, config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: sessionKey } } }, async (request, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), confirmReset: z.boolean().default(false) }).strict(), request.body, reply);
    if (!body) return;
    if (body.email !== config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL) {
      return reply.status(400).send({ error: { code: "ACCOUNT_NOT_ALLOWED", message: `Credentials can only be generated for ${config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL}.` } });
    }
    if (config.NODE_ENV === "production" && request.protocol !== "https") {
      return reply.status(400).send({ error: { code: "HTTPS_REQUIRED", message: "Generated passwords are only returned over HTTPS (check TRUST_PROXY behind the load balancer)." } });
    }
    try {
      const out = await generateAccountCredentials(body.confirmReset);
      if (out.kind === "confirmation_required") {
        return reply.status(409).send({ error: { code: "CONFIRMATION_REQUIRED", message: `${config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL} already exists. Confirm to replace its password; its current sessions will be signed out.`, details: { exists: true, active: out.active } } });
      }
      // The password is in this response only: never logged, audited or stored in plaintext.
      await act(request, "admin_credentials_generated", "success", { resourceType: "user", resourceId: out.userId, metadata: { created: out.created, revokedSessions: out.revokedSessions } });
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send({ data: { email: out.email, password: out.password, created: out.created, accountActive: out.active, revokedSessions: out.revokedSessions } });
    } catch (err) {
      await act(request, "admin_credentials_generated", "failure", { resourceType: "user", metadata: { code: (err as AdminError).code ?? "ERROR" } });
      return sendError(reply, err);
    }
  });

  // ─── Audit ─────────────────────────────────────────────────────────────────
  fastify.get("/audit", { preHandler }, async (request, reply) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query, reply);
    if (!q) return;
    const { rows } = await query(
      `SELECT a.timestamp, a.action, a.result, a.resource_type, a.resource_id, a.org_id, a.request_id, a.metadata, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.action LIKE 'admin\\_%'
        ORDER BY a.timestamp DESC LIMIT $1`,
      [q.limit],
    );
    return reply.send({ data: rows });
  });
}
