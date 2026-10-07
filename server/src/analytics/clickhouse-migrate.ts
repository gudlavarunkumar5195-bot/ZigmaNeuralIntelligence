import { chRequest, isClickHouseConfigured } from "../services/infrastructure.js";
import { config } from "../config.js";
import { CLICKHOUSE_DDL, CLICKHOUSE_TABLES } from "./schema.js";

/** Read-only: which analytics tables exist in the configured database. */
export async function getClickHouseSchemaStatus() {
  if (!isClickHouseConfigured()) return { configured: false, reachable: false, tables: [] as { name: string; present: boolean }[] };
  try {
    const db = (config.CLICKHOUSE_DATABASE ?? "default").replace(/'/g, "");
    const res = await chRequest(`SELECT name FROM system.tables WHERE database = '${db}' FORMAT JSONEachRow`);
    if (res.status < 200 || res.status >= 300) return { configured: true, reachable: false, tables: [] };
    const present = new Set(res.body.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { name: string }).name));
    return { configured: true, reachable: true, tables: CLICKHOUSE_TABLES.map((name) => ({ name, present: present.has(name) })) };
  } catch {
    return { configured: true, reachable: false, tables: [] };
  }
}

/** Idempotent (CREATE TABLE IF NOT EXISTS). Server-side CLI only. */
export async function applyClickHouseSchema(): Promise<void> {
  if (!isClickHouseConfigured()) throw new Error("ClickHouse is not configured (CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD)");
  for (const table of CLICKHOUSE_TABLES) {
    const res = await chRequest(CLICKHOUSE_DDL[table], config.CLICKHOUSE_DATABASE);
    if (res.status < 200 || res.status >= 300) throw new Error(`Failed to create ${table} (HTTP ${res.status})`);
    console.log(JSON.stringify({ event: "clickhouse_table_ready", table }));
  }
}

const isMain = process.argv[1] && /clickhouse-migrate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  applyClickHouseSchema().then(
    () => process.exit(0),
    (err: Error) => {
      console.error(JSON.stringify({ event: "clickhouse_migrate_failed", error: err.message }));
      process.exit(1);
    },
  );
}
