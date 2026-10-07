import "dotenv/config";
import { z } from "zod";
import { parseTrustProxy } from "./http/trust-proxy.js";
import { parseEnvBoolean, parsePlatformAdminUserIds, validateProductionSecurityConfig } from "./config-security.js";

const strictBoolean = (name: string) =>
  z.preprocess((value, ctx) => {
    try {
      return parseEnvBoolean(value, name);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }, z.boolean().default(false));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Some managed deployments expose a private CA chain. Enable strict
  // verification explicitly once DB_SSL_CA is configured in the runtime.
  DB_SSL_REJECT_UNAUTHORIZED: z.preprocess((v, ctx) => {
    try {
      return parseEnvBoolean(v, "DB_SSL_REJECT_UNAUTHORIZED");
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }, z.boolean().default(true)),
  DB_SSL_CA: z.string().optional(),
  // Optional direct (non-pooled) connection string, reported as SET/NOT SET only.
  DIRECT_DATABASE_URL: z.string().optional(),
  // Optional, non-secret label for the Neon branch (not derivable from the URL).
  NEON_BRANCH: z.string().optional(),

  // ClickHouse Cloud analytics store (optional; analytics degrade when unset).
  // Always HTTPS with normal CA verification; CLICKHOUSE_CA_CERT only adds a
  // trusted CA, it never disables verification.
  CLICKHOUSE_HOST: z.string().optional(),
  CLICKHOUSE_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  CLICKHOUSE_DATABASE: z.string().optional(),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_CA_CERT: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  // Cookie
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 characters"),

  // QA verification bypass is disabled by default and requires explicit user allowlisting.
  QA_VERIFICATION_BYPASS_ENABLED: strictBoolean("QA_VERIFICATION_BYPASS_ENABLED"),
  QA_AUTHORIZED_EMAILS: z.string().default(""),
  QA_ALLOW_PRODUCTION_BYPASS: strictBoolean("QA_ALLOW_PRODUCTION_BYPASS"),

  // Platform administrators: comma-separated user UUIDs allowed to mutate
  // global (non-tenant) resources. Unset/empty means nobody can (fail closed).
  PLATFORM_ADMIN_USER_IDS: z.preprocess((value, ctx) => {
    try {
      return parsePlatformAdminUserIds(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }, z.array(z.string())),

  // Reverse-proxy trust for request.ip / rate limiting. Default: do not trust
  // X-Forwarded-For. Set a hop count (e.g. 1) or proxy IP/CIDR list.
  TRUST_PROXY: z.preprocess((value, ctx) => {
    try {
      return parseTrustProxy(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }, z.union([z.literal(false), z.number(), z.array(z.string())])),

  // CORS
  CORS_ORIGIN: z
    .string()
    .min(1, "CORS_ORIGIN is required")
    .refine((value) => !value.includes("*"), "CORS_ORIGIN must not use a wildcard in production")
    .default("http://localhost:8443"),

  // Scanner limits
  SCANNER_CONNECT_TIMEOUT_MS: z.coerce.number().default(10_000),
  SCANNER_RESPONSE_TIMEOUT_MS: z.coerce.number().default(30_000),
  SCANNER_MAX_RESPONSE_BYTES: z.coerce.number().default(5_242_880), // 5 MB
  SCANNER_MAX_REDIRECTS: z.coerce.number().default(5),
  SCANNER_MAX_PAGES: z.coerce.number().default(200),
  SCANNER_MAX_SCAN_DURATION_MS: z.coerce.number().default(300_000),
  MAX_CONCURRENT_SCANS_PER_TENANT: z.coerce.number().default(2),
  MAX_QUEUED_SCANS_PER_TENANT: z.coerce.number().default(10),
  MAX_SCAN_CREATIONS_PER_MINUTE: z.coerce.number().default(10),

  // Crash recovery / shutdown
  SCAN_MAX_EXECUTION_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),

  // Server-sent event (scan progress) stream caps. Each open stream polls the
  // database, so these protect the connection pool. 429 once a cap is hit.
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().min(1).max(100).default(3),
  SSE_MAX_STREAMS_PER_ORG: z.coerce.number().int().min(1).max(500).default(10),
  SSE_MAX_STREAMS_GLOBAL: z.coerce.number().int().min(1).max(1000).default(40),
  SSE_POLL_INTERVAL_MS: z.coerce.number().int().min(1_500).max(30_000).default(2_000),

  // Worker polling interval
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(2_000),

  // AI / OX Alpha
  // OPENROUTER_API_KEY is intentionally optional at config-load time so the
  // server starts without it (feature degrades gracefully).  The executor will
  // throw MODEL_UNAVAILABLE at execution time if it is absent.
  OPENROUTER_API_KEY: z.string().optional(),
  // Default model used by OX Alpha when no explicit model is specified.
  OX_ALPHA_MODEL: z.string().default("meta-llama/llama-3.1-8b-instruct:free"),
  OX_ALPHA_TIMEOUT_MS: z.coerce.number().default(60_000),
  OX_ALPHA_MAX_RETRIES: z.coerce.number().default(3),
  OX_ALPHA_MAX_OUTPUT_TOKENS: z.coerce.number().default(4_096),
  // Hard per-organization ceiling on AI model attempts per rolling 24h.
  AI_MAX_EXECUTIONS_PER_ORG_PER_DAY: z.coerce.number().int().min(0).default(500),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  validateProductionSecurityConfig(env);
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`[ZigmaNeural] FATAL: Invalid server configuration:\n${issues}`);
    throw new Error(`[ZigmaNeural] Invalid server configuration:\n${issues}`);
  }

  const config = result.data;
  if (config.NODE_ENV === "production") {
    if (config.CORS_ORIGIN.includes("*")) {
      throw new Error("[ZigmaNeural] CORS_ORIGIN must not use '*' in production.");
    }
  }

  return config;
}

export const config = loadConfig();
export type Config = typeof config;
