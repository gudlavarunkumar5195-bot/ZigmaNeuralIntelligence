import { randomUUID } from "node:crypto";
import type { ModelProvider, ModelResponse } from "./provider.js";
import { ProviderError } from "./provider.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { query } from "../db/client.js";
import { audit } from "../services/audit.service.js";
import { config } from "../config.js";

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
  /** Max attempts per model. Defaults to config.OX_ALPHA_MAX_RETRIES. */
  maxRetries?: number;
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
    const maxRetries = req.maxRetries ?? config.OX_ALPHA_MAX_RETRIES;
    const timeoutMs = req.timeoutMs ?? config.OX_ALPHA_TIMEOUT_MS;

    const totalStart = Date.now();
    const executionIds: string[] = [];
    let lastError: Error | undefined;
    let globalAttempt = 0;

    for (const model of modelsToTry) {
      for (let modelAttempt = 1; modelAttempt <= maxRetries; modelAttempt++) {
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
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

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

          // Cancelled by timeout
          if ((err as Error).name === "AbortError") {
            lastError = new ProviderError("TIMEOUT", `Execution timed out after ${timeoutMs}ms`, false);
            execError = lastError.message;
          }

          const retryable = err instanceof ProviderError ? err.retryable : true;
          await this.recordEnd(dbId, "failed", null, Date.now() - totalStart, execError);
          if (!retryable) break; // skip remaining attempts for this model
          await sleep(Math.min(500 * Math.pow(2, modelAttempt - 1), 4_000));
          continue;
        } finally {
          clearTimeout(timeoutHandle);
        }

        // Validate JSON when required
        if (req.requireJson && response) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(response.content);
          } catch {
            lastError = new Error("Model returned invalid JSON");
            execError = lastError.message;
            await this.recordEnd(dbId, "failed", response, response.durationMs, execError);
            await sleep(Math.min(500 * Math.pow(2, modelAttempt - 1), 4_000));
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
    } catch {
      // DB errors must never crash AI execution
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
    } catch { /* never crash */ }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
