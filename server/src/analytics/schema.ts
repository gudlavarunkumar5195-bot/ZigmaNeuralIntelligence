/**
 * ClickHouse analytics schema. ClickHouse is an append-only analytics store;
 * PostgreSQL stays the transactional source of truth. Every table carries
 * organization_id first in its sort key so tenant-scoped reads stay cheap.
 *
 * Applied only by the server-side CLI (`pnpm --dir server clickhouse:migrate`),
 * never from the frontend.
 */
export const CLICKHOUSE_TABLES = [
  "scan_events",
  "scan_findings",
  "ai_executions",
  "ai_usage",
  "monitoring_events",
  "application_events",
] as const;

export type ClickHouseTable = (typeof CLICKHOUSE_TABLES)[number];

const engine = (order: string, ttlDays = 400) =>
  `ENGINE = MergeTree PARTITION BY toYYYYMM(event_time) ORDER BY (${order}) TTL toDateTime(event_time) + INTERVAL ${ttlDays} DAY`;

export const CLICKHOUSE_DDL: Record<ClickHouseTable, string> = {
  scan_events: `CREATE TABLE IF NOT EXISTS scan_events (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    scan_id UUID, website_id UUID, status LowCardinality(String),
    modules Array(String), duration_ms Nullable(UInt32)
  ) ${engine("organization_id, event_time, scan_id")}`,
  scan_findings: `CREATE TABLE IF NOT EXISTS scan_findings (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    scan_id UUID, website_id UUID, finding_id UUID,
    module_name LowCardinality(String), category LowCardinality(String), severity LowCardinality(String)
  ) ${engine("organization_id, event_time, severity")}`,
  ai_executions: `CREATE TABLE IF NOT EXISTS ai_executions (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    execution_id UUID, agent_type LowCardinality(String), provider LowCardinality(String),
    model_id String, status LowCardinality(String), latency_ms Nullable(UInt32),
    is_fallback UInt8
  ) ${engine("organization_id, event_time, model_id")}`,
  ai_usage: `CREATE TABLE IF NOT EXISTS ai_usage (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    execution_id UUID, model_id String, prompt_tokens UInt32, completion_tokens UInt32,
    cost_usd Nullable(Decimal(18, 8))
  ) ${engine("organization_id, event_time, model_id")}`,
  monitoring_events: `CREATE TABLE IF NOT EXISTS monitoring_events (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    monitoring_id UUID, website_id UUID, run_id UUID, status LowCardinality(String),
    check_type LowCardinality(String), response_time_ms Nullable(UInt32)
  ) ${engine("organization_id, event_time, website_id")}`,
  application_events: `CREATE TABLE IF NOT EXISTS application_events (
    event_id UUID, organization_id UUID, event_time DateTime64(3, 'UTC'),
    name LowCardinality(String), properties String
  ) ${engine("organization_id, event_time, name", 180)}`,
};
