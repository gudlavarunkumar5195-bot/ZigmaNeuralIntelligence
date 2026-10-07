import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumOf, defaultMigrationsDir, discoverMigrations, orderMigrationFiles } from "../db/migrate.js";

describe("migration runner (pure)", () => {
  it("orders by numeric prefix, tolerating gaps, ignoring non-migrations", () => {
    const out = orderMigrationFiles(["010_b.sql", "002_a.sql", "README.md", "025_z.sql", "1000_big.sql", "supabase_setup.sql"]);
    expect(out.map((f) => f.version)).toEqual(["002", "010", "025", "1000"]);
  });
  it("rejects duplicate version numbers", () => {
    expect(() => orderMigrationFiles(["023_a.sql", "023_b.sql"])).toThrow(/Duplicate migration version 023/);
  });
  it("checksum is stable and line-ending insensitive", () => {
    expect(checksumOf("a\nb")).toBe(checksumOf("a\r\nb"));
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
    expect(checksumOf("a")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("discovers every real migration file with unique versions", () => {
    const dir = defaultMigrationsDir();
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(discoverMigrations(dir)).toHaveLength(sql.length);
    expect(mkdtempSync(join(tmpdir(), "mig-"))).toBeTruthy();
  });
});
