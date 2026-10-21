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
const { queries } = vi.hoisted(() => ({ queries: [] as { sql: string; values: unknown[] }[] }));
const { outboxRows, dbQuery } = vi.hoisted(() => {
  const outboxRows: Array<Record<string, unknown>> = [];
  const dbQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM analytics_outbox") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      return { rows: outboxRows.filter((r) => r.status === "PENDING") };
    }
    return { rows: [] };
  });
  return { outboxRows, dbQuery };
});
vi.mock("../db/client.js", () => ({
  query: dbQuery,
  withTransaction: async (fn: (tx: { query: typeof dbQuery }) => unknown) => fn({ query: dbQuery }),
}));

import { getAiAnalytics, getMonitoringAnalytics, getRoutingAnalytics, getScanAnalytics } from "../routes/analytics.js";
import { backoffMs, dispatchOutbox, enqueueAnalyticsEvent, resetPipelineForTests, toClickHouseRow, trackEvent } from "../analytics/events.js";
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

describe("durable analytics outbox", () => {
  beforeEach(() => {
    resetPipelineForTests();
    queries.length = 0;
    outboxRows.length = 0;
  });

  it("enqueues inside the caller's transaction and fails closed on DB errors", async () => {
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    await enqueueAnalyticsEvent(tx as never, { table: "scan_findings", orgId: ORG, row: { scan_id: "s" } });
    expect(tx.query).toHaveBeenCalledWith(expect.stringMatching(/^INSERT INTO analytics_outbox/), [ORG, "scan_findings", JSON.stringify({ scan_id: "s" })]);
    const broken = { query: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(enqueueAnalyticsEvent(broken as never, { table: "scan_events", orgId: ORG, row: {} })).rejects.toThrow("db down");
    await expect(enqueueAnalyticsEvent(tx as never, { table: "nope" as never, orgId: ORG, row: {} })).rejects.toThrow(/Unknown analytics table/);
  });

  it("trackEvent never throws and skips events without an organization", () => {
    expect(() => trackEvent("scan_events", ORG, { scan_id: "s" })).not.toThrow();
    expect(() => trackEvent("scan_events", "", { scan_id: "s" })).not.toThrow();
  });

  it("sends JSONEachRow with a dedup token and marks rows DISPATCHED", async () => {
    outboxRows.push({ id: "1", event_id: "e1", org_id: ORG, target_table: "ai_usage", payload: { prompt_tokens: 1 }, event_time: "2026-10-21T10:00:00.123Z", attempts: 0, status: "PENDING" });
    const send = vi.fn(async () => ({ status: 200, body: "" }));
    await expect(dispatchOutbox(send)).resolves.toBe(1);
    const sql = String((send.mock.calls[0] as unknown[])[0]);
    expect(sql).toMatch(/^INSERT INTO ai_usage SETTINGS insert_deduplication_token='[0-9a-f]{64}' FORMAT JSONEachRow/);
    expect(JSON.parse(sql.split("\n")[1])).toEqual({ prompt_tokens: 1, event_id: "e1", organization_id: ORG, event_time: "2026-10-21 10:00:00.123" });
    expect(queries.some((q) => q.sql.includes("SET status = 'DISPATCHED'"))).toBe(true);
  });

  it("a payload can never override the tenant, id or time columns", () => {
    const row = toClickHouseRow({ id: "1", event_id: "e1", org_id: ORG, target_table: "scan_events", payload: { organization_id: "evil", event_id: "x", event_time: 0 }, event_time: "2026-10-21T00:00:00.000Z", attempts: 0 });
    expect(row).toMatchObject({ organization_id: ORG, event_id: "e1", event_time: "2026-10-21 00:00:00.000" });
  });

  it("keeps rows PENDING with backoff when ClickHouse is down, DEAD after the cap", async () => {
    outboxRows.push({ id: "2", event_id: "e2", org_id: ORG, target_table: "scan_events", payload: {}, event_time: new Date().toISOString(), attempts: 0, status: "PENDING" });
    outboxRows.push({ id: "3", event_id: "e3", org_id: ORG, target_table: "scan_events", payload: {}, event_time: new Date().toISOString(), attempts: 19, status: "PENDING" });
    await expect(dispatchOutbox(async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); })).resolves.toBe(0);
    const updates = queries.filter((q) => q.sql.includes("SET attempts = $2"));
    expect(updates.map((u) => u.values.slice(0, 4))).toEqual([["2", 1, "connection", false], ["3", 20, "connection", true]]);
    expect(queries.some((q) => q.sql.includes("'DISPATCHED'"))).toBe(false);
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(30)).toBe(300_000);
  });
});

describe("ClickHouse schema", () => {
  it("defines all six tables, each ordered by organization_id", () => {
    expect(CLICKHOUSE_TABLES).toEqual(["scan_events", "scan_findings", "ai_executions", "ai_usage", "monitoring_events", "application_events"]);
    for (const t of CLICKHOUSE_TABLES) {
      expect(CLICKHOUSE_DDL[t]).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}[\\s\\S]*ORDER BY \\(organization_id`));
      // Re-sent outbox batches collapse on event_id.
      expect(CLICKHOUSE_DDL[t]).toMatch(/ReplacingMergeTree[\s\S]*ORDER BY \([^)]*event_id\)/);
    }
  });
});
