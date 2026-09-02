import type { FastifyInstance } from "fastify";
import { healthCheck } from "../db/client.js";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async (_req, reply) => {
    reply.status(200).send({ status: "ok", timestamp: new Date().toISOString() });
  });

  fastify.get("/ready", async (_req, reply) => {
    const dbOk = await healthCheck();
    if (!dbOk) {
      return reply.status(503).send({ status: "not_ready", checks: { database: "fail" } });
    }
    reply.status(200).send({ status: "ready", checks: { database: "ok" } });
  });
}
