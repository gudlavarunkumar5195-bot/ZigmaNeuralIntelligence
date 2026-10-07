import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/inert_test",
    CLICKHOUSE_PORT: 8443,
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_HOST: "ch.invalid",
    CLICKHOUSE_PASSWORD: "x",
    CLICKHOUSE_DATABASE: "analytics",
  },
}));
const queries: { sql: string; values: unknown[] }[] = [];
vi.mock("../db/client.js", () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return { rows: [] };
  }),
}));

import { getAiAnalytics, getMonitoringAnalytics, getRoutingAnalytics, getScanAnalytics } from "../routes/analytics.js";
import { flushEvents, getPipelineMetrics, resetPipelineForTests, trackEvent } from "../analytics/events.js";
import { CLICKHOUSE_DDL, CLICKHOUSE_TABLES } from "../analytics/schema.js";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("analytics queries", () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it("scopes every statement to the verified organization as $1", async () => {
    await getAiAnalytics(ORG, { days: 30, provider: "openrouter" });
    await getRoutingAnalytics(ORG, { days: 7 });
    await getScanAnalytics(ORG, { days: 30, severity: "high" });
    await getMonitoringAnalytics(ORG, { days: 30 });
    expect(queries.length).toBeGreaterThan(10);
    for (const q of queries) {
      expect(q.values[0]).toBe(ORG);
      expect(q.sql).toMatch(/org_id = \$1/);
    }
  });

  it("passes filter values as parameters, never interpolated", async () => {
    const evil = "x' OR 1=1 --";
    await getAiAnalytics(ORG, { days: 30, model: evil });
    for (const q of queries) expect(q.sql).not.toContain(evil);
    expect(queries.some((q) => q.values.includes(evil))).toBe(true);
  });

  it("returns honest empties: zero counts, null rates, unknown cost", async () => {
    const ai = await getAiAnalytics(ORG, { days: 30 });
    expect(ai.totals).toMatchObject({ executions: 0, failureRate: null, costUsd: null, avgLatencyMs: null });
    const mon = await getMonitoringAnalytics(ORG, { days: 30 });
    expect(mon).toMatchObject({ availability: null, responseTimeMs: null, dnsHealth: null, sslScore: null });
  });
});

describe("event pipeline", () => {
  beforeEach(() => resetPipelineForTests());

  it("never throws and buffers events for delivery", () => {
    expect(() => trackEvent("scan_events", ORG, { scan_id: "s" })).not.toThrow();
    expect(() => trackEvent("scan_events", "", { scan_id: "s" })).not.toThrow();
    expect(getPipelineMetrics().queued).toBe(1);
  });

  it("delivers batches as JSONEachRow and clears the buffer", async () => {
    trackEvent("ai_usage", ORG, { prompt_tokens: 1 });
    const send = vi.fn(async () => ({ status: 200, body: "" }));
    await flushEvents(send);
    expect(send).toHaveBeenCalledOnce();
    expect(String((send.mock.calls[0] as unknown[])[0])).toMatch(/^INSERT INTO ai_usage .*FORMAT JSONEachRow/);
    expect(getPipelineMetrics()).toMatchObject({ queued: 0, delivered: 1 });
  });

  it("keeps events and backs off when ClickHouse is down", async () => {
    trackEvent("scan_events", ORG, {});
    await flushEvents(async () => {
      throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    });
    const m = getPipelineMetrics();
    expect(m).toMatchObject({ queued: 1, delivered: 0, failedBatches: 1, lastErrorKind: "connection" });
    expect(m.retryingUntil).not.toBeNull();
  });
});

describe("ClickHouse schema", () => {
  it("defines all six tables, each ordered by organization_id", () => {
    expect(CLICKHOUSE_TABLES).toEqual(["scan_events", "scan_findings", "ai_executions", "ai_usage", "monitoring_events", "application_events"]);
    for (const t of CLICKHOUSE_TABLES) expect(CLICKHOUSE_DDL[t]).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}[\\s\\S]*ORDER BY \\(organization_id`));
  });
});
