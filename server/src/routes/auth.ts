import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  register, login, createRefreshToken, consumeRefreshToken,
  revokeRefreshToken, buildJwtPayload,
} from "../services/auth.service.js";
import { audit } from "../services/audit.service.js";
import { authenticate } from "../middleware/auth.js";
import { config } from "../config.js";

const REFRESH_COOKIE = "zn_refresh";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/api/v1/auth",
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).optional(),
  orgName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/register
  fastify.post("/register", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
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
  fastify.post("/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    }

    let loginResult;
    try {
      loginResult = await login(parsed.data);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string; message: string };
      await audit({ action: "login_failed", result: "failure", metadata: { email: parsed.data.email } });
      const message = e.code === "INVALID_CREDENTIALS" ? "Unable to sign in. Check your email and password and try again." : e.message;
      return reply.status(e.statusCode ?? 401).send({ error: { code: e.code ?? "AUTH_ERROR", message } });
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
      const e = err as { statusCode?: number; code?: string; message: string };
      return reply.status(e.statusCode ?? 401).send({ error: { code: e.code, message: e.message } });
    }

    const { userId, email, orgIds } = refreshResult;
    const newRefreshRaw = await createRefreshToken(userId);

    reply.setCookie(REFRESH_COOKIE, newRefreshRaw, COOKIE_OPTS);

    const payload = buildJwtPayload(userId, email, orgIds);
    const token = fastify.jwt.sign(payload, { expiresIn: "15m" });

    return reply.send({ data: { token, expiresIn: 900 } });
  });

  // POST /api/v1/auth/logout
  fastify.post("/logout", { preHandler: [authenticate] }, async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE];
    if (rawToken) {
      await revokeRefreshToken(rawToken);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    await audit({ userId: request.authUser?.id, action: "logout", result: "success" });
    return reply.send({ data: { ok: true } });
  });

  // GET /api/v1/auth/me
  fastify.get("/me", { preHandler: [authenticate] }, async (request, reply) => {
    return reply.send({
      data: {
        id: request.authUser.id,
        email: request.authUser.email,
        orgIds: request.authUser.orgIds,
      },
    });
  });
}
