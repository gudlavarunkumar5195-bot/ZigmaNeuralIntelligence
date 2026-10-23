// Web-server command for playwright.integration.config.ts: migrate the
// throwaway database, seed it, then run the real API in the foreground.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = path.join(root, "server");
const env = { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL, NODE_ENV: "development" };

function step(label, args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[e2e] ${label} failed`);
    process.exit(r.status ?? 1);
  }
}

step("migrate", ["--import", "tsx", "src/db/migrate.ts"], server);
step("seed", ["--import", "tsx", path.join(root, "e2e/integration/seed.mts"), path.join(root, "e2e/.fixture.json")], server);

// The seeded owner is this throwaway server's platform administrator, so the
// administration screens can be exercised too.
const seeded = JSON.parse(fs.readFileSync(path.join(root, "e2e/.fixture.json"), "utf8"));
const api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: server, env: { ...env, PLATFORM_ADMIN_USER_IDS: seeded.ownerId }, stdio: "inherit" });
const stop = () => api.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
api.on("exit", (code) => process.exit(code ?? 0));
