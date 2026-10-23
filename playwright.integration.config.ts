import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Backend-backed E2E suite: the real Fastify API and a real PostgreSQL
 * database (migrated and seeded with synthetic data on start), behind the Vite
 * dev server. Nothing calls an external provider.
 *
 *   E2E_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/zni_e2e pnpm test:e2e:integration
 *
 * The database must be local and disposable: the seed refuses anything else.
 */
const DB = process.env.E2E_DATABASE_URL;
if (!DB) throw new Error("Set E2E_DATABASE_URL to a local, disposable PostgreSQL database (see playwright.integration.config.ts).");

const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
// Test-only secrets, generated once per run (workers inherit the environment).
process.env.E2E_JWT_SECRET ??= randomBytes(32).toString("hex");
process.env.E2E_COOKIE_SECRET ??= randomBytes(32).toString("hex");

export default defineConfig({
  testDir: "./e2e/integration",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Tests may wait for the API's per-minute rate-limit window (see respectRateLimit).
  timeout: 90_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: WEB, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node e2e/integration/start-api.mjs",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        E2E_DATABASE_URL: DB,
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        JWT_SECRET: process.env.E2E_JWT_SECRET,
        COOKIE_SECRET: process.env.E2E_COOKIE_SECRET,
        CORS_ORIGIN: WEB,
        // Keep the scan worker idle-friendly; the suite never starts a scan.
        WORKER_POLL_INTERVAL_MS: "60000",
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_API_PROXY: "1",
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        VITE_API_BASE_URL: `${WEB}/api/v1`,
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.E2E_BROWSER_CHANNEL || undefined } }],
});
