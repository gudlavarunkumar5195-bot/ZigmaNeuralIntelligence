import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

// Supabase (and most managed Postgres providers) require SSL in production.
// If the connection string already contains sslmode=require this is a no-op;
// if not, we enforce it explicitly so the pool never connects in plaintext.
const sslConfig =
  config.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: sslConfig,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    return await client.query<T>(text, values);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Create a dedicated client for LISTEN/NOTIFY (must not be pooled). */
export function createListenClient(): pg.Client {
  return new pg.Client({ connectionString: config.DATABASE_URL });
}
