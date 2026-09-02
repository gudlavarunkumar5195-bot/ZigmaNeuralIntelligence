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
});
