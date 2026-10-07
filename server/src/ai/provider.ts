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
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  executionId: string;
  model: string;       // resolved model (may differ from requested)
  provider: string;
  content: string;
  finishReason: FinishReason;
  usage: TokenUsage | null;
  durationMs: number;
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
    public readonly httpStatus?: number
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
