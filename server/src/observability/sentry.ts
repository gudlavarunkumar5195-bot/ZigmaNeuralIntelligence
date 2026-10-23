/**
 * Sentry (errors, traces, logs) for the API process.
 *
 * Everything here is a no-op unless SENTRY_DSN is set, so local dev, CI and
 * tests never talk to Sentry. Configuration is read from process.env and
 * validated here (it must be available before config.ts is imported, because
 * instrument.ts runs as a `node --import` preload).
 *
 * Env:
 *   SENTRY_DSN                  enables Sentry (secret-ish; keep it in DO secrets)
 *   SENTRY_ENVIRONMENT          default NODE_ENV (or "development")
 *   SENTRY_RELEASE              default zigma-api@<APP_COMMIT|COMMIT_SHA|COMMIT_HASH|SOURCE_COMMIT>
 *   SENTRY_TRACES_SAMPLE_RATE   0..1, default 0.1 in production, 0 elsewhere
 *   SENTRY_ENABLE_LOGS          default true; forwards pino warn/error/fatal and console.warn/error to Sentry Logs
 */
import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent, Event, Log, SeverityLevel } from "@sentry/node";
import { scrubBreadcrumb, scrubEvent, scrubLog, scrubString, scrubUrl } from "./scrub.js";

export interface SentrySettings {
  dsn: string;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
  enableLogs: boolean;
}

type Env = Record<string, string | undefined>;

const DSN_RE = /^https:\/\/[A-Za-z0-9]+(?::[A-Za-z0-9]+)?@[A-Za-z0-9.-]+(?::\d+)?\/(?:[A-Za-z0-9_-]+\/)*\d+$/;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

/** Parses a sample rate and clamps it to [0, 1]; invalid input -> fallback. */
export function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function resolveRelease(env: Env): string | undefined {
  const explicit = env.SENTRY_RELEASE?.trim();
  if (explicit) return explicit;
  const sha = [env.APP_COMMIT, env.COMMIT_SHA, env.COMMIT_HASH, env.SOURCE_COMMIT, env.GIT_COMMIT_SHA]
    .map((v) => v?.trim())
    .find((v) => v && /^[0-9a-f]{7,40}$/i.test(v));
  return sha ? `zigma-api@${sha}` : undefined;
}

/**
 * Reads and validates Sentry settings. Returns null when Sentry is disabled
 * (no DSN) or the DSN is malformed (a warning is printed without the value).
 */
export function readSentrySettings(env: Env = process.env): SentrySettings | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  if (!DSN_RE.test(dsn)) {
    console.warn("[sentry] SENTRY_DSN is set but is not a valid Sentry DSN; Sentry stays disabled.");
    return null;
  }
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  const environment = env.SENTRY_ENVIRONMENT?.trim() || nodeEnv;
  return {
    dsn,
    environment,
    release: resolveRelease(env),
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, nodeEnv === "production" ? 0.1 : 0),
    enableLogs: parseBool(env.SENTRY_ENABLE_LOGS, true),
  };
}

/**
 * Only 5xx and unexpected errors are reported. Errors carrying a 4xx
 * statusCode (validation, auth, AppError, rate limit) are client errors.
 */
export function shouldReportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const e = error as { statusCode?: unknown; status?: unknown; validation?: unknown };
  if (e.validation) return false;
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : undefined;
  if (status === undefined) return true;
  return status >= 500;
}

let initialized = false;
let enabled = false;
let activeSettings: SentrySettings | null = null;

export function isSentryEnabled(): boolean {
  return enabled;
}

export function getSentrySettings(): Readonly<SentrySettings> | null {
  return activeSettings;
}

/**
 * Initialises Sentry once. Safe to call repeatedly; returns whether Sentry is
 * enabled. Must run before fastify/pino/pg are imported for full
 * auto-instrumentation (see src/instrument.ts).
 */
