import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Some managed deployments expose a private CA chain. Enable strict
  // verification explicitly once DB_SSL_CA is configured in the runtime.
  DB_SSL_REJECT_UNAUTHORIZED: z.coerce.boolean().default(false),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL").optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  // Cookie
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 characters"),

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
  SCANNER_CONCURRENCY: z.coerce.number().default(4),

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
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`[ZigmaNeural] FATAL: Invalid server configuration:\n${issues}`);
    process.exit(1);
  }

  const config = result.data;
  if (config.NODE_ENV === "production") {
    if (config.CORS_ORIGIN.includes("*")) {
      console.error("[ZigmaNeural] FATAL: CORS_ORIGIN must not use '*' in production.");
      process.exit(1);
    }
  }

  return config;
}

export const config = loadConfig();
export type Config = typeof config;
