// tsc does not copy .sql files; copy migrations into dist so the compiled
// migrator (dist/db/migrate.js) can resolve ./migrations at runtime.
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "db", "migrations");
const dest = join(root, "dist", "db", "migrations");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[build] copied migrations to ${dest}`);
