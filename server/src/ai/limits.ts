// Deterministic hard limits for AI cost and runtime (F-010). These are
// ceilings: configuration or routing policy may lower them, never raise them.

/** Max attempts against a single model (clamps config/maxRetries). */
export const AI_MAX_ATTEMPTS_PER_MODEL = 3;
/** Max provider calls per agent execution across the primary and all fallback models. */
export const AI_MAX_TOTAL_ATTEMPTS = 4;
/** Max wall-clock for one provider call. */
export const AI_MAX_CALL_TIMEOUT_MS = 60_000;
/** Max wall-clock for one agent execution including retries and backoff. */
export const AI_AGENT_DEADLINE_MS = 120_000;
/** Max wall-clock for the whole AI stage of one scan (specialists + synthesis). */
export const AI_SCAN_DEADLINE_MS = 300_000;
/** Stage claim lease and its renewal interval (renewal must be well below the lease). */
export const AI_STAGE_LEASE_MS = 120_000;
export const AI_STAGE_HEARTBEAT_MS = 30_000;

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/** Effective total attempts: routing-policy max_attempts honoured but clamped to the hard cap. */
export function effectiveMaxTotalAttempts(policyMaxAttempts?: number, requested?: number): number {
  const policy = clampInt(policyMaxAttempts, AI_MAX_TOTAL_ATTEMPTS, 1, AI_MAX_TOTAL_ATTEMPTS);
  return clampInt(requested, policy, 1, policy);
}

export class AiDeadlineError extends Error {
  constructor(label: string) {
    super(`AI_DEADLINE_EXCEEDED: ${label}`);
    this.name = "AiDeadlineError";
  }
}

export class AiAbortedError extends Error {
  readonly code = "AI_ABORTED";
  readonly retryable = false;
  constructor(label: string) {
    super(`AI_ABORTED: ${label}`);
    this.name = "AiAbortedError";
  }
}

/** Rejects with AiAbortedError as soon as the signal aborts; the underlying work is detached, not awaited. */
export async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch((): void => undefined);
    throw new AiAbortedError(label);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new AiAbortedError(label)); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    work.catch((): void => undefined);
    aborted.catch((): void => undefined);
  }
}

/** Rejects with AiDeadlineError when the absolute deadline passes before the work settles. */
export async function withDeadline<T>(work: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    work.catch((): void => undefined); // detach: the late result is intentionally discarded
    throw new AiDeadlineError(label);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AiDeadlineError(label)), remaining); });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch((): void => undefined); // a losing/late rejection must not become unhandled
  }
}
