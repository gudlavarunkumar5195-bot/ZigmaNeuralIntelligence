// Test double for the Phase 11 governance queries made by OxAlphaExecutor.
//
// Executor unit tests mock db/client with a query function keyed on SQL text.
// This wraps a test's own responder: governance tables (settings, quota,
// tokens, task runs, health, evaluations, security events) get neutral
// answers, and the call-time model gate is derived from the test's existing
// "FROM models" answer (free_status FREE → pricing class FREE, PAID → PAID,
// anything else → UNKNOWN), so each test keeps its own notion of which models
// are free.

type Row = Record<string, unknown>;
type Result = { rows: Row[]; rowCount?: number };
type Responder = (sql: string, params?: unknown[]) => Promise<Result> | Result;

export interface GovernanceDbOptions {
  /** Per-minute attempts already made across the account (pace check). */
  attemptsLastMinute?: number;
  /** Free-pool requests already used today. */
  freeRequestsUsed?: number;
  /** Tokens already used by the organization in the last 24h. */
  orgTokensUsed?: number;
  contextLength?: number;
}

export function governanceDb(legacy: Responder, opts: GovernanceDbOptions = {}): (sql: string, params?: unknown[]) => Promise<Result> {
  return async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM ai_router_settings")) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock") && sql.includes("ai-quota")) return { rows: [] };
    if (sql.includes("INSERT INTO ai_provider_quota_days")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM ai_provider_quota_days")) return { rows: [{ requests: opts.freeRequestsUsed ?? 0, provider_limit: null, provider_used: null, provider_synced_at: null, exhausted_until: null, pool: "FREE" }] };
    if (sql.includes("UPDATE ai_provider_quota_days")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS n, MIN(started_at)")) return { rows: [{ n: String(opts.attemptsLastMinute ?? 0), oldest: null }] };
    if (sql.includes("FROM ai_token_reservations") && sql.includes("AS used")) return { rows: [{ used: String(opts.orgTokensUsed ?? 0) }] };
    if (sql.includes("INSERT INTO ai_token_reservations")) return { rows: [{ id: "reservation-1" }] };
    if (sql.includes("UPDATE ai_token_reservations")) return { rows: [{ task_run_id: null, reserved_tokens: 0 }], rowCount: 1 };
    if (sql.includes("INSERT INTO ai_task_runs")) return { rows: [{ id: "task-run-1" }] };
    if (sql.includes("SELECT tokens_reserved") && sql.includes("ai_task_runs")) return { rows: [{ tokens_reserved: "0", tokens_used: "0", calls_used: 0, limits: {} }] };
    if (sql.includes("ai_task_runs")) return { rows: [], rowCount: 1 };
    if (sql.includes("ai_model_health")) return { rows: [] };
    if (sql.includes("ai_model_evaluations") || sql.includes("ai_security_events")) return { rows: [], rowCount: 1 };
    if (sql.includes("percentile_cont(0.9)")) return { rows: [{ p90: null, n: "0" }] };
    if (sql.includes("model_reliability")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM models WHERE openrouter_id") && sql.includes("pricing_class")) {
      const legacyRows = (await legacy("SELECT free_status FROM models WHERE openrouter_id = $1", params)).rows;
      const fs = legacyRows[0]?.free_status;
      if (legacyRows.length === 0) return { rows: [] };
      return {
        rows: [{
          openrouter_id: String(params[0]), enabled: true, status: "AVAILABLE", eligibility_status: "ELIGIBLE", free_status: fs ?? "UNKNOWN",
          pricing_class: fs === "FREE" ? "FREE" : fs === "PAID" ? "PAID" : "UNKNOWN", pricing_checked_at: new Date(), expires_at: null,
          context_length: opts.contextLength ?? 128_000, max_completion_tokens: null, reasoning_mandatory: false, is_router: false,
        }],
      };
    }
    return legacy(sql, params);
  };
}
