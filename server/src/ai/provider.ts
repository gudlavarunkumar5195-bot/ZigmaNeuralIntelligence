import type { FailureCategory } from "./failures.js";

// ─── Model Provider Interface ─────────────────────────────────────────────────
//
// All LLM execution goes through this interface.
// Never bypass it to call providers directly from application code.

export type FinishReason = "stop" | "length" | "content_filter" | "cancelled" | "error";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  executionId: string;
  correlationId: string;
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json_object";
  /** Provider-side web search (OpenRouter "web" plugin). Billed separately; only set when explicitly enabled. */
  webSearch?: { maxResults: number };
  /**
   * Refuse any provider endpoint that would charge for the request (OpenRouter
   * provider.max_price of zero). Set for every free or trial model.
   */
  requireZeroPrice?: boolean;
  signal?: AbortSignal;
}

/** A source the provider itself attributes to the answer (never inferred from the text). */
export interface ProviderCitation {
  url: string;
  title: string | null;
  /** 1-based order in the provider's list. */
  position: number;
  kind: "provider_annotation" | "provider_citation_list";
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider cache, when reported. */
  cachedTokens?: number | null;
  /** Completion tokens spent on reasoning, when reported. */
  reasoningTokens?: number | null;
  /** Charged amount in USD as reported by the provider (0 for free models), when reported. */
  costUsd?: number | null;
}

export interface ModelResponse {
  executionId: string;
  model: string;       // resolved model (may differ from requested)
  provider: string;
  content: string;
  finishReason: FinishReason;
  usage: TokenUsage | null;
  durationMs: number;
  /** The provider's own request/generation id, when it returns one. */
  providerRequestId?: string | null;
  /** Citations returned in the provider's structured response (empty when none). */
  citations?: ProviderCitation[];
}

// ─── Error Types ──────────────────────────────────────────────────────────────

export type ProviderErrorCode =
  | "RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "CONTEXT_TOO_LONG"
  | "INVALID_REQUEST"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "MALFORMED_RESPONSE";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
    /** Phase 11 failure category; derived from the code when absent. */
    public readonly category?: FailureCategory,
    /** Provider-suggested wait before retrying (Retry-After / X-RateLimit-Reset), bounded. */
    public readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface ModelProvider {
  readonly name: string;
  execute(request: ModelRequest): Promise<ModelResponse>;
  isAvailable(): Promise<boolean>;
}
