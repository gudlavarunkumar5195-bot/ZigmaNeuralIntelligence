import type { ModelProvider, ModelRequest, ModelResponse, ProviderCitation } from "../provider.js";
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
    private readonly siteUrl = "https://zigmaneural.com",
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
    if (request.webSearch) {
      body.plugins = [{ id: "web", max_results: request.webSearch.maxResults }];
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
      const reasonName = (request.signal?.reason as Error | undefined)?.name;
      if ((err as Error).name === "TimeoutError" || reasonName === "TimeoutError") {
        throw new ProviderError("TIMEOUT", "Request timed out", true);
      }
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
    if (!res.ok && res.status !== 400) {
      // Release the connection: the body of an error response is never read.
      await res.body?.cancel().catch((): void => undefined);
    }
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
    } catch (err: unknown) {
      if (request.signal?.aborted || (err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
        const reasonName = (request.signal?.reason as Error | undefined)?.name;
        if (reasonName === "TimeoutError" || (err as Error).name === "TimeoutError") throw new ProviderError("TIMEOUT", "Request timed out", true);
        throw new ProviderError("CANCELLED", "Request cancelled", false);
      }
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
      providerRequestId: typeof raw.id === "string" ? raw.id.slice(0, 200) : null,
      citations: parseCitations(raw, choice),
    };
  }
}

const MAX_CITATIONS = 50;

/**
 * Structured citations only: OpenRouter "url_citation" message annotations,
 * else a top-level `citations` URL list (returned by some search models).
 * Malformed entries are skipped; URLs are validated later by the caller.
 */
export function parseCitations(raw: OpenRouterResponse, choice: NonNullable<OpenRouterResponse["choices"]>[number]): ProviderCitation[] {
  const out: ProviderCitation[] = [];
  for (const a of Array.isArray(choice.message?.annotations) ? choice.message.annotations : []) {
    const c = a?.type === "url_citation" ? a.url_citation : undefined;
    if (c && typeof c.url === "string" && c.url.length <= 2048) {
      out.push({ url: c.url, title: typeof c.title === "string" ? c.title.slice(0, 300) : null, position: out.length + 1, kind: "provider_annotation" });
    }
    if (out.length >= MAX_CITATIONS) return out;
  }
  if (out.length) return out;
  for (const u of Array.isArray(raw.citations) ? raw.citations : []) {
    if (typeof u === "string" && u.length <= 2048) out.push({ url: u, title: null, position: out.length + 1, kind: "provider_citation_list" });
    if (out.length >= MAX_CITATIONS) break;
  }
  return out;
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
  plugins?: Array<{ id: string; max_results: number }>;
}

export interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
      annotations?: Array<{ type?: string; url_citation?: { url?: unknown; title?: unknown } }>;
    };
    finish_reason?: string;
  }>;
  citations?: unknown[];
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
