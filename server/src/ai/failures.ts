// Phase 11: failure categories and the deterministic retry/fallback policy.
//
// Each provider failure is classified once, and the category alone decides
// whether to retry the same model, move to the next eligible model, cool the
// model down, or stop the whole task. A safety rejection stops the task: the
// same request is never re-sent to another model to get around a refusal.

import { ProviderError } from "./provider.js";

export type FailureCategory =
  | "RATE_LIMITED"            // per-model or per-minute limit; cool the model down
  | "QUOTA_EXHAUSTED"         // account-wide daily free (or trial) allowance used up
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK"
  | "TIMEOUT"
  | "CONTEXT_OVERFLOW"
  | "UNSUPPORTED_CAPABILITY"  // e.g. no free endpoint supports the requested parameters
  | "REQUEST_REJECTED"        // this request was refused (4xx) — says nothing about the model's health
  | "MALFORMED_OUTPUT"
  | "TRUNCATED_OUTPUT"
  | "EMPTY_RESPONSE"
  | "INVALID_PROVIDER_RESPONSE"
  | "QUALITY_FAILED"
  | "SAFETY_REJECTION"
  | "SECURITY_VIOLATION"      // our output guard rejected the answer (leak, secret, unapproved action)
  | "AUTH_CONFIG"             // invalid key, insufficient credits, misconfiguration
  | "BUDGET_EXHAUSTED"
  | "POLICY_BLOCKED"          // model or request not permitted by application policy
  | "CANCELLED";

export interface FailurePolicy {
  retrySameModel: boolean;
  tryNextModel: boolean;
  stopTask: boolean;
  /** Cool the model down for this long (a provider Retry-After takes precedence when larger). */
  cooldownMs: number;
  /** Counts against the model's reliability (caller-side and policy failures do not). */
  countsAgainstModel: boolean;
}

const P = (p: Partial<FailurePolicy>): FailurePolicy => ({ retrySameModel: false, tryNextModel: false, stopTask: false, cooldownMs: 0, countsAgainstModel: true, ...p });

export const FAILURE_POLICY: Readonly<Record<FailureCategory, FailurePolicy>> = Object.freeze({
  RATE_LIMITED: P({ tryNextModel: true, cooldownMs: 60_000 }),
  QUOTA_EXHAUSTED: P({ stopTask: true, countsAgainstModel: false }),
  PROVIDER_UNAVAILABLE: P({ retrySameModel: true, tryNextModel: true, cooldownMs: 120_000 }),
  NETWORK: P({ retrySameModel: true, tryNextModel: true, countsAgainstModel: false }),
  TIMEOUT: P({ retrySameModel: true, tryNextModel: true, cooldownMs: 30_000 }),
  // Re-sending an oversized prompt fails identically: replan on a larger model.
  CONTEXT_OVERFLOW: P({ tryNextModel: true, countsAgainstModel: false }),
  UNSUPPORTED_CAPABILITY: P({ tryNextModel: true, cooldownMs: 15 * 60_000 }),
  REQUEST_REJECTED: P({ tryNextModel: true, countsAgainstModel: false }),
  MALFORMED_OUTPUT: P({ retrySameModel: true, tryNextModel: true }),
  TRUNCATED_OUTPUT: P({ tryNextModel: true }),
  EMPTY_RESPONSE: P({ retrySameModel: true, tryNextModel: true }),
  INVALID_PROVIDER_RESPONSE: P({ tryNextModel: true }),
  QUALITY_FAILED: P({ tryNextModel: true }),
  SAFETY_REJECTION: P({ stopTask: true, countsAgainstModel: false }),
  SECURITY_VIOLATION: P({ stopTask: true }),
  AUTH_CONFIG: P({ stopTask: true, countsAgainstModel: false }),
  BUDGET_EXHAUSTED: P({ stopTask: true, countsAgainstModel: false }),
  POLICY_BLOCKED: P({ tryNextModel: true, countsAgainstModel: false }),
  CANCELLED: P({ stopTask: true, countsAgainstModel: false }),
});

/** Max cooldown honoured from a provider hint (a hostile or broken header cannot park a model for days). */
export const MAX_PROVIDER_COOLDOWN_MS = 6 * 60 * 60_000;

