import { query, withTransaction, type Queryable } from "../db/client.js";
import { config } from "../config.js";

/** Default hard ceiling on provider calls per organization per rolling 24h. */
export const DEFAULT_AI_MAX_EXECUTIONS_PER_ORG_PER_DAY = 500;

export class AiBudgetError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly retryable = false;
  constructor(public readonly organizationId: string, public readonly used: number, public readonly limit: number) {
    super(`BUDGET_EXCEEDED: organization AI execution limit reached (${used}/${limit} in the last 24h)`);
    this.name = "AiBudgetError";
  }
}

export function aiDailyLimit(): number {
  const value = (config as { AI_MAX_EXECUTIONS_PER_ORG_PER_DAY?: number }).AI_MAX_EXECUTIONS_PER_ORG_PER_DAY;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_AI_MAX_EXECUTIONS_PER_ORG_PER_DAY;
}

/** Counts model attempts recorded for the organization in the rolling last 24 hours. */
export async function countOrgAiExecutions(organizationId: string): Promise<number> {
  const { rows } = await query<{ count: string | number }>(
    "SELECT COUNT(*) AS count FROM agent_executions WHERE org_id=$1 AND execution_kind='MODEL_ATTEMPT' AND started_at > NOW() - INTERVAL '24 hours'",
    [organizationId],
  );
  const n = Number(rows[0]?.count);
  return Number.isFinite(n) ? n : 0;
}

/** Throws AiBudgetError (no provider call may follow) when the org has used its rolling-24h allowance. */
export async function assertOrgAiBudget(organizationId: string): Promise<void> {
  const limit = aiDailyLimit();
  const used = await countOrgAiExecutions(organizationId);
  if (used >= limit) throw new AiBudgetError(organizationId, used, limit);
}

/**
 * P0-6: atomic budget reservation. Under a per-organization transaction-scoped
 * advisory lock, counts the rolling-24h attempts and, only if below the limit,
 * inserts the attempt row (via `insertAttempt`, which must write the
 * agent_executions MODEL_ATTEMPT row with the given client) in the SAME
 * transaction. Concurrent callers for one org serialise on the lock, so N
 * parallel agents can never overshoot the limit. Returns the inserted row id.
 */
export async function reserveOrgAiAttempt(
  organizationId: string,
  insertAttempt: (tx: Queryable) => Promise<string>,
  /** Router settings may lower (never raise) the deployment's daily limit. */
  settingsLimit?: number,
): Promise<string> {
  const limit = settingsLimit !== undefined && Number.isFinite(settingsLimit) && settingsLimit >= 0 ? Math.min(aiDailyLimit(), Math.floor(settingsLimit)) : aiDailyLimit();
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ai-budget:${organizationId}`]);
    const { rows } = await tx.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM agent_executions WHERE org_id=$1 AND execution_kind='MODEL_ATTEMPT' AND started_at > NOW() - INTERVAL '24 hours'",
      [organizationId],
    );
    const used = Number(rows[0]?.count);
    const usedSafe = Number.isFinite(used) ? used : 0;
    if (usedSafe >= limit) throw new AiBudgetError(organizationId, usedSafe, limit);
    const id = await insertAttempt(tx);
    if (!id) throw new Error("AI attempt was not recorded; refusing an unbudgeted provider call");
    return id;
  });
}

/**
 * Legacy check kept for compatibility; the executor uses the full Phase 11
 * gate in governance.checkCallableModel (pricing class, trial, freshness).
 * Paid models stay disabled until pricing and spend limits are verified
 * (AI_ALLOW_PAID_MODELS=true). A model is callable only when the registry
 * records it as FREE; unknown models fail closed.
 */
export async function isModelCallable(modelId: string): Promise<boolean> {
  if ((config as { AI_ALLOW_PAID_MODELS?: boolean }).AI_ALLOW_PAID_MODELS === true) return true;
  const { rows } = await query<{ free_status: string }>(
    "SELECT free_status FROM models WHERE openrouter_id = $1 LIMIT 1",
    [modelId],
  );
  return rows[0]?.free_status === "FREE";
}
