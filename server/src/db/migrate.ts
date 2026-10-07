import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import pg from "pg";

/*
 * Migration runner (F-019).
 *
 * - Files are discovered from the migrations directory (NNN_name.sql), ordered
 *   by numeric prefix then name. Gaps in numbering are allowed; duplicate
 *   numeric versions are rejected.
 * - Every applied migration stores a sha256 checksum. A changed file whose
 *   version is already applied aborts the run.
 * - Locking uses pg_advisory_xact_lock inside each transaction (transaction
 *   scoped, so it is safe behind transaction poolers, unlike session locks).
 * - Each migration and its schema_migrations row commit atomically.
 *
 * BACKFILL RISK: migrations 001-022 were applied before checksums existed.
 * On the first run, rows with a NULL checksum are backfilled from the files
 * CURRENT on disk. If one of those files was edited after being applied, the
 * backfill silently blesses the edited content and drift is NOT detected for
 * that migration. Review git history of 001-022 against the live schema once
 * (in staging) before relying on checksums for those versions.
 */

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
}

export interface MigrationLogger {
  info(message: string): void;
  error?(message: string): void;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
export interface MigrationPool {
  connect(): Promise<Queryable & { release(): void }>;
}

const FILE_PATTERN = /^(\d{3,})_([A-Za-z0-9_.-]+)\.sql$/;
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('zignaneural:schema-migrations', 0))";

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Pure: order and validate a list of file names. Non-matching names are ignored. */
export function orderMigrationFiles(fileNames: string[]): MigrationFile[] {
  const parsed: MigrationFile[] = [];
  for (const file of fileNames) {
    const m = FILE_PATTERN.exec(file);
    if (!m) continue;
    parsed.push({ version: m[1], name: m[2], file });
  }
  const seen = new Map<number, string>();
  for (const p of parsed) {
    const n = Number(p.version);
    const prior = seen.get(n);
    if (prior) throw new Error(`Duplicate migration version ${p.version}: ${prior} and ${p.file}`);
    seen.set(n, p.file);
  }
  return parsed.sort((a, b) => Number(a.version) - Number(b.version) || a.name.localeCompare(b.name));
}

export function discoverMigrations(dir: string): MigrationFile[] {
  return orderMigrationFiles(readdirSync(dir));
}

const noopLogger: MigrationLogger = { info: () => undefined };

export async function runMigrations(
  pool: MigrationPool,
  dir: string,
  logger: MigrationLogger = noopLogger,
): Promise<{ applied: string[]; skipped: string[]; backfilled: string[] }> {
  const files = discoverMigrations(dir);
  const contents = new Map(files.map((f) => [f.version, readFileSync(join(dir, f.file), "utf-8")]));
  const result = { applied: [] as string[], skipped: [] as string[], backfilled: [] as string[] };

  const client = await pool.connect();
  const tx = async (fn: () => Promise<void>) => {
    await client.query("BEGIN");
    try {
      await client.query(LOCK_SQL);
      await fn();
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  };

  try {
    // Bootstrap + verification in one locked transaction.
    await tx(async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(50) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
      const { rows } = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
      for (const row of rows as { version: string; checksum: string | null }[]) {
        const sql = contents.get(row.version);
        if (sql === undefined) {
          throw new Error(`Applied migration ${row.version} has no file in ${dir}`);
        }
        const actual = checksumOf(sql);
        if (row.checksum === null) {
          await client.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [row.version, actual]);
          result.backfilled.push(row.version);
          logger.info(`[migrate] ${row.version} checksum backfilled from current file (pre-checksum migration).`);
        } else if (row.checksum !== actual) {
          throw new Error(
            `Migration ${row.version} was modified after being applied (recorded ${row.checksum.slice(0, 12)}, file ${actual.slice(0, 12)}). Add a new migration instead of editing applied ones.`,
          );
        }
      }
    });

    for (const m of files) {
      await tx(async () => {
        // Re-check under the lock: another runner may have applied it meanwhile.
        const { rows } = await client.query("SELECT checksum FROM schema_migrations WHERE version = $1", [m.version]);
        if (rows.length > 0) {
          result.skipped.push(m.version);
          logger.info(`[migrate] ${m.version} already applied, skipping.`);
          return;
        }
        const sql = contents.get(m.version)!;
        logger.info(`[migrate] Applying ${m.version} (${m.name})...`);
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, checksumOf(sql)]);
        result.applied.push(m.version);
        logger.info(`[migrate] ${m.version} applied.`);
      });
    }
    logger.info("[migrate] All migrations applied.");
    return result;
  } finally {
    client.release();
  }
}

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

async function main() {
  const { validateProductionSecurityConfig } = await import("../config-security.js");
  const DATABASE_URL = process.env.DATABASE_URL;
  validateProductionSecurityConfig(process.env);
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const ssl =
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}) }
      : undefined;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl });
  try {
    await runMigrations(pool as unknown as MigrationPool, defaultMigrationsDir(), { info: console.log, error: console.error });
  } finally {
    await pool.end();
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error("[migrate] Fatal:", err.message);
    process.exit(1);
  });
}
