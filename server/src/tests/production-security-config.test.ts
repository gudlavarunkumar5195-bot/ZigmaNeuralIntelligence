import { describe, expect, it } from "vitest";
import { validateProductionSecurityConfig } from "../config-security.js";

const baseEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://localhost/test",
  JWT_SECRET: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
  COOKIE_SECRET: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c",
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

describe("production secret and origin hygiene", () => {
  it("rejects placeholder, identical and low-entropy secrets", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, JWT_SECRET: "replace_with_at_least_32_char_random_secret" })).toThrow(/placeholder/);
    expect(() => validateProductionSecurityConfig({ ...baseEnv, COOKIE_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toThrow(/entropy/);
    expect(() => validateProductionSecurityConfig({ ...baseEnv, COOKIE_SECRET: baseEnv.JWT_SECRET })).toThrow(/differ/);
  });
  it("requires an explicit non-localhost CORS origin", () => {
    expect(() => validateProductionSecurityConfig({ ...baseEnv, CORS_ORIGIN: undefined })).toThrow(/CORS_ORIGIN/);
    expect(() => validateProductionSecurityConfig({ ...baseEnv, CORS_ORIGIN: "http://localhost:8443" })).toThrow(/CORS_ORIGIN/);
  });
  it("parses DB_SSL_REJECT_UNAUTHORIZED strictly (false is not true)", async () => {
    const { loadConfig } = await import("../config.js");
    const env = { ...baseEnv, NODE_ENV: "test", PLATFORM_ADMIN_USER_IDS: "" };
    expect(loadConfig({ ...env, DB_SSL_REJECT_UNAUTHORIZED: "false" }).DB_SSL_REJECT_UNAUTHORIZED).toBe(false);
    expect(loadConfig(env).DB_SSL_REJECT_UNAUTHORIZED).toBe(true);
    expect(() => loadConfig({ ...env, DB_SSL_REJECT_UNAUTHORIZED: "maybe" })).toThrow();
  });
});

describe("QA bypass boolean parsing", () => {
  const qaEnv = (over: Record<string, string | undefined>) => ({ ...baseEnv, NODE_ENV: "test", ...over });

  it("never treats the string false as enabled", async () => {
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(qaEnv({ QA_VERIFICATION_BYPASS_ENABLED: "false", QA_ALLOW_PRODUCTION_BYPASS: "false" }));
    expect(cfg.QA_VERIFICATION_BYPASS_ENABLED).toBe(false);
    expect(cfg.QA_ALLOW_PRODUCTION_BYPASS).toBe(false);
  });

  it("defaults to disabled when unset or empty, enables only on explicit true", async () => {
    const { loadConfig } = await import("../config.js");
    expect(loadConfig(qaEnv({})).QA_VERIFICATION_BYPASS_ENABLED).toBe(false);
    expect(loadConfig(qaEnv({ QA_VERIFICATION_BYPASS_ENABLED: "" })).QA_VERIFICATION_BYPASS_ENABLED).toBe(false);
    expect(loadConfig(qaEnv({ QA_VERIFICATION_BYPASS_ENABLED: "true" })).QA_VERIFICATION_BYPASS_ENABLED).toBe(true);
  });

  it("rejects ambiguous values instead of coercing them", async () => {
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig(qaEnv({ QA_VERIFICATION_BYPASS_ENABLED: "nope" }))).toThrow(/Invalid server configuration/);
  });

  it("production rejects every non-false spelling", () => {
    for (const v of ["TRUE", " true ", "1", "yes", "nope"]) {
      expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_VERIFICATION_BYPASS_ENABLED: v })).toThrow(/QA verification bypass/);
      expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_ALLOW_PRODUCTION_BYPASS: v })).toThrow(/QA verification bypass/);
    }
    for (const v of [undefined, "", "false", "FALSE", "0"]) {
      expect(() => validateProductionSecurityConfig({ ...baseEnv, QA_VERIFICATION_BYPASS_ENABLED: v })).not.toThrow();
    }
  });
});
