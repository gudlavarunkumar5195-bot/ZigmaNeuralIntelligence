import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sslConfig = process.env.NODE_ENV === "production"
  ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" }
  : undefined;

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: sslConfig });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrations = [
      { version: "001", file: "001_initial.sql" },
      { version: "002", file: "002_ai_execution_columns.sql" },
      { version: "003", file: "003_model_registry.sql" },
      { version: "004", file: "004_routing.sql" },
      { version: "005", file: "005_agents.sql" },
      { version: "006", file: "006_instruction_intelligence.sql" },
      { version: "007", file: "007_evidence_intelligence.sql" },
      { version: "008", file: "008_quality_verification.sql" },
      { version: "009", file: "009_adaptive_regeneration.sql" },
      { version: "010", file: "010_adaptation_intelligence.sql" },
      { version: "011", file: "011_supabase_rls.sql" },
      { version: "012", file: "012_qa_verification.sql" },
      { version: "013", file: "013_scan_idempotency.sql" },
      { version: "014", file: "014_intelligence_reports.sql" },
      { version: "015", file: "015_multi_agent_reliability.sql" },
    ];

    for (const { version, file } of migrations) {
      const { rows } = await client.query(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (rows.length > 0) {
        console.log(`[migrate] ${version} already applied, skipping.`);
        continue;
      }

      const sql = readFileSync(join(__dirname, "migrations", file), "utf-8");
      console.log(`[migrate] Applying ${version}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version]
        );
        await client.query("COMMIT");
        console.log(`[migrate] ${version} applied.`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("[migrate] All migrations applied.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("[migrate] Fatal:", err.message);
  process.exit(1);
});
