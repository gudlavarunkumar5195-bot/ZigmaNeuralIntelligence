import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config.js";
import { errorHandler } from "./middleware/error.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { websiteRoutes } from "./routes/websites.js";
import { scanRoutes } from "./routes/scans.js";
import { modelRoutes } from "./routes/models.js";
import { routingRoutes } from "./routes/routing.js";
import { agentRoutes } from "./routes/agents.js";
import { instructionRoutes } from "./routes/instructions.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { qualityRoutes } from "./routes/quality.js";
import { regenerationRoutes } from "./routes/regeneration.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { reportRoutes } from "./routes/reports.js";

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      transport: config.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
    genReqId: () => crypto.randomUUID(),
  });

  // ─── Plugins ─────────────────────────────────────────────────────────────────

  await fastify.register(cors, {
    origin: config.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await fastify.register(cookie, {
    secret: config.COOKIE_SECRET,
    parseOptions: {},
  });

  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  // Global rate limiting — individual routes can override
  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    // Fastify does not trust proxy headers unless explicitly configured.
    // Using request.ip prevents clients from spoofing a fresh rate-limit key.
    keyGenerator: (request) => request.ip,
  });

  // Attach requestId to every response
  fastify.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // ─── Error handler ────────────────────────────────────────────────────────────

  fastify.setErrorHandler(errorHandler);

  // ─── Routes ───────────────────────────────────────────────────────────────────

  await fastify.register(healthRoutes);

  await fastify.register(authRoutes, { prefix: "/api/v1/auth" });
  await fastify.register(websiteRoutes, { prefix: "/api/v1/websites" });
  await fastify.register(scanRoutes, { prefix: "/api/v1/scans" });
  await fastify.register(modelRoutes, { prefix: "/api/v1/models" });
  await fastify.register(routingRoutes, { prefix: "/api/v1/routing" });
  await fastify.register(agentRoutes, { prefix: "/api/v1/agents" });
  await fastify.register(instructionRoutes, { prefix: "/api/v1" });
  await fastify.register(evidenceRoutes, { prefix: "/api/v1" });
  await fastify.register(qualityRoutes, { prefix: "/api/v1" });
  await fastify.register(regenerationRoutes, { prefix: "/api/v1" });
  await fastify.register(dashboardRoutes, { prefix: "/api/v1/dashboard" });
  await fastify.register(reportRoutes, { prefix: "/api/v1/reports" });

  fastify.all("/api/v1/*", async (_request, reply) => {
    return reply.status(404).send({
      error: { code: "NOT_FOUND", message: "API route not found" },
    });
  });

  // The App Platform runs one web process. Serve the Vite production artifact
  // from the existing Fastify process while preserving all API routes above.
  await fastify.register(fastifyStatic, {
    root: join(process.cwd(), "..", "dist"),
    prefix: "/",
    wildcard: false,
  });
  fastify.get("/assets/*", async (_request, reply) => {
    return reply.status(404).send({
      error: { code: "ASSET_NOT_FOUND", message: "Static asset not found" },
    });
  });
  fastify.get("/*", async (_request, reply) => reply.sendFile("index.html"));

  // Tighter rate limiting for auth endpoints
  fastify.addHook("onRequest", async (request, reply) => {
    if (request.url?.startsWith("/api/v1/auth/login") || request.url?.startsWith("/api/v1/auth/register")) {
      // Auth-specific limits are enforced by the global limiter + additional logic.
      // For per-endpoint overrides, use @fastify/rate-limit config on the route.
    }
  });

  return fastify;
}
