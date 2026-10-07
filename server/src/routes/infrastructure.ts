// Administration > Infrastructure (platform-wide, read-only diagnostics).
//
// These describe the shared deployment, not a tenant, so they require an org
// owner/admin who is ALSO a platform administrator (PLATFORM_ADMIN_USER_IDS).
// No route here returns a secret, runs migrations, or weakens TLS.

import type { FastifyInstance } from "fastify";
import { authenticate, requireOrgMember, requireRole, requirePlatformAdmin } from "../middleware/auth.js";
import { healthCheck } from "../db/client.js";
import { getPipelineMetrics } from "../analytics/events.js";
import { getClickHouseSchemaStatus } from "../analytics/clickhouse-migrate.js";
import {
  describeClickHouse,
  describeConfiguration,
  describePostgres,
  getMigrationStatus,
  isClickHouseConfigured,
  testClickHouse,
  testPostgres,
  type DiagnosticResult,
} from "../services/infrastructure.js";

const preHandler = [authenticate, requireOrgMember, requireRole("owner", "admin"), requirePlatformAdmin];
const testRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

// Last diagnostic results are kept in memory only so the status page can show
// "last verified" without re-probing. Nothing here is persisted or shared.
const lastResults: { postgres: DiagnosticResult | null; clickhouse: DiagnosticResult | null } = { postgres: null, clickhouse: null };

export async function infrastructureRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/status", { preHandler }, async () => {
    const pgOk = await healthCheck();
    const ch = lastResults.clickhouse;
    const chStatus = !isClickHouseConfigured() ? "not_configured" : ch ? ch.status : "not_verified";
    return {
      data: {
        checkedAt: new Date().toISOString(),
        postgres: { ...describePostgres(), status: pgOk ? "connected" : "unavailable", lastTest: lastResults.postgres },
        clickhouse: { ...describeClickHouse(), status: chStatus, lastTest: ch },
        core: { status: pgOk ? "operational" : "unavailable" },
        analytics: { status: chStatus === "connected" ? "available" : "unavailable" },
      },
    };
  });

  fastify.get("/configuration", { preHandler }, async () => ({ data: describeConfiguration() }));

  fastify.post("/postgres/test", { preHandler, config: testRateLimit }, async () => {
    lastResults.postgres = await testPostgres();
    return { data: lastResults.postgres };
  });

  fastify.post<{ Querystring: { mode?: string } }>("/clickhouse/test", { preHandler, config: testRateLimit }, async (request) => {
    lastResults.clickhouse = await testClickHouse(request.query.mode === "query" ? "query" : "connection");
    return { data: lastResults.clickhouse };
  });

  fastify.get("/migrations", { preHandler }, async () => ({
    data: {
      postgres: await getMigrationStatus(),
      // Read-only: the schema is applied by the server CLI (clickhouse:migrate), never from the UI.
      clickhouse: await (async () => {
        const ch = await getClickHouseSchemaStatus();
        const missing = ch.tables.filter((t) => !t.present).map((t) => t.name);
        const status = !ch.configured ? "not_configured" : !ch.reachable ? "unreachable" : missing.length ? "pending" : "applied";
        return { status, tables: ch.tables.filter((t) => t.present).map((t) => t.name), missing, implemented: true };
      })(),
    },
  }));

  // Real in-process counters from the analytics pipeline (reset on restart).
  fastify.get("/event-pipeline", { preHandler }, async () => {
    const m = getPipelineMetrics();
    return { data: { ...m, processed: m.delivered, failed: m.failedBatches, ingestionLatencyMs: null } };
  });
}
