import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startScanWorker, stopScanWorker } from "./services/scan.service.js";
import { closePool } from "./db/client.js";
import { startEventPipeline, stopEventPipeline } from "./analytics/events.js";
import { closeAllScanStreams } from "./routes/scans.js";
import { maybeRefreshPlatformCredentials, storedSecret } from "./platform/credential-store.js";
import { testIntegration } from "./platform/integrations.js";
import { startCatalogScheduler, stopCatalogScheduler } from "./ai/catalog.service.js";
import { startAiRetention } from "./ai/retention.js";
import { flushSentry } from "./observability/sentry.js";

const CREDENTIAL_RELOAD_MS = 60_000;
const CREDENTIAL_REVALIDATE_MS = 6 * 60 * 60_000;

/** Re-checks a stored admin-managed key (startup and every few hours); never deletes it. */
async function revalidateStoredCredentials(): Promise<void> {
  if (!storedSecret("openrouter")) return;
  try {
    const r = await testIntegration("openrouter", null, "scheduled");
    console.log(JSON.stringify({ event: "platform_credential_revalidated", provider: "openrouter", status: r.status }));
  } catch (err) {
    console.error(JSON.stringify({ event: "platform_credential_revalidation_failed", provider: "openrouter", error: (err as Error).name }));
  }
}

async function start() {
  const app = await buildApp();
  // Admin-managed provider credentials (decrypted into memory; reloaded so
  // changes made by another process converge within a minute).
  await maybeRefreshPlatformCredentials(0);
  setInterval(() => void maybeRefreshPlatformCredentials(CREDENTIAL_RELOAD_MS), CREDENTIAL_RELOAD_MS).unref();
  void revalidateStoredCredentials();
  setInterval(() => void revalidateStoredCredentials(), CREDENTIAL_REVALIDATE_MS).unref();

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    console.log(`[server] Listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Start background scan worker
  const workerTimer = startScanWorker(config.WORKER_POLL_INTERVAL_MS);
  // Durable analytics outbox dispatcher (independent of the scan worker loop).
  startEventPipeline();
  // Phase 11: keep the free-model catalog (pricing, limits) fresh, and prune old AI governance records.
  startCatalogScheduler();
  startAiRetention();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Hard stop so a hung close can never outlive the platform grace period.
    setTimeout(() => {
      console.error(JSON.stringify({ event: "shutdown_forced_exit" }));
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS + 10_000).unref();
    console.log(`[server] ${signal} received, shutting down...`);
    // Hijacked SSE sockets are invisible to Fastify; end them (and refuse new
    // ones) first so app.close() cannot hang on streams that never finish.
    const closedStreams = closeAllScanStreams();
    console.log(JSON.stringify({ event: "sse_streams_closed", count: closedStreams }));
    // Stop claiming, wait a bounded time for the in-flight scan, then requeue
    // (or fail, if attempts are exhausted) anything still owned by this process.
    const summary = await stopScanWorker(config.SHUTDOWN_GRACE_MS);
    console.log(JSON.stringify({ event: "worker_shutdown", ...summary }));
    stopCatalogScheduler();
    await app.close();
    await stopEventPipeline();
    await closePool();
    await flushSentry(2_000);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ event: "uncaught_exception", error: error.message, stack: error.stack }));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({ event: "unhandled_rejection", error: error.message, stack: error.stack }));
  process.exit(1);
});

start().catch((error: unknown) => {
  const cause = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ event: "startup_failure", error: cause.message, stack: cause.stack }));
  process.exit(1);
});
