import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("deployment startup configuration", () => {
  it("starts the server without running database migrations at boot", () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf-8")
    );

    expect(rootPackage.scripts.start).toBe("pnpm --dir server start");
    expect(rootPackage.scripts.start).not.toContain("run migrate");

    const appYaml = readFileSync(resolve(__dirname, "../../app.yaml"), "utf-8");
    expect(appYaml).toContain("run_command: pnpm --dir server start");
  });

  it("declares the required production Supabase runtime variables and rejects wildcard CORS", () => {
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
});