export function initSentry(env: Env = process.env): boolean {
  if (initialized) return enabled;
  initialized = true;
  const settings = readSentrySettings(env);
  if (!settings) return false;

  const integrations = [
    Sentry.fastifyIntegration({ shouldHandleError: (error) => shouldReportError(error) }),
  ];
  if (settings.enableLogs) {
    // pino >= 9.10 publishes the `pino_asJson` tracing channel; the output is
    // already redacted by the Fastify logger's `redact` paths and is scrubbed
    // again by beforeSendLog. Only warn and above are forwarded (quota).
    integrations.push(Sentry.pinoIntegration({ log: { levels: ["warn", "error", "fatal"] }, error: { levels: [] } }));
    // Structured console.warn/error lines (e.g. `{"event":"db_timeouts_not_applied"}`)
    // also become Sentry Logs. pino writes to stdout directly, so no duplicates.
    integrations.push(Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }));
  }

  Sentry.init({
    dsn: settings.dsn,
    environment: settings.environment,
    release: settings.release,
    tracesSampleRate: settings.tracesSampleRate,
    enableLogs: settings.enableLogs,
    // Never send PII by default. dataCollection (v10) controls each category
    // explicitly and wins over sendDefaultPii when both are set.
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ["user-agent", "content-type", "content-length", "accept", "x-request-id", "x-forwarded-proto"] },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
    },
    maxBreadcrumbs: 50,
    integrations,
    beforeSend(event: ErrorEvent) {
      return scrubEvent(event);
    },
    beforeSendTransaction(event) {
      return scrubEvent(event);
    },
    beforeSendLog(log: Log) {
      return scrubLog(log);
    },
    beforeBreadcrumb(crumb: Breadcrumb) {
      return scrubBreadcrumb(crumb);
    },
  });

  enabled = true;
  activeSettings = settings;
  return true;
}

export interface CaptureContext {
  requestId?: string;
  route?: string;
  method?: string;
  orgId?: string;
  userId?: string;
  tags?: Record<string, string | number | boolean | undefined>;
  extra?: Record<string, unknown>;
  level?: SeverityLevel;
  fingerprint?: string[];
}

/** Captures an exception with scrubbed context. Returns the event id, or undefined when disabled. */
export function captureException(err: unknown, context: CaptureContext = {}): string | undefined {
  if (!enabled) return undefined;
  return Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag("request_id", context.requestId);
    if (context.route) scope.setTag("route", context.route);
    if (context.method) scope.setTag("http.method", context.method);
    if (context.orgId) scope.setTag("org_id", context.orgId);
    if (context.userId) scope.setUser({ id: context.userId });
    for (const [k, v] of Object.entries(context.tags ?? {})) if (v !== undefined) scope.setTag(k, String(v));
    if (context.extra) scope.setContext("extra", context.extra);
    if (context.level) scope.setLevel(context.level);
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    return Sentry.captureException(err);
  });
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  if (!enabled) return;
  Sentry.addBreadcrumb({
    ...crumb,
    message: crumb.message ? scrubString(crumb.message) : crumb.message,
  });
}

export interface RequestContext {
  requestId: string;
  route?: string;
  method?: string;
  url?: string;
  orgId?: string;
  userId?: string;
}

/**
 * Tags the current isolation scope (one per incoming request under the
 * Sentry HTTP integration) so every event/log from this request carries it.
 * Never pass an email here: user ids only.
 */
export function setRequestContext(ctx: RequestContext): void {
  if (!enabled) return;
  const scope = Sentry.getIsolationScope();
  scope.setTag("request_id", ctx.requestId);
  if (ctx.route) scope.setTag("route", ctx.route);
  if (ctx.method) scope.setTag("http.method", ctx.method);
  if (ctx.url) scope.setContext("request_meta", { url: scrubUrl(ctx.url) });
  if (ctx.orgId) scope.setTag("org_id", ctx.orgId);
  if (ctx.userId) scope.setUser({ id: ctx.userId });
}

/** Adds tags to the current request's isolation scope (no-op when disabled). */
export function tagCurrentScope(tags: Record<string, string>): void {
  if (!enabled) return;
  Sentry.getIsolationScope().setTags(tags);
}

/** Deliberate error thrown by GET /api/v1/admin/diagnostics/sentry-test. */
export class SentryTestError extends Error {
  readonly statusCode = 500;
  constructor(requestId: string) {
    super(`Sentry diagnostics test error (request ${requestId})`);
    this.name = "SentryTestError";
  }
}

/** Flushes buffered events/logs; call on graceful shutdown. Resolves false on timeout or when disabled. */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  if (!enabled) return false;
  try {
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Test-only: resets module state so initSentry can be exercised again. */
export function __resetSentryForTests(): void {
  initialized = false;
  enabled = false;
  activeSettings = null;
}

export type { Event as SentryEvent };
