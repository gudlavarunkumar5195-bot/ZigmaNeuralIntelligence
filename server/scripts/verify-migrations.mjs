// Migration safety checks for CI (P0-1 / P0-2). Run after `pnpm --dir server build`.
//
//   VERIFY_MIGRATIONS_ADMIN_URL=postgresql://ci:ci@127.0.0.1:5432/zni_ci \
//   node server/scripts/verify-migrations.mjs
//
// The admin URL must be a SUPERUSER on a THROWAWAY cluster: the script creates
// and drops databases and login roles. It refuses non-local hosts.
//
// Checks, in order (the cluster must not yet contain the Supabase roles):
//   1. A role WITHOUT CREATEROLE on a fresh database fails at 000 with the
//      actionable "lacks CREATEROLE" message and applies nothing.
//   2. A Neon-like owner (LOGIN, CREATEDB, CREATEROLE, NOT SUPERUSER) migrates
//      a fresh database from zero to latest, and a second run is a no-op.
//   3. Upgrade: for each baseline git ref, apply that ref's migrations, then
//      the current ones. Only the new versions apply, every recorded checksum
//      matches, and the resulting schema equals the fresh install's.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { checksumOf, defaultMigrationsDir, discoverMigrations, runMigrations } from "../dist/db/migrate.js";

const ADMIN_URL = process.env.VERIFY_MIGRATIONS_ADMIN_URL;
// 1ca145b: last release before Phase 1 (migrations 001-026, no 000).
const BASELINES = (process.env.MIGRATION_BASELINES ?? "1ca145b,origin/main").split(",").map((s) => s.trim()).filter(Boolean);
const MIGRATIONS_PATH = "server/src/db/migrations";
const RUN = `${process.pid}_${Date.now()}`;

if (!ADMIN_URL) {
  console.error("[verify-migrations] VERIFY_MIGRATIONS_ADMIN_URL is required");
  process.exit(1);
}
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(ADMIN_URL).hostname)) {
  console.error("[verify-migrations] refusing to run against a non-local host: this script creates and drops roles");
  process.exit(1);
}

class CheckFailed extends Error {}
function fail(message) {
  throw new CheckFailed(message);
}
function ok(message) {
  console.log(`[verify-migrations] ok: ${message}`);
}
function urlFor(db, user, password) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
}

const admin = new pg.Pool({ connectionString: ADMIN_URL });
const cleanup = { dbs: [], roles: [] };

async function freshDb(name, owner) {
  await admin.query(`CREATE DATABASE ${name}${owner ? ` OWNER ${owner}` : ""}`);
  cleanup.dbs.push(name);
}
async function loginRole(name, attrs) {
  const password = `pw_${RUN}`;
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${attrs}`);
  cleanup.roles.push(name);
  return password;
}
async function withPool(url, fn) {
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", () => undefined);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Catalog fingerprint of the public schema: tables, columns, constraints, indexes, policies, functions. */
async function schemaFingerprint(pool) {
  const q = async (sql) => (await pool.query(sql)).rows.map((r) => Object.values(r).join("|")).join("\n");
  return [
    await q(`SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'')
             FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`),
    await q(`SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
             FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
    await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`),
    await q(`SELECT tablename, policyname, cmd, array_to_string(roles, ','), coalesce(qual,''), coalesce(with_check,'')
             FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`),
    await q(`SELECT relname, relrowsecurity::text, relforcerowsecurity::text FROM pg_class
             WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1`),
    await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc)
             FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1,2`),
  ].join("\n--\n");
}

