import { createHash } from "node:crypto";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { chRequest, isClickHouseConfigured } from "../services/infrastructure.js";
import { config } from "../config.js";
import { CLICKHOUSE_TABLES, type ClickHouseTable } from "./schema.js";

/**
 * Durable analytics delivery through a PostgreSQL transactional outbox.
 *
 * Writers insert an `analytics_outbox` row, ideally inside the SAME
 * transaction as the business write (`enqueueAnalyticsEvent(tx, …)`), so an
 * event exists if and only if its business change committed. A dispatcher
 * claims pending rows with FOR UPDATE SKIP LOCKED (safe across instances),
 * sends them to ClickHouse in batches, and marks them DISPATCHED. Failures back
 * off exponentially and become DEAD after MAX_ATTEMPTS, so nothing is lost on a
 * crash and nothing retries forever.
 *
 * ClickHouse being slow or down can never fail a transactional write: the
 * business transaction only touches PostgreSQL. When ClickHouse is not
 * configured nothing is enqueued (analytics stay idle, as before).
 *
 * Duplicates: a batch that ClickHouse committed but we failed to mark is
 * re-sent. Each batch carries a deterministic insert_deduplication_token and
 * the tables use ReplacingMergeTree keyed on event_id, so re-sends collapse.
 */

export interface AnalyticsEvent {
  table: ClickHouseTable;
  orgId: string;
  row: Record<string, unknown>;
}

const BATCH_SIZE = 500;
const DISPATCH_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 5 * 60_000;
const KNOWN_TABLES = new Set<string>(CLICKHOUSE_TABLES);

const metrics = {
  enqueued: 0,
  delivered: 0,
  failedBatches: 0,
  consecutiveFailures: 0,
  enqueueErrors: 0,
  lastFlushAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastErrorAt: null as string | null,
  lastErrorKind: null as string | null,
};
let timer: NodeJS.Timeout | null = null;
let dispatching = false;

/**
 * Insert an outbox row with the caller's query runner. Pass the transaction
 * client so the event commits (or rolls back) with the business write. Throws
 * on database errors so the caller's transaction fails closed.
 */
export async function enqueueAnalyticsEvent(db: Queryable, event: AnalyticsEvent): Promise<void> {
  if (!isClickHouseConfigured() || !event.orgId) return;
  if (!KNOWN_TABLES.has(event.table)) throw new Error(`Unknown analytics table: ${event.table}`);
  await db.query(
    "INSERT INTO analytics_outbox (org_id, target_table, payload) VALUES ($1, $2, $3::jsonb)",
    [event.orgId, event.table, JSON.stringify(event.row ?? {})],
  );
  metrics.enqueued++;
}

/**
 * Best-effort enqueue OUTSIDE a transaction, for callers whose business write
 * already committed. Never throws and never delays the caller beyond one
 * PostgreSQL insert; failures are counted, not propagated.
 */
export function trackEvent(table: ClickHouseTable, organizationId: string, row: Record<string, unknown>): void {
  try {
    if (!isClickHouseConfigured() || !organizationId) return;
    enqueueAnalyticsEvent({ query }, { table, orgId: organizationId, row }).catch(() => {
      metrics.enqueueErrors++;
    });
  } catch {
    metrics.enqueueErrors++;
  }
}

interface OutboxRow {
  id: string;
  event_id: string;
  org_id: string;
  target_table: ClickHouseTable;
  payload: Record<string, unknown>;
  event_time: Date | string;
  attempts: number;
}

/** Row sent to ClickHouse. Tenant and identity columns are set LAST so a payload can never override them. */
export function toClickHouseRow(r: OutboxRow): Record<string, unknown> {
  return {
    ...r.payload,
    event_id: r.event_id,
    organization_id: r.org_id,
    // ISO-8601 UTC with milliseconds: unambiguous for DateTime64(3, 'UTC').
    event_time: new Date(r.event_time).toISOString().replace("T", " ").replace("Z", ""),
  };
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempts));
}

type Sender = (sql: string) => Promise<{ status: number; body: string }>;
const defaultSender: Sender = (sql) => chRequest(sql, config.CLICKHOUSE_DATABASE);

/**
 * Dispatch one batch of due outbox rows. Returns the number delivered.
 * Exposed for the background loop, shutdown and tests.
 */
