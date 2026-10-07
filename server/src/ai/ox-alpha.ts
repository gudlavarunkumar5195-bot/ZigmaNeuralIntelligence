import { randomUUID } from "node:crypto";
import type { ModelProvider, ModelResponse } from "./provider.js";
import { ProviderError } from "./provider.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { query } from "../db/client.js";
import { audit } from "../services/audit.service.js";
import { config } from "../config.js";
import { assertOrgAiBudget, AiBudgetError } from "./budget.js";
import { AI_AGENT_DEADLINE_MS, AI_MAX_ATTEMPTS_PER_MODEL, AI_MAX_CALL_TIMEOUT_MS, AI_MAX_TOTAL_ATTEMPTS, clampInt } from "./limits.js";

// ─── Public API ────────────────────────────────────────────────────────────────

export interface OxAlphaRequest {
  /** Caller-supplied correlation ID; generated if absent. */
  correlationId?: string;
  /** Primary model to use. Defaults to config.OX_ALPHA_MODEL. */
  model?: string;
  /** Tried in order after the primary model is exhausted. */
  fallbackModels?: string[];
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** When true the response must be valid JSON; malformed JSON triggers retry. */
  requireJson?: boolean;
  /** Per-attempt wall-clock limit. Defaults to config.OX_ALPHA_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max attempts per model. Defaults to config.OX_ALPHA_MAX_RETRIES; clamped to AI_MAX_ATTEMPTS_PER_MODEL. */
  maxRetries?: number;
  /** Max provider calls across primary + fallback models; clamped to AI_MAX_TOTAL_ATTEMPTS. */
  maxTotalAttempts?: number;
  /** Absolute epoch-ms deadline for the whole execution (never extended beyond AI_AGENT_DEADLINE_MS). */
  deadlineAt?: number;
  /** Cooperative cancellation. Once aborted no further provider calls are made and the error is non-retryable. */
  signal?: AbortSignal;
  // Audit / tracing context
  agentType?: string;
  taskDescription?: string;
  scanId?: string;
  orgId?: string;
  userId?: string;
}

export interface OxAlphaResult {
  success: boolean;
  response: ModelResponse | null;
  /** Populated when requireJson=true and the response parsed successfully. */
  parsedJson: unknown;
  attempts: number;
  totalDurationMs: number;
  executionIds: string[];
  error?: string;
}

// ─── OX Alpha Executor ────────────────────────────────────────────────────────
//
// OX Alpha is the master orchestrator.  This class is the execution boundary:
// it handles retries, timeouts, JSON validation, fallback model selection,
// and audit logging.  It does NOT make domain decisions — those belong in the
// caller (planner / agent).

export class OxAlphaExecutor {
  constructor(private readonly provider: ModelProvider) {}

