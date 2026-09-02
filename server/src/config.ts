import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // JWT
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  // Cookie
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 characters"),

  // CORS
  CORS_ORIGIN: z.string().default("http://localhost:8443"),

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
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