export async function dispatchOutbox(send: Sender = defaultSender): Promise<number> {
  if (dispatching || !isClickHouseConfigured()) return 0;
  dispatching = true;
  metrics.lastFlushAt = new Date().toISOString();
  try {
    return await withTransaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, event_id, org_id, target_table, payload, event_time, attempts
           FROM analytics_outbox
          WHERE status = 'PENDING' AND next_attempt_at <= NOW()
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (rows.length === 0) return 0;

      const byTable = new Map<ClickHouseTable, OutboxRow[]>();
      for (const r of rows) byTable.set(r.target_table, [...(byTable.get(r.target_table) ?? []), r]);

      let delivered = 0;
      for (const [table, batch] of byTable) {
        if (!KNOWN_TABLES.has(table)) {
          await markFailed(tx, batch, "unknown_table", true);
          continue;
        }
        const token = createHash("sha256").update(batch.map((r) => r.event_id).join(",")).digest("hex");
        const body = batch.map((r) => JSON.stringify(toClickHouseRow(r))).join("\n");
        let errorKind: string | null = null;
        try {
          const res = await send(
            `INSERT INTO ${table} SETTINGS insert_deduplication_token='${token}' FORMAT JSONEachRow\n${body}`,
          );
          if (res.status < 200 || res.status >= 300) errorKind = res.status === 401 || res.status === 403 ? "auth" : "insert";
        } catch (err) {
          errorKind = (err as { code?: string }).code === "TIMEOUT" ? "timeout" : "connection";
        }
        if (errorKind) {
          metrics.failedBatches++;
          metrics.consecutiveFailures++;
          metrics.lastErrorAt = new Date().toISOString();
          metrics.lastErrorKind = errorKind;
          await markFailed(tx, batch, errorKind, false);
          continue;
        }
        await tx.query(
          "UPDATE analytics_outbox SET status = 'DISPATCHED', dispatched_at = NOW(), last_error = NULL WHERE id = ANY($1::bigint[])",
          [batch.map((r) => r.id)],
        );
        delivered += batch.length;
        metrics.delivered += batch.length;
        metrics.consecutiveFailures = 0;
        metrics.lastSuccessAt = new Date().toISOString();
      }
      return delivered;
    });
  } finally {
    dispatching = false;
  }
}

async function markFailed(tx: Queryable, batch: OutboxRow[], kind: string, permanent: boolean): Promise<void> {
  for (const r of batch) {
    const attempts = r.attempts + 1;
    const dead = permanent || attempts >= MAX_ATTEMPTS;
    await tx.query(
      `UPDATE analytics_outbox
          SET attempts = $2, last_error = $3,
              status = CASE WHEN $4::boolean THEN 'DEAD' ELSE 'PENDING' END,
              next_attempt_at = NOW() + ($5::int * INTERVAL '1 millisecond')
        WHERE id = $1`,
      [r.id, attempts, kind, dead, backoffMs(attempts)],
    );
  }
}

/** Removes delivered rows older than the retention window (bounded batch). */
export async function pruneDispatchedOutbox(retentionDays = 7): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `WITH gone AS (
       DELETE FROM analytics_outbox
        WHERE id IN (SELECT id FROM analytics_outbox
                      WHERE status = 'DISPATCHED' AND dispatched_at < NOW() - ($1::int * INTERVAL '1 day')
                      LIMIT 5000)
       RETURNING 1)
     SELECT COUNT(*)::text AS n FROM gone`,
    [retentionDays],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getPipelineMetrics() {
  let counts = { pending: 0, dead: 0, dispatched: 0, oldestPendingAt: null as string | null };
  let countsAvailable = true;
  try {
    const { rows } = await query<{ pending: string; dead: string; dispatched: string; oldest: Date | null }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
              COUNT(*) FILTER (WHERE status = 'DEAD')::text AS dead,
              COUNT(*) FILTER (WHERE status = 'DISPATCHED')::text AS dispatched,
              MIN(created_at) FILTER (WHERE status = 'PENDING') AS oldest
         FROM analytics_outbox`,
    );
    const r = rows[0];
    if (r) counts = { pending: Number(r.pending), dead: Number(r.dead), dispatched: Number(r.dispatched), oldestPendingAt: r.oldest ? new Date(r.oldest).toISOString() : null };
  } catch {
    countsAvailable = false;
  }
  return {
    implemented: true,
    durable: true,
    enabled: isClickHouseConfigured(),
    countsAvailable,
    queued: counts.pending,
    dead: counts.dead,
    dispatchedRetained: counts.dispatched,
    oldestPendingAt: counts.oldestPendingAt,
    capacity: null,
    dropped: 0,
    ...metrics,
    retryingUntil: null,
  };
}

/** Starts the background dispatcher (idempotent; no-op in tests). */
export function startEventPipeline(): void {
  if (timer || config.NODE_ENV === "test") return;
  let ticks = 0;
  timer = setInterval(() => {
    dispatchOutbox().catch((err: unknown) => {
      metrics.lastErrorAt = new Date().toISOString();
      metrics.lastErrorKind = "dispatch";
      console.error(JSON.stringify({ event: "analytics_dispatch_failed", error: (err as Error).message }));
    });
    if (++ticks % 720 === 0) pruneDispatchedOutbox().catch(() => undefined); // ~hourly
  }, DISPATCH_INTERVAL_MS);
  timer.unref();
}

export async function stopEventPipeline(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    await dispatchOutbox(); // best effort; anything left stays PENDING in PostgreSQL
  } catch {
    /* rows remain durable */
  }
}

/** Kept for callers/tests that flush explicitly. */
export const flushEvents = dispatchOutbox;

/** Test helper. */
export function resetPipelineForTests() {
  dispatching = false;
  Object.assign(metrics, { enqueued: 0, delivered: 0, failedBatches: 0, consecutiveFailures: 0, enqueueErrors: 0, lastFlushAt: null, lastSuccessAt: null, lastErrorAt: null, lastErrorKind: null });
}