  async execute(req: OxAlphaRequest): Promise<OxAlphaResult> {
    const correlationId = req.correlationId ?? randomUUID();
    const primaryModel = req.model ?? config.OX_ALPHA_MODEL;
    const modelsToTry = [primaryModel, ...(req.fallbackModels ?? [])].filter(Boolean);
    const maxRetries = clampInt(req.maxRetries ?? config.OX_ALPHA_MAX_RETRIES, 3, 1, AI_MAX_ATTEMPTS_PER_MODEL);
    const maxTotalAttempts = clampInt(req.maxTotalAttempts, AI_MAX_TOTAL_ATTEMPTS, 1, AI_MAX_TOTAL_ATTEMPTS);
    const timeoutMs = clampInt(req.timeoutMs ?? config.OX_ALPHA_TIMEOUT_MS, 60_000, 1, AI_MAX_CALL_TIMEOUT_MS);

    const totalStart = Date.now();
    const deadlineAt = Math.min(req.deadlineAt ?? Number.POSITIVE_INFINITY, totalStart + AI_AGENT_DEADLINE_MS);
    const executionIds: string[] = [];
    let lastError: Error | undefined;
    let globalAttempt = 0;

    attempts: for (const model of modelsToTry) {
      for (let modelAttempt = 1; modelAttempt <= maxRetries; modelAttempt++) {
        if (globalAttempt >= maxTotalAttempts) {
          lastError = new ProviderError("PROVIDER_ERROR", `AI_ATTEMPT_LIMIT: gave up after ${globalAttempt} attempts`, false);
          break attempts;
        }
        if (req.signal?.aborted) {
          lastError = new ProviderError("CANCELLED", "AI_ABORTED: execution cancelled before provider call", false);
          break attempts;
        }
        if (req.orgId) {
          try {
            await assertOrgAiBudget(req.orgId);
          } catch (err: unknown) {
            lastError = err instanceof AiBudgetError ? err : new ProviderError("PROVIDER_ERROR", `BUDGET_CHECK_FAILED: ${(err as Error).message}`, false);
            break attempts;
          }
          if (req.signal?.aborted) {
            lastError = new ProviderError("CANCELLED", "AI_ABORTED: execution cancelled before provider call", false);
            break attempts;
          }
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          lastError = new ProviderError("TIMEOUT", "AI_DEADLINE_EXCEEDED: execution deadline reached", false);
          break attempts;
        }
        globalAttempt++;
        const executionId = randomUUID();
        executionIds.push(executionId);

        const dbId = await this.recordStart({
          executionId,
          correlationId,
          model,
          agentType: req.agentType ?? "ox_alpha",
          taskDescription: req.taskDescription ?? "",
          scanId: req.scanId,
          orgId: req.orgId,
          attemptNumber: globalAttempt,
        });

        const controller = new AbortController();
        const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
        let timedOut = false;
        const timeoutHandle = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Attempt timed out", "TimeoutError")); }, attemptTimeoutMs);

        const onCallerAbort = (): void => controller.abort(new DOMException("Execution aborted", "AbortError"));
        req.signal?.addEventListener("abort", onCallerAbort, { once: true });
        const attemptStart = Date.now();
        let response: ModelResponse | null = null;
        let execError: string | null = null;
        let execStatus: "completed" | "failed" = "failed";

        try {
          response = await this.provider.execute({
            executionId,
            correlationId,
            model,
            messages: req.messages,
            temperature: req.temperature,
            maxTokens: req.maxTokens ?? config.OX_ALPHA_MAX_OUTPUT_TOKENS,
            responseFormat: req.requireJson ? "json_object" : "text",
            signal: controller.signal,
          });
          execStatus = "completed";
        } catch (err: unknown) {
          lastError = err as Error;
          execError = (err as Error).message;

          if (req.signal?.aborted) {
            lastError = new ProviderError("CANCELLED", "AI_ABORTED: execution cancelled", false);
            await this.recordEnd(dbId, "failed", null, Date.now() - attemptStart, lastError.message);
            break attempts;
          }

          // Our own timer fired (F-031): a retryable TIMEOUT, not a caller cancellation.
          let retryable = err instanceof ProviderError ? err.retryable : true;
          if (timedOut || (err instanceof ProviderError && err.code === "TIMEOUT")) {
            lastError = new ProviderError("TIMEOUT", `Execution timed out after ${attemptTimeoutMs}ms`, true);
            execError = lastError.message;
            retryable = true;
          }

          await this.recordEnd(dbId, "failed", null, Date.now() - attemptStart, execError);
          if (!retryable) break; // skip remaining attempts for this model
          if (!(await backoff(modelAttempt, deadlineAt))) break attempts;
          continue;
        } finally {
          clearTimeout(timeoutHandle);
          req.signal?.removeEventListener("abort", onCallerAbort);
        }

        if (req.signal?.aborted) {
          lastError = new ProviderError("CANCELLED", "AI_ABORTED: execution cancelled", false);
          await this.recordEnd(dbId, "failed", response, response?.durationMs ?? 0, lastError.message);
          break attempts;
        }

        // Validate JSON when required
        if (req.requireJson && response) {
          if (response.finishReason === "length") {
            // Output hit the token cap: re-asking with the same cap would truncate identically.
            lastError = new ProviderError("MALFORMED_RESPONSE", "AI_OUTPUT_TRUNCATED: model output reached the token limit", false);
            execError = lastError.message;
            await this.recordEnd(dbId, "failed", response, response.durationMs, execError);
            break; // not retried against this model; the fallback chain may still be tried
          }
          let parsedJson: unknown;
          try {
            parsedJson = extractJson(response.content);
          } catch {
            lastError = new Error("Model returned invalid JSON");
            execError = lastError.message;
            await this.recordEnd(dbId, "failed", response, response.durationMs, execError);
            if (!(await backoff(modelAttempt, deadlineAt))) break attempts;
            continue; // retry
          }

          await this.recordEnd(dbId, "completed", response, response.durationMs, null);
          await this.auditExecution(correlationId, req.orgId, req.userId, req.scanId, "success");
          return {
            success: true,
            response,
            parsedJson,
            attempts: globalAttempt,
            totalDurationMs: Date.now() - totalStart,
            executionIds,
          };
        }

        await this.recordEnd(dbId, execStatus, response, response?.durationMs ?? 0, execError);

        if (execStatus === "completed" && response) {
          await this.auditExecution(correlationId, req.orgId, req.userId, req.scanId, "success");
          return {
            success: true,
            response,
            parsedJson: null,
            attempts: globalAttempt,
            totalDurationMs: Date.now() - totalStart,
            executionIds,
          };
        }
      }
    }

    // All models and retries exhausted
    await this.auditExecution(correlationId, req.orgId, req.userId, req.scanId, "failure");
    return {
      success: false,
      response: null,
      parsedJson: null,
      attempts: globalAttempt,
      totalDurationMs: Date.now() - totalStart,
      executionIds,
      error: lastError?.message ?? "All execution attempts failed",
    };
  }

