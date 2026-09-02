import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startScanWorker } from "./services/scan.service.js";

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
  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down...`);
    clearInterval(workerTimer);
    await app.close();
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
