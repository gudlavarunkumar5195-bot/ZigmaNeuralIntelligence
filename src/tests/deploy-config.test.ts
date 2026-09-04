import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("deployment startup configuration", () => {
  it("runs serialized migrations before starting the server", () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf-8")
    );

    expect(rootPackage.scripts.start).toBe("pnpm --dir server start");
    const appYaml = readFileSync(resolve(__dirname, "../../app.yaml"), "utf-8");
    expect(appYaml).toContain("run_command: pnpm --dir server migrate && pnpm --dir server start");
    expect(appYaml).toContain("http_path: /ready");
    expect(rootPackage.scripts.start).toBe("pnpm --dir server start");
  });

  it("declares Supabase integration variables and rejects wildcard CORS", () => {
    const appYaml = readFileSync(resolve(__dirname, "../../app.yaml"), "utf-8");
    const envExample = readFileSync(resolve(__dirname, "../../server.env.example"), "utf-8");
    const configSource = readFileSync(resolve(__dirname, "../../server/src/config.ts"), "utf-8");

    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      expect(appYaml).toContain(key);
      expect(envExample).toContain(key);
      expect(configSource).toContain(key);
    }

    expect(appYaml).not.toContain('value: "*"');
    expect(configSource).toContain("CORS_ORIGIN");
    expect(configSource).toContain('includes("*")');
  });

  it("registers the tenant-security migration and advisory lock", () => {
    const migrationSource = readFileSync(resolve(__dirname, "../../server/src/db/migrate.ts"), "utf-8");
    const migration = readFileSync(resolve(__dirname, "../../server/src/db/migrations/022_phase9a_tenant_security.sql"), "utf-8");
    expect(migrationSource).toContain('version: "022"');
    expect(migrationSource).toContain("pg_advisory_lock");
    expect(migrationSource).toContain("pg_advisory_unlock");
    expect(migration).toContain("zn_user_is_org_member");
    expect(migration).toContain("agent_stage_claims");
    expect(migration).toContain("reports");
    expect(migration).toContain("request.jwt.claims");
    expect(migration).toContain("scans_website_org_fk");
    expect(migration).toContain("reports_scan_org_fk");
    expect(migration).toContain("notification_alert_org_fk");
    expect(migration).toContain("REVOKE UPDATE, DELETE ON audit_log");
  });
});
