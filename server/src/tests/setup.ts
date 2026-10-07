import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// Capture an explicit, isolated integration database BEFORE .env.test overrides.
const isolatedDatabaseUrl = process.env.TEST_DATABASE_URL;

loadDotenv({
  path: resolve(process.cwd(), ".env.test"),
  override: true,
});

// Integration tests only ever run against TEST_DATABASE_URL (never a
// production DATABASE_URL). Without it, DATABASE_URL stays the inert value
// from .env.test and integration suites remain skipped.
if (isolatedDatabaseUrl) process.env.DATABASE_URL = isolatedDatabaseUrl;
