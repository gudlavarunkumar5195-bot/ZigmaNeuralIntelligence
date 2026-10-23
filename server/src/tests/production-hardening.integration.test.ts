import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { INTEGRATION } from "./helpers/http.js";

/**
 * Phase 10 hardening against a real PostgreSQL database:
 * - audit_log is append-only for application sessions (migration 040);
 * - pooled connections carry server-side statement and idle-transaction timeouts.
 */
describe.skipIf(!INTEGRATION)("production hardening (real database)", () => {
  // A connection WITHOUT the test-only maintenance opt-in (see tests/setup.ts).
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL, options: "-c zigma.audit_maintenance=off" });
  let connected = false;
  const conn = async () => {
    if (!connected) { await app.connect(); connected = true; }
    return app;
  };
  afterAll(async () => {
    if (connected) await app.end();
    const { closePool } = await import("../db/client.js");
    await closePool();
  });

  it("refuses UPDATE, DELETE and TRUNCATE on audit_log, but allows inserts", async () => {
    const c = await conn();
    const marker = randomUUID();
    const { rows } = await c.query<{ id: string }>("INSERT INTO audit_log (action, result, resource_id) VALUES ('test_append_only', 'success', $1) RETURNING id", [marker]);
    expect(rows[0].id).toBeTruthy();
    await expect(c.query("UPDATE audit_log SET result = 'failure' WHERE resource_id = $1", [marker])).rejects.toThrow(/append-only \(UPDATE refused\)/);
    await expect(c.query("DELETE FROM audit_log WHERE resource_id = $1", [marker])).rejects.toThrow(/append-only \(DELETE refused\)/);
    await expect(c.query("TRUNCATE audit_log")).rejects.toThrow(/append-only \(TRUNCATE refused\)/);
    const still = await c.query("SELECT result FROM audit_log WHERE resource_id = $1", [marker]);
    expect(still.rows).toEqual([{ result: "success" }]);
  });

  it("allows documented maintenance only when the session opts in", async () => {
    const c = await conn();
    const marker = randomUUID();
    await c.query("INSERT INTO audit_log (action, result, resource_id) VALUES ('test_append_only', 'success', $1)", [marker]);
    await c.query("BEGIN");
    await c.query("SET LOCAL zigma.audit_maintenance = 'on'");
    await c.query("DELETE FROM audit_log WHERE resource_id = $1", [marker]);
    await c.query("COMMIT");
    expect((await c.query("SELECT 1 FROM audit_log WHERE resource_id = $1", [marker])).rowCount).toBe(0);
  });

  it("applies the statement and idle-in-transaction timeouts to pooled connections", async () => {
    const { query, sessionTimeouts } = await import("../db/client.js");
    expect(sessionTimeouts).toMatchObject({ statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 });
    const st = await query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(st.rows[0].statement_timeout).toBe("30s");
    const it = await query<{ idle_in_transaction_session_timeout: string }>("SHOW idle_in_transaction_session_timeout");
    expect(it.rows[0].idle_in_transaction_session_timeout).toBe("1min");
  });

  it("cancels a statement that runs past the timeout instead of holding the connection", async () => {
    const { withTransaction } = await import("../db/client.js");
    await expect(withTransaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '200ms'");
      await tx.query("SELECT pg_sleep(2)");
    })).rejects.toThrow(/statement timeout/);
  });
});
