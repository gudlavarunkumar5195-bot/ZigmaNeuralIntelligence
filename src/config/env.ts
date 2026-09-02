import type { AppConfig, AppMode } from "../types";

function requireEnv(key: string, fallback?: string): string {
  const val = (import.meta.env as Record<string, string | undefined>)[key];
  if (val) return val;
  if (fallback !== undefined) return fallback;
  // In production builds, missing required vars are a fatal misconfiguration.
  // Missing configuration is surfaced by the API layer as an integration state.
  if (import.meta.env.PROD) {
    console.error(`[ZigmaNeural] Missing required environment variable: ${key}`);
  }
  return "";
}

function readMode(): AppMode {
  const raw = requireEnv("VITE_APP_MODE", "production");
  return raw === "production" ? "production" : "demo";
}

export const APP_MODE: AppMode = readMode();
export const IS_DEMO = APP_MODE === "demo";

export const config: AppConfig = {
  mode: APP_MODE,
  apiBaseUrl: requireEnv("VITE_API_BASE_URL", ""),
  wsBaseUrl: requireEnv("VITE_WS_BASE_URL", ""),
  maxRetries: parseInt(requireEnv("VITE_MAX_RETRIES", "5"), 10),
  qualityThreshold: parseInt(requireEnv("VITE_QUALITY_THRESHOLD", "90"), 10),
  maxScanRetries: parseInt(requireEnv("VITE_MAX_SCAN_RETRIES", "3"), 10),
};

/**
 * Guards against accidentally running demo mode in production.
 * Call once at app startup.
 */
export function assertProductionConfig(): void {
  if (!import.meta.env.PROD) return;
  if (IS_DEMO) {
    console.error(
      "[ZigmaNeural] FATAL: App is running in non-production mode in a production build. " +
        "Set VITE_APP_MODE=production and connect real backend services."
    );
  }
  if (!config.apiBaseUrl) {
    console.error("[ZigmaNeural] FATAL: VITE_API_BASE_URL is not set.");
  }
}
