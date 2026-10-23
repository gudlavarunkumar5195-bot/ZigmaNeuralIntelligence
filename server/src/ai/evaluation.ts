// Phase 11: result evaluation and user feedback.
//
// Every completed model attempt is evaluated by deterministic validators
// (non-empty, JSON validity, truncation, the output security guard and any
// task-specific validator the caller supplies). Structural checks alone
// cannot show that an answer is correct, so their confidence is LOW; a
// task-specific validator (schema, evidence ids, citations) raises it.
// Evaluator-model scores, when used, are one more signal — never ground truth.

import { query } from "../db/client.js";

export type EvaluationOutcome = "PASS" | "PARTIAL" | "FAIL";
export type EvaluationMethod = "DETERMINISTIC" | "EVALUATOR_MODEL" | "USER_FEEDBACK";
export type EvaluationConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface ValidatorResult { name: string; passed: boolean; detail?: string }

/** Optional task-specific validation supplied by the calling feature. */
export type OutputValidator = (content: string, parsedJson: unknown) => { ok: boolean; issues: string[] };

export interface DeterministicEvaluation {
  outcome: EvaluationOutcome;
  score: number;
  confidence: EvaluationConfidence;
  validators: ValidatorResult[];
  securityViolation: boolean;
}

export function evaluateDeterministically(input: {
  content: string;
  requireJson: boolean;
  jsonValid: boolean | null;
  truncated: boolean;
  guardViolations: string[];
  taskValidation?: { ok: boolean; issues: string[] } | null;
}): DeterministicEvaluation {
  const validators: ValidatorResult[] = [];
  let score = 100;
  const nonEmpty = input.content.trim().length > 0;
  validators.push({ name: "non_empty", passed: nonEmpty });
  if (!nonEmpty) score = 0;
  if (input.requireJson) {
    validators.push({ name: "json_valid", passed: input.jsonValid === true });
    if (input.jsonValid !== true) score = Math.min(score, 20);
  }
  validators.push({ name: "not_truncated", passed: !input.truncated });
  if (input.truncated) score -= 30;
  const guardOk = input.guardViolations.length === 0;
  validators.push({ name: "output_guard", passed: guardOk, detail: guardOk ? undefined : input.guardViolations.slice(0, 5).join(", ") });
  if (!guardOk) score = 0;
  if (input.taskValidation) {
    validators.push({ name: "task_validator", passed: input.taskValidation.ok, detail: input.taskValidation.issues.slice(0, 5).join("; ").slice(0, 300) || undefined });
    if (!input.taskValidation.ok) score = Math.min(score, 35);
    score -= Math.min(45, 15 * input.taskValidation.issues.length);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const outcome: EvaluationOutcome = score >= 70 ? "PASS" : score >= 40 ? "PARTIAL" : "FAIL";
  return {
    outcome,
    score,
    confidence: input.taskValidation ? "MEDIUM" : "LOW",
    validators,
    securityViolation: !guardOk,
  };
}

export async function recordEvaluation(e: {
  orgId: string;
  taskRunId: string | null;
  executionId: string | null;
  model: string;
  taskType: string;
  outcome: EvaluationOutcome;
  score: number;
  method: EvaluationMethod;
  confidence: EvaluationConfidence;
  validators: ValidatorResult[];
  securityViolation: boolean;
  latencyMs?: number | null;
  totalTokens?: number | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_model_evaluations (org_id, task_run_id, execution_id, model, task_type, outcome, quality_score, method, confidence, validators, security_violation, latency_ms, total_tokens, catalog_refresh_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               (SELECT id FROM catalog_refreshes WHERE status='completed' ORDER BY completed_at DESC NULLS LAST LIMIT 1))`,
      [e.orgId, e.taskRunId, e.executionId, e.model, e.taskType.slice(0, 60), e.outcome, e.score, e.method, e.confidence, JSON.stringify(e.validators), e.securityViolation, e.latencyMs ?? null, e.totalTokens ?? null],
    );
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_evaluation_write_failed", error: (err as Error).message }));
  }
}

export class FeedbackError extends Error {
  constructor(public readonly status: 404 | 409, message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

const FEEDBACK_SCORE = { 1: 85, [-1]: 25 } as const;

/**
 * Records one user's rating of one task result and turns it into a LOW
 * confidence evaluation of the model that produced it. One vote per user per
 * task; with the prior and decay in learning.ts a single rating moves a
 * model's quality estimate by a few points at most.
 */
export async function recordUserFeedback(input: { orgId: string; taskRunId: string; userId: string; rating: 1 | -1; reason?: string | null }): Promise<void> {
  const { rows } = await query<{ selected_model: string | null; task_type: string; status: string }>(
    "SELECT selected_model, task_type, status FROM ai_task_runs WHERE id=$1 AND org_id=$2",
    [input.taskRunId, input.orgId],
  );
  const run = rows[0];
  if (!run || run.status !== "COMPLETED" || !run.selected_model) throw new FeedbackError(404, "No completed AI result with that id");
  const inserted = await query(
    "INSERT INTO ai_feedback (org_id, task_run_id, user_id, rating, reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (task_run_id, user_id) DO NOTHING RETURNING id",
    [input.orgId, input.taskRunId, input.userId, input.rating, input.reason ?? null],
  );
  if ((inserted.rowCount ?? 0) === 0) throw new FeedbackError(409, "You already rated this result");
  await recordEvaluation({
    orgId: input.orgId,
    taskRunId: input.taskRunId,
    executionId: null,
    model: run.selected_model,
    taskType: run.task_type,
    outcome: input.rating === 1 ? "PASS" : "FAIL",
    score: FEEDBACK_SCORE[input.rating],
    method: "USER_FEEDBACK",
    confidence: "LOW",
    validators: [{ name: "user_feedback", passed: input.rating === 1, detail: input.reason ?? undefined }],
    securityViolation: false,
  });
}