/** Maps any error raised during an attempt to a failure category. */
export function categorizeFailure(err: unknown): FailureCategory {
  if (err instanceof ProviderError && err.category) return err.category;
  const code = (err as { code?: string } | null)?.code;
  if (code === "BUDGET_EXCEEDED" || code === "TOKEN_BUDGET_EXCEEDED") return "BUDGET_EXHAUSTED";
  if (code === "QUOTA_EXHAUSTED") return "QUOTA_EXHAUSTED";
  if (code === "POLICY_BLOCKED") return "POLICY_BLOCKED";
  if (err instanceof ProviderError) {
    switch (err.code) {
      case "RATE_LIMITED": return "RATE_LIMITED";
      case "TIMEOUT": return "TIMEOUT";
      case "CANCELLED": return "CANCELLED";
      case "CONTEXT_TOO_LONG": return "CONTEXT_OVERFLOW";
      case "MALFORMED_RESPONSE": return "INVALID_PROVIDER_RESPONSE";
      case "MODEL_UNAVAILABLE": return "PROVIDER_UNAVAILABLE";
      case "INVALID_REQUEST": return err.httpStatus === 401 || err.httpStatus === 403 ? "AUTH_CONFIG" : "REQUEST_REJECTED";
      case "PROVIDER_ERROR": return err.retryable ? "PROVIDER_UNAVAILABLE" : "INVALID_PROVIDER_RESPONSE";
    }
  }
  const name = (err as Error | null)?.name;
  if (name === "AbortError" || name === "AiAbortedError") return "CANCELLED";
  if (name === "TimeoutError" || name === "AiDeadlineError") return "TIMEOUT";
  return "PROVIDER_UNAVAILABLE";
}

/**
 * Classifies an OpenRouter error from its HTTP status, the typed
 * error.metadata.error_type and, as a last resort, the message text.
 */
export function categorizeOpenRouterError(status: number, errorType: string | null, message: string): FailureCategory {
  const msg = message.toLowerCase();
  const type = (errorType ?? "").toLowerCase();
  if (type.includes("content_policy") || type.includes("moderation") || (status === 403 && /flagged|moderation|guardrail/.test(msg))) return "SAFETY_REJECTION";
  if (status === 401) return "AUTH_CONFIG";
  if (status === 402) return "AUTH_CONFIG";
  if (status === 403) return "AUTH_CONFIG";
  if (status === 408 || status === 504 || type.includes("timeout")) return "TIMEOUT";
  if (status === 413 || /context length|context window|maximum context|too many tokens|prompt is too long/.test(msg)) return "CONTEXT_OVERFLOW";
  if (status === 429 || type.includes("rate_limit")) {
    // Only OpenRouter's own free-model daily marker means the account allowance is used up;
    // an upstream provider's "quota"/"daily" wording is a per-model rate limit.
    return /free-models-per-day/.test(msg) ? "QUOTA_EXHAUSTED" : "RATE_LIMITED";
  }
  if (status === 404 || ((status === 400 || status === 422) && /no endpoints found|not support|unsupported|max_price/.test(msg))) return "UNSUPPORTED_CAPABILITY";
  if (status === 502 || status === 503 || status >= 500 || type.includes("provider_unavailable") || type === "server") return "PROVIDER_UNAVAILABLE";
  if (status === 400 || status === 422 || status === 412) return "REQUEST_REJECTED";
  return "INVALID_PROVIDER_RESPONSE";
}

/** Exponential backoff with full jitter, bounded. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(500 * 2 ** Math.max(0, attempt - 1), 4_000);
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Parses Retry-After (seconds or HTTP date) or an epoch reset header into a bounded delay. */
export function parseRetryAfterMs(retryAfter: string | null, resetHeader?: string | null, now = Date.now()): number | null {
  let ms: number | null = null;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
    else if (/^[a-z]{3}, /i.test(retryAfter.trim())) {
      // Only a real HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT"); Date.parse would read "-5" as a year.
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) ms = at - now;
    }
  }
  if (ms === null && resetHeader) {
    const n = Number(resetHeader);
    // OpenRouter sends X-RateLimit-Reset as epoch milliseconds.
    if (Number.isFinite(n) && n > 0) ms = (n > 1e12 ? n : n * 1000) - now;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, Math.round(ms)), MAX_PROVIDER_COOLDOWN_MS);
}
