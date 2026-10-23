import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createFixedWindowCounter, normalizeEmailForKey } from "../http/trust-proxy.js";
import { z } from "zod";
import {
  register, login, createRefreshToken, consumeRefreshToken,
  revokeRefreshToken, buildJwtPayload,
} from "../services/auth.service.js";
import { audit } from "../services/audit.service.js";
import { createPasswordResetToken, PASSWORD_MAX_BYTES, passwordWithinBcryptLimit, resetPasswordWithToken } from "../services/auth.service.js";
import { emailDeliveryConfigured, sendPasswordResetEmail } from "../platform/mailer.js";
import { query } from "../db/client.js";
import { authenticate } from "../middleware/auth.js";
import { isAppError } from "../middleware/error.js";
import { config } from "../config.js";

const REFRESH_COOKIE = "zn_refresh";
const COOKIE_OPTS = {
  httpOnly: true,
  // Secure in production and on any HTTPS deployment (e.g. a staging environment not run with NODE_ENV=production).
  secure: config.NODE_ENV === "production" || (config.APP_PUBLIC_URL ?? "").startsWith("https:"),
  sameSite: "strict" as const,
  path: "/api/v1/auth",
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

const passwordSchema = z.string().min(8).refine(passwordWithinBcryptLimit, `Password must be at most ${PASSWORD_MAX_BYTES} bytes`);

const registerSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  fullName: z.string().min(1).max(200).optional(),
  orgName: z.string().min(1).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Per-(IP, email) bucket evaluated after body parsing, so one client cannot
// lock out a victim globally and a shared NAT is not throttled as one user.
// A broader per-IP bucket (onRequest) still bounds email rotation.
const emailKey = (request: FastifyRequest) =>
  `${request.ip}|${normalizeEmailForKey((request.body as { email?: unknown } | undefined)?.email)}`;

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // @fastify/rate-limit runs one limiter per request, so the per-IP ceiling
  // is a separate counter evaluated in onRequest.
  const ipBucket = (max: number) => {
    const counter = createFixedWindowCounter(max, 15 * 60_000);
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!counter.hit(request.ip)) {
        return reply.status(429).header("Retry-After", "900").send({
          error: { code: "RATE_LIMITED", message: "Too many authentication attempts from this address" },
        });
      }
    };
  };

  // POST /api/v1/auth/register
  fastify.post("/register", { onRequest: [ipBucket(20)], config: { rateLimit: { max: 5, timeWindow: "15 minutes", hook: "preHandler", keyGenerator: emailKey } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    const { userId, orgId } = await register(parsed.data);

    const payload = buildJwtPayload(userId, parsed.data.email, [orgId]);
    const token = fastify.jwt.sign(payload, { expiresIn: "15m" });
    const refreshRaw = await createRefreshToken(userId);

    reply.setCookie(REFRESH_COOKIE, refreshRaw, COOKIE_OPTS);

    await audit({ userId, orgId, action: "user_registered", resourceType: "user", resourceId: userId as unknown as string, result: "success" });

    return reply.status(201).send({ data: { token, expiresIn: 900, userId, orgId } });
  });

  // POST /api/v1/auth/login
  fastify.post("/login", { onRequest: [ipBucket(50)], config: { rateLimit: { max: 10, timeWindow: "15 minutes", hook: "preHandler", keyGenerator: emailKey } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    let loginResult;
    try {
      loginResult = await login(parsed.data);
    } catch (err: unknown) {
      if (!isAppError(err)) throw err;
      await audit({ action: "login_failed", result: "failure", metadata: { email: parsed.data.email } });
      const message = err.code === "INVALID_CREDENTIALS" ? "Unable to sign in. Check your email and password and try again." : err.message;
      return reply.status(err.statusCode).send({ error: { code: err.code, message } });
    }

    const { userId, email, orgIds } = loginResult;
    const defaultOrgId = orgIds[0];

    const payload = buildJwtPayload(userId, email, orgIds);
    const token = fastify.jwt.sign(payload, { expiresIn: "15m" });
    const refreshRaw = await createRefreshToken(userId);

    reply.setCookie(REFRESH_COOKIE, refreshRaw, COOKIE_OPTS);

    await audit({ userId, orgId: defaultOrgId, action: "login", resourceType: "user", resourceId: userId as unknown as string, result: "success" });

    return reply.send({ data: { token, expiresIn: 900, userId, orgIds } });
  });

  // POST /api/v1/auth/refresh
  fastify.post("/refresh", async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE];
    if (!rawToken) {
      return reply.status(401).send({ error: { code: "NO_REFRESH_TOKEN", message: "Refresh token missing" } });
    }

    let refreshResult;
    try {
      refreshResult = await consumeRefreshToken(rawToken);
    } catch (err: unknown) {
      if (!isAppError(err)) throw err;
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }

    const { userId, email, orgIds } = refreshResult;
    reply.setCookie(REFRESH_COOKIE, refreshResult.newRefreshToken, COOKIE_OPTS);

    const payload = buildJwtPayload(userId, email, orgIds);
    const token = fastify.jwt.sign(payload, { expiresIn: "15m" });

    return reply.send({ data: { token, expiresIn: 900 } });
  });

  // POST /api/v1/auth/logout
  // Works from the refresh cookie alone (the 15m access token may have expired).
  // Idempotent: always clears the cookie and revokes the cookie's token if present.
  fastify.post("/logout", async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE];
    let userId: string | undefined;
    if (rawToken) {
      userId = (await revokeRefreshToken(rawToken)) ?? undefined;
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    if (userId) await audit({ userId, action: "logout", result: "success" });
    return reply.send({ data: { ok: true } });
  });

  // POST /api/v1/auth/password-reset/request — always the same answer, whether or
  // not the email exists or email delivery is configured (no enumeration).
  fastify.post("/password-reset/request", { onRequest: [ipBucket(20)], config: { rateLimit: { max: 5, timeWindow: "15 minutes", hook: "preHandler", keyGenerator: emailKey } } }, async (request, reply) => {
    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid email is required" } });
    if (emailDeliveryConfigured()) {
      const { rows } = await query<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = $1 AND active = TRUE", [parsed.data.email.toLowerCase().trim()]);
      if (rows[0]) {
        const raw = await createPasswordResetToken(rows[0].id, null);
        try {
          await sendPasswordResetEmail(rows[0].email, `${config.APP_PUBLIC_URL ?? ""}/reset-password?token=${raw}`);
          await audit({ userId: rows[0].id, requestId: request.id, action: "password_reset_requested", resourceType: "user", resourceId: rows[0].id, result: "success" });
        } catch {
          await audit({ userId: rows[0].id, requestId: request.id, action: "password_reset_requested", resourceType: "user", resourceId: rows[0].id, result: "failure", metadata: { reason: "delivery_failed" } });
        }
      }
    }
    return reply.status(202).send({ data: { message: "If an account exists for this email and email delivery is available, a reset link has been sent." } });
  });

  // POST /api/v1/auth/password-reset/confirm
  fastify.post("/password-reset/confirm", { onRequest: [ipBucket(30)], config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" } });
    try {
      const { userId } = await resetPasswordWithToken(parsed.data.token, parsed.data.password);
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_OPTS.path });
      await audit({ userId, requestId: request.id, action: "password_reset_completed", resourceType: "user", resourceId: userId, result: "success" });
      return reply.send({ data: { message: "Your password has been changed. Sign in with the new password; other sessions were signed out." } });
    } catch (err) {
      if (isAppError(err)) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // GET /api/v1/auth/me
  fastify.get("/me", { preHandler: [authenticate] }, async (request, reply) => {
    // A deactivated user's access token stays valid for up to 15 minutes; /me must not answer for it.
    const { rows: active } = await query<{ active: boolean }>("SELECT active FROM users WHERE id = $1", [request.authUser.id]);
    if (!active[0]?.active) return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid access token required" } });
    // The caller's own memberships, so the UI can tell a viewer up front that
    // changes are not allowed. Every write route still enforces the role itself.
    const { rows: memberships } = await query<{ orgId: string; role: string }>(
      `SELECT m.org_id AS "orgId", m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND u.active = TRUE ORDER BY m.created_at`,
      [request.authUser.id],
    );
    return reply.send({
      data: {
        id: request.authUser.id,
        email: request.authUser.email,
        orgIds: request.authUser.orgIds,
        memberships,
        // Lets the UI show the Administration section; the backend enforces it on every admin route.
        isPlatformAdmin: config.PLATFORM_ADMIN_USER_IDS.includes(request.authUser.id.toLowerCase()),
      },
    });
  });
}
