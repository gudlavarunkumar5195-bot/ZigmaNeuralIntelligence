// Phase 11: retention for AI governance records. Bounded batches; audit_log
// is not touched (it is append-only and has its own retention procedure).

import { query } from "../db/client.js";
import { getRouterSettings } from "./router/settings.js";

const BATCH = 5_000;
const TABLES: Array<{ table: string; column: string }> = [
  { table: "ai_security_events", column: "created_at" },
  { table: "ai_model_evaluations", column: "created_at" },
  { table: "ai_token_reservations", column: "created_at" },
  { table: "ai_tool_approvals", column: "created_at" },
  { table: "ai_task_runs", column: "started_at" },
];

export async function pruneAiRecords(now = new Date()): Promise<Record<string, number>> {
  const { settings } = await getRouterSettings();
  const cutoff = new Date(now.getTime() - settings.retentionDays * 86_400_000).toISOString();
  const deleted: Record<string, number> = {};
  for (const { table, column } of TABLES) {
    // Table and column names come from the constant list above, never from input.
    const r = await query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT ${BATCH})`, [cutoff]);
    deleted[table] = r.rowCount ?? 0;
  }
  await query("DELETE FROM ai_provider_quota_days WHERE day < ($1::date - 30)", [cutoff.slice(0, 10)]);
  return deleted;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAiRetention(): void {
  if (timer) return;
  const run = () => pruneAiRecords()
    .then((d) => console.log(JSON.stringify({ event: "ai_retention_pruned", ...d })))
    .catch((err: unknown) => console.warn(JSON.stringify({ level: "warn", event: "ai_retention_failed", error: (err as Error).message.slice(0, 200) })));
  timer = setInterval(run, 24 * 60 * 60_000);
  timer.unref();
  setTimeout(run, 5 * 60_000).unref();
}
