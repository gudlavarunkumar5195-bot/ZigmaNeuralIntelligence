/**
 * Frontend Sentry. No-op unless VITE_SENTRY_DSN is set at build time.
 *
 * Build-time env (Vite embeds these; a browser DSN is public by design, but it
 * is never hardcoded here):
 *   VITE_SENTRY_DSN                  enables Sentry
 *   VITE_SENTRY_ENVIRONMENT          default: Vite mode
 *   VITE_SENTRY_RELEASE              default: zigma-web@<package version>
 *   VITE_SENTRY_TRACES_SAMPLE_RATE   0..1, default 0.05
 *   VITE_SENTRY_REPLAY               "on" enables Session Replay (masked, media blocked)
 */
import * as Sentry from "@sentry/react";
import { scrubBrowserBreadcrumb, scrubBrowserEvent, scrubUrl } from "./scrub";

type Env = Record<string, string | boolean | undefined>;

export interface FrontendSentrySettings {
  dsn: string;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
  replay: boolean;
}

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function readFrontendSentrySettings(env: Env): FrontendSentrySettings | null {
  const dsn = str(env, "VITE_SENTRY_DSN");
  if (!dsn) return null;
  if (!/^https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+(?::\d+)?\/(?:[A-Za-z0-9_-]+\/)*\d+$/.test(dsn)) {
    console.warn("[sentry] VITE_SENTRY_DSN is not a valid DSN; Sentry stays disabled.");
    return null;
  }
  const rawRate = Number(str(env, "VITE_SENTRY_TRACES_SAMPLE_RATE") ?? "0.05");
  const tracesSampleRate = Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 0.05;
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined;
  return {
    dsn,
    environment: str(env, "VITE_SENTRY_ENVIRONMENT") ?? str(env, "MODE") ?? "production",
    release: str(env, "VITE_SENTRY_RELEASE") ?? (version ? `zigma-web@${version}` : undefined),
    tracesSampleRate,
    replay: str(env, "VITE_SENTRY_REPLAY")?.toLowerCase() === "on",
  };
}

let enabled = false;

export function isFrontendSentryEnabled(): boolean {
  return enabled;
}

/** Initialises browser Sentry once; returns whether it is enabled. */
export function initFrontendSentry(env: Env = import.meta.env as unknown as Env): boolean {
  if (enabled) return true;
  const settings = readFrontendSentrySettings(env);
  if (!settings) return false;

  const integrations = [];
  if (settings.tracesSampleRate > 0) {
    integrations.push(
      Sentry.browserTracingIntegration({
        beforeStartSpan: (options) => ({ ...options, name: scrubUrl(options.name) }),
      }),
    );
  }
  if (settings.replay) {
    integrations.push(Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }));
  }

  Sentry.init({
    dsn: settings.dsn,
    environment: settings.environment,
    release: settings.release,
    sendDefaultPii: false,
    tracesSampleRate: settings.tracesSampleRate,
    // tracePropagationTargets is left unset: the default attaches trace
    // headers to same-origin requests only (never third parties).
    replaysSessionSampleRate: settings.replay ? 0.01 : 0,
    replaysOnErrorSampleRate: settings.replay ? 1.0 : 0,
    integrations,
    maxBreadcrumbs: 50,
    beforeSend: (event) => scrubBrowserEvent(event),
    beforeSendTransaction: (event) => scrubBrowserEvent(event),
    beforeBreadcrumb: (crumb) => scrubBrowserBreadcrumb(crumb),
  });
  enabled = true;
  return true;
}

export { Sentry };
