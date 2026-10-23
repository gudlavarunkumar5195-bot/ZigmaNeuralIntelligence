/**
 * Preload entry: `node --import ./dist/instrument.js dist/index.js`.
 *
 * Sentry must initialise before fastify, pino, pg and http are imported so its
 * OpenTelemetry / diagnostics-channel instrumentation can attach (ESM cannot
 * be patched after import). This module deliberately does not import
 * config.ts: Sentry reads and validates its own env vars and is a no-op
 * without SENTRY_DSN. dotenv is loaded first so local `.env` DSNs work too.
 */
import "dotenv/config";
import { initSentry } from "./observability/sentry.js";

initSentry();
