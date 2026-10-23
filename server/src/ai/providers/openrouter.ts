import type { ModelProvider, ModelRequest, ModelResponse, ProviderCitation } from "../provider.js";
import { ProviderError } from "../provider.js";
import { categorizeOpenRouterError, parseRetryAfterMs } from "../failures.js";
import { ZERO_MAX_PRICE } from "../pricing.js";

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
    if (request.requireZeroPrice) {
      // Provider-side guard in addition to our own eligibility check: OpenRouter
      // refuses to route to any endpoint priced above zero, and a request that
      // depends on an unsupported parameter fails instead of silently changing endpoint.
      body.provider = { max_price: { ...ZERO_MAX_PRICE }, require_parameters: true };
      // Provider-side web search is billed, so it never accompanies a free request.
      delete body.plugins;
    }

    let res: Response;
    try {
      res = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        redirect: "error", // a fixed provider endpoint never needs a redirect; never follow one with the API key
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

    // HTTP-level errors. The body is read (bounded) for the typed error, then released.
    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset"));
      let detail = "";
      let errorType: string | null = null;
      try {
        const text = (await res.text()).slice(0, 4_000);
        const parsed = JSON.parse(text) as { error?: { message?: unknown; metadata?: { error_type?: unknown } } };
        detail = typeof parsed.error?.message === "string" ? parsed.error.message.slice(0, 300) : "";
        errorType = typeof parsed.error?.metadata?.error_type === "string" ? parsed.error.metadata.error_type.slice(0, 60) : null;
      } catch { /* non-JSON or unreadable error body */ }
      // Release the connection whether or not the body was read.
      await res.body?.cancel().catch((): void => undefined);
      const category = categorizeOpenRouterError(res.status, errorType, detail);
      const code = res.status === 429 ? "RATE_LIMITED"
        : res.status === 400 || res.status === 401 || res.status === 403 ? "INVALID_REQUEST"
        : category === "CONTEXT_OVERFLOW" ? "CONTEXT_TOO_LONG"
        : category === "TIMEOUT" ? "TIMEOUT"
        : "PROVIDER_ERROR";
      const retryable = category === "RATE_LIMITED" || category === "PROVIDER_UNAVAILABLE" || category === "TIMEOUT";
      const label = res.status === 401 || res.status === 403 ? `Authentication failed (HTTP ${res.status})`
        : res.status === 429 ? `Rate limited${retryAfterMs !== null ? ` — retry after ${Math.ceil(retryAfterMs / 1000)}s` : ""}`
        : res.status === 400 ? `Invalid request: ${detail}`
        : res.status === 502 || res.status === 503 ? `Provider unavailable (HTTP ${res.status})`
        : `HTTP ${res.status}`;
      throw new ProviderError(code, label, retryable, res.status, category, retryAfterMs);
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
      const message = typeof raw.error.message === "string" ? raw.error.message.slice(0, 300) : "Provider error";
      const errorType = typeof raw.error.metadata?.error_type === "string" ? raw.error.metadata.error_type : null;
      const category = categorizeOpenRouterError(typeof code === "number" ? code : 0, errorType, message);
      if (code === 429) {
        throw new ProviderError("RATE_LIMITED", message, true, 429, category);
      }
      // 503 from OpenRouter means model not available — check before generic 5xx
      if (code === 503) {
        throw new ProviderError("MODEL_UNAVAILABLE", message, false, 503, "PROVIDER_UNAVAILABLE");
      }
      if (typeof code === "number" && code >= 500) {
        throw new ProviderError("PROVIDER_ERROR", message, true, code, category);
      }
      throw new ProviderError("PROVIDER_ERROR", message, false, typeof code === "number" ? code : undefined, category);
    }

    const choice = raw.choices?.[0];
    if (!choice) {
      throw new ProviderError("MALFORMED_RESPONSE", "Provider returned no choices", false, undefined, "INVALID_PROVIDER_RESPONSE");
    }
    if (choice.finish_reason === "error") {
      // Mid-generation provider failure (for example a rate limit after generation began).
      throw new ProviderError("PROVIDER_ERROR", "Provider reported an error during generation", true, undefined, "PROVIDER_UNAVAILABLE");
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
      usage: parseUsage(raw.usage),
      durationMs,
      providerRequestId: typeof raw.id === "string" ? raw.id.slice(0, 200) : null,
      citations: parseCitations(raw, choice),
    };
  }
}

const MAX_CITATIONS = 50;

const nonNegativeInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Provider-reported usage; null when the core counts are missing (the caller then records an estimate). */
export function parseUsage(u: OpenRouterResponse["usage"]): ModelResponse["usage"] {
  if (!u) return null;
  const prompt = nonNegativeInt(u.prompt_tokens);
  const completion = nonNegativeInt(u.completion_tokens);
  if (prompt === null || completion === null) return null;
  const cost = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: nonNegativeInt(u.total_tokens) ?? prompt + completion,
    cachedTokens: nonNegativeInt(u.prompt_tokens_details?.cached_tokens),
    reasoningTokens: nonNegativeInt(u.completion_tokens_details?.reasoning_tokens),
    costUsd: cost,
  };
}

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
  provider?: { max_price: { prompt: number; completion: number; request: number; image: number }; require_parameters: boolean };
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
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  error?: {
    message: string;
    code?: number | string;
    metadata?: { error_type?: unknown };
  };
}
