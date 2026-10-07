import { randomUUID } from "node:crypto";
import { chRequest, isClickHouseConfigured } from "../services/infrastructure.js";
import { config } from "../config.js";
import type { ClickHouseTable } from "./schema.js";

/**
 * Fire-and-forget analytics event pipeline.
 *
 * Transactional code calls `trackEvent()` *after* its PostgreSQL write has
 * committed. The call is synchronous, never throws and never awaits the
 * network, so ClickHouse being slow or down can never fail or delay a
 * transactional write. Events are buffered in memory, flushed in batches, and
 * retried with exponential backoff; when the buffer is full the oldest events
 * are dropped and counted (analytics may lose data, the core app may not).
 */

const MAX_BUFFER = 10_000;
const BATCH_SIZE = 500;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type Row = Record<string, unknown>;

const buffers = new Map<ClickHouseTable, Row[]>();
const metrics = {
  enqueued: 0,
  delivered: 0,
  dropped: 0,
  failedBatches: 0,
  consecutiveFailures: 0,
  lastFlushAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastErrorAt: null as string | null,
  lastErrorKind: null as string | null,
};
let timer: NodeJS.Timeout | null = null;
let nextAttemptAt = 0;
let flushing = false;

function bufferedCount(): number {
  let n = 0;
  for (const rows of buffers.values()) n += rows.length;
  return n;
}

export function trackEvent(table: ClickHouseTable, organizationId: string, row: Row): void {
  try {
    if (!isClickHouseConfigured() || !organizationId) return;
    const rows = buffers.get(table) ?? [];
    rows.push({ event_id: randomUUID(), organization_id: organizationId, event_time: Date.now(), ...row });
    buffers.set(table, rows);
    metrics.enqueued++;
    while (bufferedCount() > MAX_BUFFER) {
      const oldest = [...buffers.values()].find((r) => r.length > 0);
      oldest?.shift();
      metrics.dropped++;
    }
    ensureTimer();
  } catch {
    // Analytics must never break the caller.
  }
}

function ensureTimer() {
  if (timer || config.NODE_ENV === "test") return;
  timer = setInterval(() => void flushEvents(), FLUSH_INTERVAL_MS);
  timer.unref();
}

/** Flushes buffered events. Exposed for shutdown and tests. */
export async function flushEvents(
  send: (sql: string) => Promise<{ status: number; body: string }> = (sql) => chRequest(sql, config.CLICKHOUSE_DATABASE),
): Promise<void> {
  if (flushing || Date.now() < nextAttemptAt) return;
  flushing = true;
  metrics.lastFlushAt = new Date().toISOString();
  try {
    for (const [table, rows] of buffers) {
      while (rows.length > 0) {
        const batch = rows.slice(0, BATCH_SIZE);
        const body = batch.map((r) => JSON.stringify(r)).join("\n");
        let ok = false;
        try {
          const res = await send(`INSERT INTO ${table} SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow\n${body}`);
          ok = res.status >= 200 && res.status < 300;
          if (!ok) metrics.lastErrorKind = res.status === 401 || res.status === 403 ? "auth" : "insert";
        } catch (err) {
          metrics.lastErrorKind = (err as { code?: string }).code === "TIMEOUT" ? "timeout" : "connection";
        }
        if (!ok) {
          metrics.failedBatches++;
          metrics.consecutiveFailures++;
          metrics.lastErrorAt = new Date().toISOString();
          nextAttemptAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** metrics.consecutiveFailures);
          return;
        }
        rows.splice(0, batch.length);
        metrics.delivered += batch.length;
        metrics.consecutiveFailures = 0;
        metrics.lastSuccessAt = new Date().toISOString();
      }
    }
  } finally {
    flushing = false;
  }
}

export function getPipelineMetrics() {
  return {
    implemented: true,
    enabled: isClickHouseConfigured(),
    queued: bufferedCount(),
    capacity: MAX_BUFFER,
    ...metrics,
    retryingUntil: nextAttemptAt > Date.now() ? new Date(nextAttemptAt).toISOString() : null,
  };
}

export async function stopEventPipeline(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  nextAttemptAt = 0;
  try {
    await flushEvents();
  } catch {
    /* best effort */
  }
}

/** Test helper. */
export function resetPipelineForTests() {
  buffers.clear();
  nextAttemptAt = 0;
  Object.assign(metrics, { enqueued: 0, delivered: 0, dropped: 0, failedBatches: 0, consecutiveFailures: 0, lastFlushAt: null, lastSuccessAt: null, lastErrorAt: null, lastErrorKind: null });
}
