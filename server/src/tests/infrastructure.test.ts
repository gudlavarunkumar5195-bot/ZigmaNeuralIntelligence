import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://neondb_owner:pw-should-never-leak@ep-x-1-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    NODE_ENV: "test",
    DB_SSL_REJECT_UNAUTHORIZED: true,
    CLICKHOUSE_PORT: 8443,
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_HOST: "svc.ap-southeast-1.aws.clickhouse.cloud",
    CLICKHOUSE_PASSWORD: "pw-should-never-leak",
  },
}));
import {
  classifyClickHouseResponse,
  classifyError,
  describeConfiguration,
  describePostgres,
} from "../services/infrastructure.js";

const FAKE_SECRET = "pw-should-never-leak";

describe("describePostgres", () => {
  it("derives Neon facts without returning host, password or URL", () => {
    const p = describePostgres(`postgresql://neondb_owner:${FAKE_SECRET}@ep-x-1-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`);
    expect(p).toMatchObject({ provider: "neon", region: "ap-southeast-1", database: "neondb", role: "neondb_owner", pooled: true, sslMode: "require", sslEnforced: true });
    const json = JSON.stringify(p);
    expect(json).not.toContain(FAKE_SECRET);
    expect(json).not.toContain("ep-x-1");
  });
  it("reports a direct (non-pooled) Neon endpoint", () => {
    expect(describePostgres("postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db").pooled).toBe(false);
  });
  it("handles unparseable and missing URLs", () => {
    expect(describePostgres("not a url").provider).toBe("unknown");
    expect(describePostgres("").configured).toBe(false);
  });
});

describe("classifyError", () => {
  it.each([
    [{ code: "ENOTFOUND" }, "dns"],
    [{ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }, "certificate"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "certificate"],
    [{ code: "CERT_HAS_EXPIRED" }, "certificate"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "hostname"],
    [{ code: "EPROTO" }, "tls"],
    [{ code: "28P01" }, "auth"],
    [{ code: "3D000" }, "database"],
    [{ code: "TIMEOUT" }, "timeout"],
    [{ code: "ECONNREFUSED" }, "connection"],
  ])("%o -> %s", (err, stage) => {
    expect(classifyError(err)).toBe(stage);
  });
});

describe("classifyClickHouseResponse", () => {
  it("distinguishes auth, unknown database and generic failures", () => {
    expect(classifyClickHouseResponse({ status: 200, body: "1\n" })).toBe("ok");
    expect(classifyClickHouseResponse({ status: 401, body: "" })).toBe("auth");
    expect(classifyClickHouseResponse({ status: 500, body: "Code: 516. DB::Exception: default: Authentication failed" })).toBe("auth");
    expect(classifyClickHouseResponse({ status: 404, body: "Code: 81. DB::Exception: Database x doesn't exist. (UNKNOWN_DATABASE)" })).toBe("database");
    expect(classifyClickHouseResponse({ status: 500, body: "Code: 62. Syntax error" })).toBe("query");
  });
});

describe("describeConfiguration", () => {
  it("never returns secret values", () => {
    const cfg = describeConfiguration();
    for (const e of [...cfg.postgres, ...cfg.clickhouse]) {
      if (e.secret) {
        expect(e.value).toBeUndefined();
        expect(["MASKED", "NOT_SET"]).toContain(e.state);
      }
    }
    expect(cfg.postgres.find((e) => e.name === "DATABASE_URL")?.state).toBe("MASKED");
    expect(cfg.clickhouse.find((e) => e.name === "CLICKHOUSE_DATABASE")?.state).toBe("NOT_SET");
    expect(JSON.stringify(cfg)).not.toContain(FAKE_SECRET);
  });
});

describe("TLS bypass guard", () => {
  it("no server source disables certificate verification", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? (d.name === "tests" ? [] : walk(join(dir, d.name))) : d.name.endsWith(".ts") ? [join(dir, d.name)] : [],
      );
    for (const file of walk(join(process.cwd(), "src"))) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/);
      if (file.includes("infrastructure")) expect(src, file).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    }
  });
});
