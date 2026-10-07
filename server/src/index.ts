import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startScanWorker, stopScanWorker } from "./services/scan.service.js";
import { closePool } from "./db/client.js";
import { stopEventPipeline } from "./analytics/events.js";
import { closeAllScanStreams } from "./routes/scans.js";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    console.log(`[server] Listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Start background scan worker
  const workerTimer = startScanWorker(config.WORKER_POLL_INTERVAL_MS);

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
    await app.close();
    await stopEventPipeline();
    await closePool();
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
