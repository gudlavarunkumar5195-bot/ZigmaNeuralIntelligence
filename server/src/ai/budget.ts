import { query } from "../db/client.js";
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
