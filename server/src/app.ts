import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { toFastifyTrustProxy } from "./http/trust-proxy.js";
import { errorHandler } from "./middleware/error.js";
import { healthRoutes } from "./routes/health.js";
import { infrastructureRoutes } from "./routes/infrastructure.js";
import { analyticsRoutes } from "./routes/analytics.js";
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
import { crossDomainRoutes } from "./routes/cross-domain.js";
import { monitoringRoutes } from "./routes/monitoring.js";

// server/src (tsx) or server/dist (built) -> ../../dist is the Vite artifact.
const FRONTEND_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"],
      transport: config.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
    genReqId: () => crypto.randomUUID(),
    // Explicit, strictly validated proxy trust (default: false). With false,
    // request.ip is the socket address and X-Forwarded-For is ignored.
    trustProxy: toFastifyTrustProxy(config.TRUST_PROXY),
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
    // request.ip honours X-Forwarded-For only as far as TRUST_PROXY allows, so
    // clients cannot spoof a fresh key, and behind a trusted proxy each real
    // client gets its own bucket instead of sharing the proxy address.
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
  await fastify.register(crossDomainRoutes, { prefix: "/api/v1" });
  await fastify.register(monitoringRoutes, { prefix: "/api/v1/monitoring" });
  await fastify.register(infrastructureRoutes, { prefix: "/api/v1/infrastructure" });
  await fastify.register(analyticsRoutes, { prefix: "/api/v1/analytics" });

  fastify.all("/api/v1/*", async (_request, reply) => {
    return reply.status(404).send({
      error: { code: "NOT_FOUND", message: "API route not found" },
    });
  });

  // The App Platform runs one web process. Serve the Vite production artifact
  // from the existing Fastify process while preserving all API routes above.
  await fastify.register(fastifyStatic, {
    root: FRONTEND_DIST,
    prefix: "/",
    wildcard: false,
  });
  fastify.get("/*", async (request, reply) => {
    // Missing files (stale hashed assets, typos, dotfiles) must 404; only
    // extension-less client routes fall back to the SPA shell.
    const leaf = (request.url.split("?")[0] ?? "").split("/").pop() ?? "";
    if (leaf.includes(".")) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    }
    return reply.sendFile("index.html");
  });

  return fastify;
}
