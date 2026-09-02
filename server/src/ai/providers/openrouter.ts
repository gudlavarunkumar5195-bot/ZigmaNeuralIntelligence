import type { ModelProvider, ModelRequest, ModelResponse } from "../provider.js";
import { ProviderError } from "../provider.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── OpenRouter provider ───────────────────────────────────────────────────────
//
// All credentials are provided at construction time.
// The caller (OxAlphaExecutor) reads config; this class does not import config
// directly, keeping it testable without env side-effects.

export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly siteUrl = "https://zignaneural.com",
    private readonly appTitle = "ZigmaNeural"
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async execute(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) {
      throw new ProviderError("MODEL_UNAVAILABLE", "OpenRouter API key not configured", false);
    }

    const start = Date.now();

    const body: OpenRouterRequestBody = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.1,
    };

    if (request.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    let res: Response;
    try {
      res = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        signal: request.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.appTitle,
          "X-Correlation-ID": request.correlationId,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        throw new ProviderError("CANCELLED", "Request cancelled", false);
      }
      throw new ProviderError(
        "PROVIDER_ERROR",
        `Network error: ${(err as Error).message}`,
        true
      );
    }

    const durationMs = Date.now() - start;

    // HTTP-level errors
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new ProviderError(
        "RATE_LIMITED",
        `Rate limited${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
        true,
        429
      );
    }
    if (res.status === 503 || res.status === 502) {
      throw new ProviderError("PROVIDER_ERROR", `Provider unavailable (HTTP ${res.status})`, true, res.status);
    }
    if (res.status === 400) {
      let detail = "";
      try {
        const b = await res.json() as { error?: { message?: string } };
        detail = b.error?.message ?? "";
      } catch { /* ignore parse failure */ }
      throw new ProviderError("INVALID_REQUEST", `Invalid request: ${detail}`, false, 400);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("INVALID_REQUEST", `Authentication failed (HTTP ${res.status})`, false, res.status);
    }
    if (!res.ok) {
      throw new ProviderError(
        "PROVIDER_ERROR",
        `HTTP ${res.status}`,
        res.status >= 500,
        res.status
      );
    }

    let raw: OpenRouterResponse;
    try {
      raw = (await res.json()) as OpenRouterResponse;
    } catch {
      throw new ProviderError("MALFORMED_RESPONSE", "Provider response is not valid JSON", false);
    }

    // Model-level error embedded in a 200 response (OpenRouter pattern)
    if (raw.error) {
      const code = raw.error.code ?? 0;
      if (code === 429) {
        throw new ProviderError("RATE_LIMITED", raw.error.message, true, 429);
      }
      // 503 from OpenRouter means model not available — check before generic 5xx
      if (code === 503) {
        throw new ProviderError("MODEL_UNAVAILABLE", raw.error.message, false, 503);
      }
      if (typeof code === "number" && code >= 500) {
        throw new ProviderError("PROVIDER_ERROR", raw.error.message, true, code);
      }
      throw new ProviderError("PROVIDER_ERROR", raw.error.message, false, typeof code === "number" ? code : undefined);
    }

    const choice = raw.choices?.[0];
    if (!choice) {
      throw new ProviderError("MALFORMED_RESPONSE", "Provider returned no choices", false);
    }

    const content = choice.message?.content ?? "";
    if (typeof content !== "string") {
      throw new ProviderError("MALFORMED_RESPONSE", "Provider returned non-string content", false);
    }

    return {
      executionId: request.executionId,
      model: raw.model ?? request.model,
      provider: this.name,
      content,
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: raw.usage
        ? {
            promptTokens: raw.usage.prompt_tokens,
            completionTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens,
          }
        : null,
      durationMs,
    };
  }
}

function normalizeFinishReason(raw?: string | null): ModelResponse["finishReason"] {
  switch (raw) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    case "cancelled": return "cancelled";
    default: return "stop";
  }
}

// ─── OpenRouter API types (server-side only) ───────────────────────────────────

interface OpenRouterRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature: number;
  response_format?: { type: string };
}

interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    code?: number | string;
  };
}
