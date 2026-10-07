import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { defaultMigrationsDir, runMigrations, checksumOf } from "../db/migrate.js";

const BASE = process.env.TEST_DATABASE_URL;
const INTEGRATION = !!BASE && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("migration runner against PostgreSQL", () => {
  const dbName = `zigma_migrator_${Date.now()}`;
  const urlFor = (name: string) => { const u = new URL(BASE!); u.pathname = `/${name}`; return u.toString(); };
  let admin: pg.Pool;
  const pools: pg.Pool[] = [];
  const mk = (name: string) => { const p = new pg.Pool({ connectionString: urlFor(name) }); p.on("error", () => undefined); pools.push(p); return p; };
  const dirWith = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "migs-"));
    for (const [n, s] of Object.entries(files)) writeFileSync(join(d, n), s);
    return d;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: BASE });
    await admin.query(`CREATE DATABASE ${dbName}`);
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it("applies in order, records checksums, and is idempotent", async () => {
    const pool = mk(dbName);
    const dir = dirWith({
      "002_b.sql": "INSERT INTO t1 VALUES (2);",
      "001_a.sql": "CREATE TABLE t1 (n int);INSERT INTO t1 VALUES (1);",
      "005_gap.sql": "INSERT INTO t1 VALUES (5);",
    });
    const r1 = await runMigrations(pool, dir);
    expect(r1.applied).toEqual(["001", "002", "005"]);
    const { rows } = await pool.query("SELECT n FROM t1 ORDER BY n");
    expect(rows.map((x) => x.n)).toEqual([1, 2, 5]);
    const cs = await pool.query("SELECT version, checksum FROM schema_migrations WHERE version='001'");
    expect(cs.rows[0].checksum).toBe(checksumOf("CREATE TABLE t1 (n int);INSERT INTO t1 VALUES (1);"));
    const r2 = await runMigrations(pool, dir);
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toHaveLength(3);
  });

  it("detects a modified applied migration", async () => {
    const pool = mk(dbName);
    const dir = dirWith({ "001_a.sql": "CREATE TABLE t1 (n int);INSERT INTO t1 VALUES (1);-- edited", "002_b.sql": "SELECT 1;", "005_gap.sql": "SELECT 1;" });
    await expect(runMigrations(pool, dir)).rejects.toThrow(/001 was modified/);
  });

  it("backfills NULL checksums for pre-checksum rows", async () => {
    const pool = mk(dbName);
    await pool.query("UPDATE schema_migrations SET checksum = NULL WHERE version='002'");
    const dir = dirWith({ "001_a.sql": "CREATE TABLE t1 (n int);INSERT INTO t1 VALUES (1);", "002_b.sql": "INSERT INTO t1 VALUES (2);", "005_gap.sql": "INSERT INTO t1 VALUES (5);" });
    const r = await runMigrations(pool, dir);
    expect(r.backfilled).toEqual(["002"]);
    const { rows } = await pool.query("SELECT checksum FROM schema_migrations WHERE version='002'");
    expect(rows[0].checksum).toBe(checksumOf("INSERT INTO t1 VALUES (2);"));
  });

  it("rolls back a failing migration and does not record it", async () => {
    const pool = mk(dbName);
    const dir = dirWith({ "001_a.sql": "CREATE TABLE t1 (n int);INSERT INTO t1 VALUES (1);", "002_b.sql": "INSERT INTO t1 VALUES (2);", "005_gap.sql": "INSERT INTO t1 VALUES (5);", "006_bad.sql": "CREATE TABLE half (x int); SELECT 1/0;" });
    await expect(runMigrations(pool, dir)).rejects.toThrow(/division by zero/);
    expect((await pool.query("SELECT to_regclass('half') AS r")).rows[0].r).toBeNull();
    expect((await pool.query("SELECT 1 FROM schema_migrations WHERE version='006'")).rows).toHaveLength(0);
  });

  it("serialises concurrent runners", async () => {
    const name = `${dbName}_c`;
    await admin.query(`CREATE DATABASE ${name}`);
    const local: pg.Pool[] = [];
    try {
      const dir = dirWith({ "001_a.sql": "CREATE TABLE c1 (n int);", "002_b.sql": "INSERT INTO c1 VALUES (1);" });
      const a = new pg.Pool({ connectionString: urlFor(name) });
      const b = new pg.Pool({ connectionString: urlFor(name) });
      a.on("error", () => undefined); b.on("error", () => undefined); local.push(a, b);
      const [ra, rb] = await Promise.all([runMigrations(a, dir), runMigrations(b, dir)]);
      expect([...ra.applied, ...rb.applied].sort()).toEqual(["001", "002"]);
      expect((await a.query("SELECT count(*)::int AS c FROM c1")).rows[0].c).toBe(1);
    } finally {
      await Promise.all(local.map((p) => p.end()));
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });

  it("F-017: legacy 021 policies are dropped by 025, 022 policies remain", async () => {
    const name = `${dbName}_p`;
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new pg.Pool({ connectionString: urlFor(name) });
    pool.on("error", () => undefined);
    try {
      // Roles are cluster-level; ensure the Supabase roles exist.
      for (const role of ["authenticated", "anon", "service_role"]) {
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
      }
      const full = defaultMigrationsDir();
      const { readdirSync, cpSync } = await import("node:fs");
      const upTo021 = mkdtempSync(join(tmpdir(), "migs021-"));
      for (const f of readdirSync(full)) if (/^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 22) cpSync(join(full, f), join(upTo021, f));
      await runMigrations(pool, upTo021);
      const names = async () => (await pool.query("SELECT policyname FROM pg_policies WHERE schemaname='public'")).rows.map((r) => r.policyname as string);
      const before = await names();
      expect(before.filter((n) => n.endsWith("_org_isolation")).length).toBe(7);
      const membership = before.filter((n) => n.endsWith("_org_membership") || ["organizations_membership", "users_self", "audit_log_select", "audit_log_insert"].includes(n)).sort();
      expect(membership.length).toBeGreaterThan(20);

      await runMigrations(pool, full);
      const after = await names();
      expect(after.filter((n) => n.endsWith("_org_isolation"))).toEqual([]);
      // 026 intentionally supersedes the over-broad 022 memberships policy.
      const kept = membership.filter((n) => n !== "memberships_org_membership");
      expect(after.filter((n) => membership.includes(n)).sort()).toEqual(kept);
      expect(after).not.toContain("memberships_org_membership");
      expect(after).toContain("memberships_select_own_orgs");
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });
});
