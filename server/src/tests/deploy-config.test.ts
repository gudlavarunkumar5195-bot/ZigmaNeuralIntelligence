import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootDir = resolve(serverDir, "..");
const read = (p: string) => readFileSync(p, "utf-8");
const serverPkg = JSON.parse(read(join(serverDir, "package.json")));
const rootPkg = JSON.parse(read(join(rootDir, "package.json")));

/** Script names referenced as `pnpm [--dir server] <script>` in a command string. */
function referencedScripts(cmd: string): { dir: "root" | "server"; script: string }[] {
  const out: { dir: "root" | "server"; script: string }[] = [];
  for (const m of cmd.matchAll(/pnpm\s+(?:--dir\s+(\S+)\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
    if (["install", "i"].includes(m[2])) continue;
    out.push({ dir: m[1] === "server" ? "server" : "root", script: m[2] });
  }
  return out;
}
const exists = (r: { dir: string; script: string }) => !!(r.dir === "server" ? serverPkg : rootPkg).scripts[r.script];

describe("deploy configuration (F-018)", () => {
  it("migrate scripts do not depend on tsx and run compiled output", () => {
    expect(serverPkg.scripts["migrate:prod"]).toBe(serverPkg.scripts.migrate);
    expect(serverPkg.scripts.migrate).toContain("dist/db/migrate.js");
    expect(serverPkg.scripts.migrate).not.toMatch(/tsx/);
    expect(serverPkg.scripts.build).toContain("copy-migrations");
    expect(existsSync(join(serverDir, "scripts/copy-migrations.mjs"))).toBe(true);
  });

  it("root has no non-frozen reinstall prebuild", () => {
    expect(rootPkg.scripts.prebuild).toBeUndefined();
    expect(JSON.stringify(rootPkg.scripts)).not.toContain("no-frozen-lockfile");
  });

  it("app.yaml commands use frozen installs and existing scripts", () => {
    const y = read(join(rootDir, "app.yaml"));
    const cmds = [...y.matchAll(/^\s*(?:build_command|run_command):\s*(.+)$/gm)].map((m) => m[1]);
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    for (const c of cmds) {
      expect(c).not.toContain("no-frozen-lockfile");
      expect(c).not.toMatch(/tsx/);
      for (const r of referencedScripts(c)) expect(exists(r), `${c} -> ${r.script}`).toBe(true);
    }
    expect(y).toMatch(/migrate:prod/);
  });

  it("Procfile commands refer to existing scripts and include migration", () => {
    const lines = read(join(rootDir, "Procfile")).split("\n").filter(Boolean);
    expect(lines.some((l) => l.startsWith("release:") && l.includes("migrate:prod"))).toBe(true);
    for (const l of lines) for (const r of referencedScripts(l.split(":").slice(1).join(":"))) expect(exists(r), l).toBe(true);
  });

  it("dist is gitignored", () => {
    expect(read(join(rootDir, ".gitignore"))).toMatch(/^dist\/$/m);
  });

  describe("server build output", () => {
    beforeAll(() => {
      execFileSync("pnpm", ["run", "build"], { cwd: serverDir, stdio: "pipe" });
    }, 120_000);

    it("compiles the migrator and copies every SQL migration into dist", () => {
      expect(existsSync(join(serverDir, "dist/db/migrate.js"))).toBe(true);
      const src = readdirSync(join(serverDir, "src/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
      const dist = readdirSync(join(serverDir, "dist/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
      expect(dist).toEqual(src);
    });

    it("compiled migrator does not execute on import and resolves SQL dir", async () => {
      const mod = await import(pathToUrl(join(serverDir, "dist/db/migrate.js")));
      expect(readdirSync(mod.defaultMigrationsDir()).some((f) => f.startsWith("001_"))).toBe(true);
    });
  });
});

function pathToUrl(p: string) { return new URL(`file://${p}`).href; }
