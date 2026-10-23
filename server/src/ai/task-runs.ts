// Phase 11: task runs and token budgets.
//
// A task run is one bounded AI task (a single generation or a multi-agent
// run). Before every provider call, tokens are RESERVED inside the same
// transaction that records the attempt, under the organization's advisory
// lock, against both the organization's rolling 24-hour token budget and the
// task's own limits. Concurrent agents therefore cannot overspend the same
// remaining budget. After the call the reservation is SETTLED with the
// provider-reported usage (or, when the provider reports none, with the
// estimate, marked ESTIMATED), and RELEASED when no request was sent.

import { query, type Queryable } from "../db/client.js";
import type { RouterSettings } from "./router/settings.js";
import type { TokenUsage } from "./provider.js";

export type Feasibility = "FEASIBLE" | "FEASIBLE_WITH_REDUCTION" | "SPLIT_REQUIRED" | "INSUFFICIENT_BUDGET" | "NO_ELIGIBLE_MODEL" | "BLOCKED_BY_POLICY";
export type TaskRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "REJECTED";

export interface TaskLimits {
  maxTotalTokens: number;
  maxCalls: number;
  maxAgents: number;
  maxDepth: number;
  maxConcurrency: number;
  maxWallClockMs: number;
}

export function taskLimitsFrom(settings: RouterSettings, override?: Partial<TaskLimits>): TaskLimits {
  const t = settings.perTask;
  // An override may only lower a limit.
  const low = (a: number, b?: number) => (b !== undefined && Number.isFinite(b) && b > 0 ? Math.min(a, Math.floor(b)) : a);
  return {
    maxTotalTokens: low(t.maxTotalTokens, override?.maxTotalTokens),
    maxCalls: low(t.maxCalls, override?.maxCalls),
    maxAgents: low(t.maxAgents, override?.maxAgents),
    maxDepth: Math.min(t.maxDepth, override?.maxDepth ?? t.maxDepth),
    maxConcurrency: low(t.maxConcurrency, override?.maxConcurrency),
    maxWallClockMs: low(t.maxWallClockMs, override?.maxWallClockMs),
  };
}

export class TokenBudgetError extends Error {
  readonly code = "TOKEN_BUDGET_EXCEEDED";
  readonly retryable = false;
  constructor(public readonly scope: "organization" | "task" | "calls", message: string) {
    super(`TOKEN_BUDGET_EXCEEDED: ${message}`);
    this.name = "TokenBudgetError";
  }
}

export interface CreateTaskRunInput {
  orgId: string;
  taskType: string;
  feature: string;
  feasibility: Feasibility;
  feasibilityDetail?: Record<string, unknown>;
  limits: TaskLimits;
  createdBy?: string | null;
  correlationId?: string | null;
  scanId?: string | null;
  researchRunId?: string | null;
  aivBrandId?: string | null;
  status?: TaskRunStatus;
}

export async function createTaskRun(input: CreateTaskRunInput, db: Queryable = { query }): Promise<string> {
  const deadline = new Date(Date.now() + input.limits.maxWallClockMs).toISOString();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_task_runs (org_id, task_type, feature, status, feasibility, feasibility_detail, limits, created_by, correlation_id, scan_id, research_run_id, aiv_brand_id, deadline_at, completed_at)
     VALUES ($1,$2,$3,$4::varchar,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $4::varchar = 'RUNNING' THEN NULL ELSE NOW() END)
     RETURNING id`,
    [
      input.orgId, input.taskType.slice(0, 60), input.feature.slice(0, 60), input.status ?? "RUNNING", input.feasibility,
      JSON.stringify(input.feasibilityDetail ?? {}), JSON.stringify(input.limits), input.createdBy ?? null, input.correlationId ?? null,
      input.scanId ?? null, input.researchRunId ?? null, input.aivBrandId ?? null, deadline,
    ],
  );
  return rows[0].id;
}

export async function finishTaskRun(id: string, orgId: string, status: Exclude<TaskRunStatus, "RUNNING">, fields: { errorCode?: string | null; selectedModel?: string | null; feasibility?: Feasibility } = {}): Promise<void> {
  try {
    await query(
      `UPDATE ai_task_runs SET status=$3, error_code=COALESCE($4, error_code), selected_model=COALESCE($5, selected_model),
              feasibility=COALESCE($6, feasibility), completed_at=NOW()
        WHERE id=$1 AND org_id=$2 AND status='RUNNING'`,
      [id, orgId, status, fields.errorCode?.slice(0, 60) ?? null, fields.selectedModel ?? null, fields.feasibility ?? null],
    );
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_task_run_finish_failed", error: (err as Error).message }));
  }
}

export async function requestTaskCancel(id: string, orgId: string): Promise<boolean> {
  const { rowCount } = await query("UPDATE ai_task_runs SET cancel_requested=TRUE WHERE id=$1 AND org_id=$2 AND status='RUNNING'", [id, orgId]);
  return (rowCount ?? 0) > 0;
}

export async function isTaskCancelRequested(id: string, orgId: string): Promise<boolean> {
  const { rows } = await query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM ai_task_runs WHERE id=$1 AND org_id=$2", [id, orgId]);
  return rows[0]?.cancel_requested === true;
}

// ─── Token reservations ───────────────────────────────────────────────────────

export interface ReserveTokensInput {
  orgId: string;
  taskRunId: string | null;
  model: string;
  estimatedInput: number;
  estimatedOutput: number;
  settings: RouterSettings;
}

/** Tokens charged against the org's rolling 24h budget: settled actuals, plus outstanding reservations. */
export async function orgTokensUsed(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ used: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN status='SETTLED' THEN COALESCE(actual_input,0) + COALESCE(actual_output,0) ELSE reserved_tokens END), 0) AS used
       FROM ai_token_reservations
      WHERE org_id=$1 AND status <> 'RELEASED' AND created_at > NOW() - INTERVAL '24 hours'`,
    [orgId],
  );
  return Number(rows[0]?.used ?? 0);
}

