import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMigrationsDir, discoverMigrations } from "../db/migrate.js";

const dir = defaultMigrationsDir();
const sql = readFileSync(join(dir, "000_supabase_role_compat.sql"), "utf-8");

describe("Neon/plain PostgreSQL role compatibility (P0-2)", () => {
  it("sorts before every migration that names the Supabase roles", () => {
    const files = discoverMigrations(dir);
    expect(files[0].version).toBe("000");
    const usesAuthenticated = files.filter((f) => f.version !== "000" &&
      /TO\s+authenticated|FROM\s+authenticated/i.test(readFileSync(join(dir, f.file), "utf-8")),
    );
    expect(usesAuthenticated.length).toBeGreaterThan(0);
    for (const f of usesAuthenticated) expect(Number(f.version)).toBeGreaterThan(0);
  });

  it("creates only the missing roles, as NOLOGIN, with no grants", () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = role_name\)/);
    expect(sql).toMatch(/CREATE ROLE %I NOLOGIN/);
    expect(sql).toMatch(/'authenticated', 'anon'/);
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\bLOGIN PASSWORD\b|SUPERUSER|BYPASSRLS/i);
  });

  it("fails with an actionable message instead of a bare permission error", () => {
    expect(sql).toMatch(/WHEN insufficient_privilege THEN/);
    expect(sql).toMatch(/WHEN duplicate_object THEN/);
  });

  it("does not modify any previously applied migration file", () => {
    // Checksums of applied migrations are enforced by the runner; this guards
    // the specific files the fix relies on not editing.
    const m021 = readFileSync(join(dir, "021_phase8_completion.sql"), "utf-8");
    expect(m021).toContain("FOR ALL TO authenticated");
  });
});