function migrationsAt(ref) {
  const names = execFileSync("git", ["ls-tree", "--name-only", `${ref}:${MIGRATIONS_PATH}`], { encoding: "utf8" })
    .split("\n")
    .filter((n) => /^\d{3,}_.*\.sql$/.test(n));
  const dir = mkdtempSync(join(tmpdir(), `migs-${ref.replace(/[^A-Za-z0-9]/g, "_")}-`));
  for (const n of names) {
    writeFileSync(join(dir, n), execFileSync("git", ["show", `${ref}:${MIGRATIONS_PATH}/${n}`], { encoding: "utf8" }));
  }
  return { dir, versions: discoverMigrations(dir).map((m) => m.version) };
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const current = defaultMigrationsDir();
  const currentVersions = discoverMigrations(current).map((m) => m.version);

  const existing = await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated','anon')");
  if (existing.rows.length > 0) {
    fail("the cluster already has the Supabase roles; run these checks on a fresh cluster before anything else migrates");
  }
  ok("cluster has only default roles (no authenticated/anon)");
  // Leave the cluster as found: 000 creates these during the checks below.
  cleanup.roles.push("anon", "authenticated");

  // 1. No CREATEROLE: actionable failure, nothing applied.
  const restricted = `zni_restricted_${RUN}`;
  const restrictedPw = await loginRole(restricted, "NOSUPERUSER NOCREATEROLE NOCREATEDB");
  const restrictedDb = `zni_restricted_db_${RUN}`;
  await freshDb(restrictedDb, restricted);
  await withPool(urlFor(restrictedDb, restricted, restrictedPw), async (pool) => {
    let error;
    try {
      await runMigrations(pool, current);
    } catch (e) {
      error = e;
    }
    if (!error) fail("migration without CREATEROLE unexpectedly succeeded");
    if (!/lacks CREATEROLE/.test(String(error.message))) fail(`unexpected error without CREATEROLE: ${error.message}`);
    const applied = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    if (applied.rows[0].n !== 0) fail(`expected nothing applied without CREATEROLE, found ${applied.rows[0].n}`);
  });
  ok("role without CREATEROLE stops at 000 with the actionable message and applies nothing");

  // 2. Neon-like owner: fresh database, zero to latest, then a no-op re-run.
  const owner = `zni_owner_${RUN}`;
  const ownerPw = await loginRole(owner, "NOSUPERUSER CREATEROLE CREATEDB");
  const freshName = `zni_fresh_${RUN}`;
  await freshDb(freshName, owner);
  const freshPrint = await withPool(urlFor(freshName, owner, ownerPw), async (pool) => {
    const first = await runMigrations(pool, current);
    if (first.applied.join() !== currentVersions.join()) {
      fail(`fresh database applied ${first.applied.join(",")} instead of ${currentVersions.join(",")}`);
    }
    const second = await runMigrations(pool, current);
    if (second.applied.length !== 0) fail(`second run re-applied ${second.applied.join(",")}`);
    const roles = await pool.query(
      "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('authenticated','anon') ORDER BY 1",
    );
    if (roles.rows.length !== 2 || roles.rows.some((r) => r.rolcanlogin || r.rolsuper)) {
      fail(`000 must create exactly two NOLOGIN, non-superuser roles; got ${JSON.stringify(roles.rows)}`);
    }
    const grants = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE grantee IN ('authenticated','anon') AND table_schema='public'`,
    );
    ok(`fresh database as a non-superuser owner: ${first.applied.length} migrations applied, re-run no-op; roles NOLOGIN; table grants to them: ${grants.rows[0].n}`);
    return schemaFingerprint(pool);
  });

  // 3. Upgrade from each baseline.
  for (const ref of BASELINES) {
    if (!refExists(ref)) {
      console.log(`[verify-migrations] skip: baseline ${ref} not available in this checkout`);
      continue;
    }
    const base = migrationsAt(ref);
    const expectedNew = currentVersions.filter((v) => !base.versions.includes(v));
    const dbName = `zni_upgrade_${ref.replace(/[^A-Za-z0-9]/g, "_")}_${RUN}`.toLowerCase();
    await freshDb(dbName, owner);
    await withPool(urlFor(dbName, owner, ownerPw), async (pool) => {
      await runMigrations(pool, base.dir);
      const upgraded = await runMigrations(pool, current);
      if (upgraded.applied.join() !== expectedNew.join()) {
        fail(`upgrade from ${ref} applied ${upgraded.applied.join(",") || "nothing"}; expected ${expectedNew.join(",") || "nothing"}`);
      }
      const rows = (await pool.query("SELECT version, checksum FROM schema_migrations")).rows;
      for (const m of discoverMigrations(current)) {
        const row = rows.find((r) => r.version === m.version);
        if (!row || row.checksum !== checksumOf(readFileSync(join(current, m.file), "utf8"))) {
          fail(`after upgrade from ${ref}, ${m.version} is missing or its checksum differs`);
        }
      }
      const print = await schemaFingerprint(pool);
      if (print !== freshPrint) {
        const a = print.split("\n");
        const b = new Set(freshPrint.split("\n"));
        const diff = a.filter((l) => !b.has(l)).slice(0, 10);
        fail(`schema after upgrade from ${ref} differs from a fresh install, e.g.:\n${diff.join("\n")}`);
      }
      ok(`upgrade from ${ref} (${base.versions.length} migrations) applied ${expectedNew.join(",") || "nothing new"}; checksums intact; schema identical to fresh install`);
    });
  }
}

try {
  await main();
} catch (e) {
  console.error(`[verify-migrations] FAIL: ${e instanceof CheckFailed ? e.message : e.stack}`);
  process.exitCode = 1;
} finally {
  for (const db of cleanup.dbs.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
  for (const role of cleanup.roles.reverse()) {
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch((e) => console.error(`[verify-migrations] could not drop role ${role}: ${e.message}`));
  }
  await admin.end();
}
if (!process.exitCode) console.log("[verify-migrations] all checks passed");