/**
 * Reserves tokens for one call. Must run inside the transaction that holds the
 * organization's AI advisory lock (see reserveOrgAiAttempt), so concurrent
 * reservations for one organization serialize.
 */
export async function reserveTokens(tx: Queryable, input: ReserveTokensInput): Promise<string> {
  const reserve = Math.max(0, Math.ceil(input.estimatedInput)) + Math.max(0, Math.ceil(input.estimatedOutput));
  const orgUsed = await orgTokensUsed(tx, input.orgId);
  if (orgUsed + reserve > input.settings.perOrg.dailyTokens) {
    throw new TokenBudgetError("organization", `organization token budget (${orgUsed} used + ${reserve} needed > ${input.settings.perOrg.dailyTokens} per 24h)`);
  }
  if (input.taskRunId) {
    const { rows } = await tx.query<{ tokens_reserved: string; tokens_used: string; calls_used: number; limits: { maxTotalTokens?: number; maxCalls?: number } }>(
      "SELECT tokens_reserved, tokens_used, calls_used, limits FROM ai_task_runs WHERE id=$1 AND org_id=$2 FOR UPDATE",
      [input.taskRunId, input.orgId],
    );
    const run = rows[0];
    if (!run) throw new TokenBudgetError("task", "task run not found for this organization");
    const maxTokens = Number(run.limits?.maxTotalTokens ?? input.settings.perTask.maxTotalTokens);
    const maxCalls = Number(run.limits?.maxCalls ?? input.settings.perTask.maxCalls);
    if (run.calls_used >= maxCalls) throw new TokenBudgetError("calls", `task call limit reached (${run.calls_used}/${maxCalls})`);
    const committed = Number(run.tokens_reserved) + Number(run.tokens_used);
    if (committed + reserve > maxTokens) {
      throw new TokenBudgetError("task", `task token budget (${committed} committed + ${reserve} needed > ${maxTokens})`);
    }
    await tx.query("UPDATE ai_task_runs SET tokens_reserved = tokens_reserved + $3, calls_used = calls_used + 1 WHERE id=$1 AND org_id=$2", [input.taskRunId, input.orgId, reserve]);
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ai_token_reservations (org_id, task_run_id, model, estimated_input, estimated_output, reserved_tokens)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.orgId, input.taskRunId, input.model, Math.ceil(input.estimatedInput), Math.ceil(input.estimatedOutput), reserve],
  );
  return rows[0].id;
}

export interface SettleResult { totalTokens: number; source: "PROVIDER" | "ESTIMATED" }

/**
 * Settles a reservation. With provider usage the actual counts are recorded;
 * without it the estimate stands (input estimate, output estimated from the
 * returned text) and is marked ESTIMATED — never presented as provider-confirmed.
 */
export async function settleReservation(id: string, orgId: string, usage: TokenUsage | null, fallback: { input: number; output: number }, executionRowId?: string | null): Promise<SettleResult> {
  const source = usage ? "PROVIDER" : "ESTIMATED";
  const input = usage ? usage.promptTokens : Math.ceil(fallback.input);
  const output = usage ? usage.completionTokens : Math.ceil(fallback.output);
  try {
    const { rows } = await query<{ task_run_id: string | null; reserved_tokens: number }>(
      `UPDATE ai_token_reservations
          SET status='SETTLED', actual_input=$3, actual_output=$4, cached_tokens=$5, reasoning_tokens=$6, usage_source=$7,
              cost_usd=$8, execution_id=COALESCE($9, execution_id), settled_at=NOW()
        WHERE id=$1 AND org_id=$2 AND status='RESERVED'
        RETURNING task_run_id, reserved_tokens`,
      [id, orgId, input, output, usage?.cachedTokens ?? null, usage?.reasoningTokens ?? null, source, usage?.costUsd ?? null, executionRowId ?? null],
    );
    const r = rows[0];
    if (r?.task_run_id) {
      await query(
        "UPDATE ai_task_runs SET tokens_reserved = GREATEST(0, tokens_reserved - $3), tokens_used = tokens_used + $4 WHERE id=$1 AND org_id=$2",
        [r.task_run_id, orgId, r.reserved_tokens, input + output],
      );
    }
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_token_settle_failed", error: (err as Error).message }));
  }
  return { totalTokens: input + output, source };
}

/** Releases a reservation for a call that was never sent. */
export async function releaseReservation(id: string, orgId: string): Promise<void> {
  try {
    const { rows } = await query<{ task_run_id: string | null; reserved_tokens: number }>(
      "UPDATE ai_token_reservations SET status='RELEASED', settled_at=NOW() WHERE id=$1 AND org_id=$2 AND status='RESERVED' RETURNING task_run_id, reserved_tokens",
      [id, orgId],
    );
    const r = rows[0];
    if (r?.task_run_id) {
      await query("UPDATE ai_task_runs SET tokens_reserved = GREATEST(0, tokens_reserved - $3), calls_used = GREATEST(0, calls_used - 1) WHERE id=$1 AND org_id=$2", [r.task_run_id, orgId, r.reserved_tokens]);
    }
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_token_release_failed", error: (err as Error).message }));
  }
}
