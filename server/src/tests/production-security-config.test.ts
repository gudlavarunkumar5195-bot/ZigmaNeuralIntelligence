import { describe, expect, it } from "vitest";
import { validateProductionSecurityConfig } from "../config-security.js";

const baseEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://localhost/test",
  JWT_SECRET: "12345678901234567890123456789012",
  COOKIE_SECRET: "12345678901234567890123456789012",
  CORS_ORIGIN: "https://app.example.com",
  DB_SSL_REJECT_UNAUTHORIZED: "true",
};

describe("production security configuration", () => {
  it("fails closed when production enables QA bypass", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_VERIFICATION_BYPASS_ENABLED: "true" })).toThrow(/QA verification bypass/);
    expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_ALLOW_PRODUCTION_BYPASS: "true" })).toThrow(/QA verification bypass/);
  });

  it("fails closed when production disables database TLS verification", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, DB_SSL_REJECT_UNAUTHORIZED: "false" })).toThrow(/DB_SSL_REJECT_UNAUTHORIZED=true/);
    expect(() => validateProductionSecurityConfig({ ...baseEnv, DB_SSL_REJECT_UNAUTHORIZED: undefined })).toThrow(/DB_SSL_REJECT_UNAUTHORIZED=true/);
  });

  it("accepts production only with bypasses disabled and TLS verification enabled", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_VERIFICATION_BYPASS_ENABLED: "false", QA_ALLOW_PRODUCTION_BYPASS: "false" })).not.toThrow();
  });

  it("preserves explicit non-production QA policy", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, NODE_ENV: "test", DB_SSL_REJECT_UNAUTHORIZED: "false", QA_VERIFICATION_BYPASS_ENABLED: "true", QA_ALLOW_PRODUCTION_BYPASS: "false" })).not.toThrow();
  });
});