  // ─── DB helpers ─────────────────────────────────────────────────────────────

  private async recordStart(params: {
    executionId: string;
    correlationId: string;
    model: string;
    agentType: string;
    taskDescription: string;
    scanId?: string;
    orgId?: string;
    attemptNumber: number;
  }): Promise<string> {
    if (!params.scanId || !params.orgId) return "";
    try {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO agent_executions
            (scan_id, org_id, agent_type, model_id, task, status,
            attempt_number, execution_kind, logical_execution_id, started_at, correlation_id, execution_id, provider)
          VALUES ($1, $2, $3, $4, $5, 'running', $6, 'MODEL_ATTEMPT', $7, NOW(), $7, $8, $9)
         RETURNING id`,
        [
          params.scanId, params.orgId, params.agentType, params.model,
          params.taskDescription, params.attemptNumber,
          params.correlationId, params.executionId, this.provider.name,
        ]
      );
      return rows[0]?.id ?? "";
    } catch (err: unknown) {
      // DB errors must never crash AI execution, but must not vanish either.
      console.warn(`[ox-alpha] failed to record execution start: ${(err as Error).message}`);
      return "";
    }
  }

  private async recordEnd(
    dbId: string,
    status: "completed" | "failed",
    response: ModelResponse | null,
    durationMs: number,
    error: string | null
  ): Promise<void> {
    if (!dbId) return;
    try {
      await query(
        `UPDATE agent_executions
         SET status = $2, completed_at = NOW(), latency_ms = $3, error = $4,
             prompt_tokens = $5, completion_tokens = $6, finish_reason = $7
         WHERE id = $1`,
        [
          dbId, status, durationMs, error,
          response?.usage?.promptTokens ?? null,
          response?.usage?.completionTokens ?? null,
          response?.finishReason ?? null,
        ]
      );
    } catch (err: unknown) {
      // Audit-trail failures must never crash AI execution, but must not vanish either.
      console.warn(`[ox-alpha] failed to record execution end: ${(err as Error).message}`);
    }
  }

  private async auditExecution(
    correlationId: string,
    orgId?: string,
    userId?: string,
    scanId?: string,
    result: "success" | "failure" = "success"
  ): Promise<void> {
    await audit({
      userId,
      orgId,
      action: "ox_alpha_execution",
      resourceType: "scan",
      resourceId: scanId as unknown as string,
      result,
      metadata: { correlationId, provider: this.provider.name },
    });
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────
//
// Returns null when no API key is configured — callers must handle this case
// and surface an appropriate "integration required" state, not a fake result.

let _executor: OxAlphaExecutor | null = null;

export function getOxAlphaExecutor(): OxAlphaExecutor | null {
  if (!config.OPENROUTER_API_KEY) return null;
  if (!_executor) {
    _executor = new OxAlphaExecutor(new OpenRouterProvider(config.OPENROUTER_API_KEY));
  }
  return _executor;
}

/**
 * Parses model JSON output. Accepts plain JSON, a ```json fenced block, or a
 * single JSON object embedded in prose. Throws when nothing parses.
 */
export function extractJson(content: string): unknown {
  const text = content.trim();
  try { return JSON.parse(text); } catch { /* fall through to tolerant extraction */ }
  const fences = [...text.matchAll(/```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const candidate of fences) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return JSON.parse(text.slice(first, last + 1));
  throw new SyntaxError("No JSON object found in model output");
}

/** Sleeps with exponential backoff; returns false (without sleeping) when the deadline cannot accommodate it. */
async function backoff(attempt: number, deadlineAt: number): Promise<boolean> {
  const delay = Math.min(500 * Math.pow(2, attempt - 1), 4_000);
  if (Date.now() + delay >= deadlineAt) return false;
  await sleep(delay);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
