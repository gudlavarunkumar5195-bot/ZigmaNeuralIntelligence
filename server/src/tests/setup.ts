import { config as loadDotenv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Capture an explicit, isolated integration database BEFORE .env.test overrides.
const isolatedDatabaseUrl = process.env.TEST_DATABASE_URL;

const envTestPath = resolve(process.cwd(), ".env.test");
if (existsSync(envTestPath)) {
  loadDotenv({ path: envTestPath, override: true });
}

// A clean checkout has no .env.test (it is gitignored). Fill the variables the
// config schema requires with inert, per-run values so unit suites run in CI
// and on fresh clones. The DATABASE_URL points at a closed local port: nothing
// can connect to it, and integration suites stay skipped unless
// TEST_DATABASE_URL + RUN_INTEGRATION=1 are set explicitly.
// DATABASE_URL is always replaced (never inherited from the shell), so a
// developer's exported production URL can never reach a test.
process.env.NODE_ENV ??= "test";
if (!existsSync(envTestPath)) process.env.DATABASE_URL = "postgresql://inert:inert@127.0.0.1:1/inert";
process.env.JWT_SECRET ??= randomBytes(32).toString("hex");
process.env.COOKIE_SECRET ??= randomBytes(32).toString("hex");

// Integration tests only ever run against TEST_DATABASE_URL (never a
// production DATABASE_URL).
if (isolatedDatabaseUrl) process.env.DATABASE_URL = isolatedDatabaseUrl;

// audit_log is append-only (migration 040). Test suites delete or age their own
// audit rows during cleanup, so test connections opt into maintenance mode;
// audit-log-immutability.integration.test.ts checks the default (refusing) mode.
process.env.PGOPTIONS = [process.env.PGOPTIONS, "-c zigma.audit_maintenance=on"].filter(Boolean).join(" ");
