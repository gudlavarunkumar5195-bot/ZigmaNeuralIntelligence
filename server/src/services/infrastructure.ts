// Platform infrastructure diagnostics (Administration > Infrastructure).
//
// SECURITY: nothing returned from this module may contain a secret. Connection
// strings, passwords and CA contents are reduced to SET / NOT_SET / MASKED.
// TLS verification is never disabled here: certificate failures are reported
// as a diagnostic stage, never retried insecurely.

import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";
import tls from "node:tls";
import pg from "pg";
import { config } from "../config.js";
import { dbSslConfig, query } from "../db/client.js";
import { checksumOf, defaultMigrationsDir, discoverMigrations } from "../db/migrate.js";

const STEP_TIMEOUT_MS = 8_000;

export type StepStatus = "ok" | "failed" | "skipped" | "warning";
export type ConnectionStatus =
  | "connected"
  | "not_configured"
  | "configuration_error"
  | "authentication_failed"
  | "tls_error"
  | "timeout"
  | "unavailable";

export interface DiagnosticStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface DiagnosticResult {
  status: ConnectionStatus;
  summary: string;
  steps: DiagnosticStep[];
  latencyMs: number | null;
  checkedAt: string;
}

// ─── Configuration (names + presence only) ────────────────────────────────────

export type ConfigValueState = "SET" | "NOT_SET" | "MASKED";
export interface ConfigEntry {
  name: string;
  state: ConfigValueState;
  secret: boolean;
  required: boolean;
  /** Only populated for non-secret values (e.g. port, user). */
  value?: string;
}

function entry(name: string, raw: string | number | undefined, secret: boolean, required: boolean): ConfigEntry {
  const present = raw !== undefined && String(raw).trim() !== "";
  if (!present) return { name, state: "NOT_SET", secret, required };
  if (secret) return { name, state: "MASKED", secret, required };
  return { name, state: "SET", secret, required, value: String(raw) };
}

export function describeConfiguration(): { postgres: ConfigEntry[]; clickhouse: ConfigEntry[] } {
  return {
    postgres: [
      entry("DATABASE_URL", config.DATABASE_URL, true, true),
      entry("DIRECT_DATABASE_URL", config.DIRECT_DATABASE_URL, true, false),
      entry("DB_SSL_CA", config.DB_SSL_CA, true, false),
      entry("DB_SSL_REJECT_UNAUTHORIZED", String(config.DB_SSL_REJECT_UNAUTHORIZED), false, false),
      entry("NEON_BRANCH", config.NEON_BRANCH, false, false),
    ],
    clickhouse: [
      entry("CLICKHOUSE_HOST", config.CLICKHOUSE_HOST, true, true),
      entry("CLICKHOUSE_PORT", config.CLICKHOUSE_PORT, false, true),
      entry("CLICKHOUSE_DATABASE", config.CLICKHOUSE_DATABASE, false, true),
      entry("CLICKHOUSE_USER", config.CLICKHOUSE_USER, false, true),
      entry("CLICKHOUSE_PASSWORD", config.CLICKHOUSE_PASSWORD, true, true),
      entry("CLICKHOUSE_CA_CERT", config.CLICKHOUSE_CA_CERT, true, false),
    ],
  };
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

export interface PostgresProfile {
  configured: boolean;
  provider: "neon" | "supabase" | "postgresql" | "unknown";
  region: string | null;
  database: string | null;
  role: string | null;
  pooled: boolean | null;
  branch: string | null;
  sslMode: string | null;
  sslEnforced: boolean;
  certificateVerification: boolean;
}

/** Derives non-secret facts from DATABASE_URL. Never returns host, password or the URL. */
export function describePostgres(url: string | undefined = config.DATABASE_URL): PostgresProfile {
  const base: PostgresProfile = {
    configured: false,
    provider: "unknown",
    region: null,
    database: null,
    role: null,
    pooled: null,
    branch: config.NEON_BRANCH ?? null,
    sslMode: null,
    sslEnforced: !!dbSslConfig,
    certificateVerification: !!dbSslConfig && dbSslConfig.rejectUnauthorized !== false,
  };
  if (!url) return base;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, configured: true };
  }
  const host = parsed.hostname.toLowerCase();
  const provider = host.endsWith(".neon.tech")
    ? "neon"
    : host.includes("supabase.")
      ? "supabase"
      : "postgresql";
  const region = /\.((?:[a-z]{2}-[a-z]+-\d))\./.exec(host)?.[1] ?? null;
  const sslMode = parsed.searchParams.get("sslmode");
  return {
    ...base,
    configured: true,
    provider,
    region,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null,
    role: parsed.username ? decodeURIComponent(parsed.username) : null,
    pooled: provider === "neon" ? host.includes("-pooler") : host.includes("pooler") ? true : null,
    sslMode,
    sslEnforced: !!dbSslConfig || sslMode === "require" || sslMode === "verify-full" || sslMode === "verify-ca",
  };
}

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
]);
const HOSTNAME_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA"]);

export type FailureStage = "dns" | "tls" | "certificate" | "hostname" | "connection" | "auth" | "database" | "query" | "timeout";

/** Maps a low-level error to the diagnostic stage that failed. Pure; exported for tests. */
export function classifyError(err: unknown): FailureStage {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const msg = (e?.message ?? "").toLowerCase();
  if (DNS_CODES.has(code)) return "dns";
  if (HOSTNAME_CODES.has(code) || msg.includes("does not match certificate") || msg.includes("altnames")) return "hostname";
  if (CERT_CODES.has(code) || msg.includes("self-signed") || msg.includes("unable to verify") || msg.includes("certificate has expired")) return "certificate";
  if (code === "28P01" || code === "28000" || msg.includes("password authentication failed")) return "auth";
  if (code === "3D000") return "database";
  if (TIMEOUT_CODES.has(code) || msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (code === "EPROTO" || code.startsWith("ERR_SSL") || msg.includes("ssl") || msg.includes("tls")) return "tls";
  return "connection";
}

const TLS_FAILURE_DETAIL =
  "TLS certificate verification failed. The connection was rejected because the server certificate could not be validated.";

function stageMessage(stage: FailureStage, service: string): { status: ConnectionStatus; summary: string } {
  switch (stage) {
    case "dns":
      return { status: "configuration_error", summary: `${service} hostname could not be resolved. Verify the configured endpoint.` };
    case "certificate":
      return { status: "tls_error", summary: `${service} ${TLS_FAILURE_DETAIL} Verify the endpoint and trusted CA configuration.` };
    case "hostname":
      return { status: "tls_error", summary: `${service} certificate does not match the configured hostname. Verify the endpoint.` };
    case "tls":
      return { status: "tls_error", summary: `${service} TLS handshake failed. Verify the port and protocol (HTTPS / sslmode=require).` };
    case "auth":
      return { status: "authentication_failed", summary: `${service} rejected the configured credentials.` };
    case "database":
      return { status: "configuration_error", summary: `${service} database does not exist or is not accessible to the configured user.` };
    case "timeout":
      return { status: "timeout", summary: `${service} did not respond within ${STEP_TIMEOUT_MS / 1000}s.` };
    case "query":
      return { status: "unavailable", summary: `${service} test query failed.` };
    default:
      return { status: "unavailable", summary: `${service} connection failed.` };
  }
}

/** Builds the step list: steps before the failing stage pass, the failing one fails, the rest are skipped. */
function buildSteps(order: Array<[string, string]>, failedAt: string | null, detail?: string, overrides: Record<string, Partial<DiagnosticStep>> = {}): DiagnosticStep[] {
  let reached = false;
  return order.map(([id, label]) => {
    if (reached) return { id, label, status: "skipped" as const, ...overrides[id] };
    if (id === failedAt) {
      reached = true;
      return { id, label, status: "failed" as const, detail, ...overrides[id] };
    }
    return { id, label, status: "ok" as const, ...overrides[id] };
  });
}

function withTimeout<T>(p: Promise<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "TIMEOUT" })), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

const PG_STEPS: Array<[string, string]> = [
  ["config", "Configuration detected"],
  ["dns", "DNS resolution"],
  ["tls", "TLS connection"],
  ["certificate", "Certificate verification"],
  ["hostname", "Hostname verification"],
  ["auth", "Authentication"],
  ["database", "Database access"],
  ["query", "Test query"],
];

const STAGE_TO_STEP: Record<FailureStage, string> = {
  dns: "dns",
  tls: "tls",
  certificate: "certificate",
  hostname: "hostname",
  connection: "tls",
  timeout: "tls",
  auth: "auth",
  database: "database",
  query: "query",
};

export async function testPostgres(): Promise<DiagnosticResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const done = (status: ConnectionStatus, summary: string, steps: DiagnosticStep[], ok = false): DiagnosticResult => ({
    status,
    summary,
    steps,
    latencyMs: ok ? Date.now() - started : null,
    checkedAt,
  });

  let host: string;
  try {
    host = new URL(config.DATABASE_URL).hostname;
  } catch {
    return done("configuration_error", "DATABASE_URL is not a valid connection URL.", buildSteps(PG_STEPS, "config", "DATABASE_URL could not be parsed."));
  }

  try {
    await withTimeout(lookup(host));
  } catch (err) {
    const stage = classifyError(err) === "timeout" ? "timeout" : "dns";
    const m = stageMessage(stage, "PostgreSQL");
    return done(m.status, m.summary, buildSteps(PG_STEPS, "dns", m.summary));
  }

  const tlsSkipped = !dbSslConfig
    ? { detail: "SSL not enforced by the server (NODE_ENV is not production); sslmode in DATABASE_URL applies." }
    : undefined;
  const verifySkipped = dbSslConfig && dbSslConfig.rejectUnauthorized === false
    ? { status: "warning" as const, detail: "Verification disabled by DB_SSL_REJECT_UNAUTHORIZED=false. Configure DB_SSL_CA and re-enable it." }
    : undefined;

  const client = new pg.Client({ connectionString: config.DATABASE_URL, ssl: dbSslConfig, connectionTimeoutMillis: STEP_TIMEOUT_MS });
  client.on("error", () => undefined);
  try {
    await withTimeout(client.connect());
  } catch (err) {
    const stage = classifyError(err);
    const m = stageMessage(stage, "PostgreSQL");
    await client.end().catch(() => undefined);
    return done(m.status, m.summary, buildSteps(PG_STEPS, STAGE_TO_STEP[stage], m.summary));
  }

  try {
    await withTimeout(client.query("SELECT 1"));
    let sslInUse: boolean | null = null;
    try {
      const { rows } = await withTimeout(client.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"));
      sslInUse = rows[0]?.ssl ?? null;
    } catch {
      sslInUse = null;
    }
    const overrides: Record<string, Partial<DiagnosticStep>> = {};
    if (sslInUse === false) {
      overrides.tls = { status: "warning", detail: "Connection is not encrypted." };
      overrides.certificate = { status: "skipped", detail: "No TLS session." };
      overrides.hostname = { status: "skipped", detail: "No TLS session." };
    } else if (tlsSkipped) {
      overrides.certificate = { status: "skipped", ...tlsSkipped };
      overrides.hostname = { status: "skipped", ...tlsSkipped };
    } else if (verifySkipped) {
      overrides.certificate = verifySkipped;
      overrides.hostname = verifySkipped;
    }
    const degraded = sslInUse === false || !!verifySkipped;
    return done(
      "connected",
      degraded ? "Connected, but transport security needs attention." : "Connection healthy.",
      buildSteps(PG_STEPS, null, undefined, overrides),
      true,
    );
  } catch (err) {
    const stage = classifyError(err) === "timeout" ? "timeout" : "query";
    const m = stageMessage(stage, "PostgreSQL");
    return done(m.status, m.summary, buildSteps(PG_STEPS, "query", m.summary));
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ─── ClickHouse ───────────────────────────────────────────────────────────────

const CH_STEPS: Array<[string, string]> = [
  ["config", "Configuration detected"],
  ["dns", "DNS resolution"],
  ["tls", "TLS connection"],
  ["certificate", "Certificate verification"],
  ["hostname", "Hostname verification"],
  ["https", "HTTPS connection"],
  ["auth", "Authentication"],
  ["database", "Database access"],
  ["query", "Test query"],
];

export function isClickHouseConfigured(): boolean {
  return !!(config.CLICKHOUSE_HOST && config.CLICKHOUSE_PASSWORD && config.CLICKHOUSE_DATABASE);
}

export function describeClickHouse() {
  return {
    configured: isClickHouseConfigured(),
    provider: config.CLICKHOUSE_HOST?.endsWith(".clickhouse.cloud") ? "clickhouse_cloud" : config.CLICKHOUSE_HOST ? "clickhouse" : "unknown",
    region: config.CLICKHOUSE_HOST ? /\.([a-z]{2}-[a-z]+-\d)\./.exec(config.CLICKHOUSE_HOST)?.[1] ?? null : null,
    protocol: "https" as const,
    port: config.CLICKHOUSE_PORT,
    user: config.CLICKHOUSE_USER,
    database: config.CLICKHOUSE_DATABASE ?? null,
    tls: true,
    certificateVerification: true,
    customCa: !!config.CLICKHOUSE_CA_CERT,
  };
}

function tlsProbe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized is left at Node's default (true). Never override it.
    const socket = tls.connect({ host, port, servername: host, ca: config.CLICKHOUSE_CA_CERT || undefined, timeout: STEP_TIMEOUT_MS });
    socket.once("secureConnect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "TIMEOUT" }));
    });
    socket.once("error", reject);
  });
}

interface ChResponse {
  status: number;
  body: string;
}

export function chRequest(sql: string, database?: string): Promise<ChResponse> {
  const host = config.CLICKHOUSE_HOST!;
  const auth = Buffer.from(`${config.CLICKHOUSE_USER}:${config.CLICKHOUSE_PASSWORD ?? ""}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port: config.CLICKHOUSE_PORT,
        method: "POST",
        path: "/",
        servername: host,
        ca: config.CLICKHOUSE_CA_CERT || undefined,
        timeout: STEP_TIMEOUT_MS,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "text/plain",
          ...(database ? { "X-ClickHouse-Database": database } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 4096) body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "TIMEOUT" })));
    req.once("error", reject);
    req.end(sql);
  });
}

/** Classifies a ClickHouse HTTP error body without echoing it (it may include the user name). */
export function classifyClickHouseResponse(res: ChResponse): "ok" | "auth" | "database" | "query" {
  if (res.status >= 200 && res.status < 300) return "ok";
  const b = res.body;
  if (res.status === 401 || res.status === 403 || /Code:\s*(516|192|193|194)\b|AUTHENTICATION_FAILED|REQUIRED_PASSWORD/i.test(b)) return "auth";
  if (/Code:\s*81\b|UNKNOWN_DATABASE/i.test(b)) return "database";
  return "query";
}

export async function testClickHouse(mode: "connection" | "query" = "connection"): Promise<DiagnosticResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const done = (status: ConnectionStatus, summary: string, steps: DiagnosticStep[], ok = false): DiagnosticResult => ({
    status,
    summary,
    steps,
    latencyMs: ok ? Date.now() - started : null,
    checkedAt,
  });

  if (!isClickHouseConfigured()) {
    const missing = describeConfiguration().clickhouse.filter((e) => e.required && e.state === "NOT_SET").map((e) => e.name);
    return done(
      "not_configured",
      "ClickHouse is not configured. Analytics are unavailable; the core application is unaffected.",
      buildSteps(CH_STEPS, "config", `Missing: ${missing.join(", ")}`),
    );
  }
  const host = config.CLICKHOUSE_HOST!;

  try {
    await withTimeout(lookup(host));
  } catch (err) {
    const stage = classifyError(err) === "timeout" ? "timeout" : "dns";
    const m = stageMessage(stage, "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, "dns", m.summary));
  }

  try {
    await withTimeout(tlsProbe(host, config.CLICKHOUSE_PORT));
  } catch (err) {
    const stage = classifyError(err);
    const step = stage === "certificate" || stage === "hostname" ? stage : "tls";
    const m = stageMessage(stage, "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, step, m.summary));
  }

  let res: ChResponse;
  try {
    // Authenticate without selecting a database so auth and database access are reported separately.
    res = await withTimeout(chRequest("SELECT 1"));
  } catch (err) {
    const m = stageMessage(classifyError(err) === "timeout" ? "timeout" : "connection", "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, "https", m.summary));
  }
  const authResult = classifyClickHouseResponse(res);
  if (authResult !== "ok") {
    const stage = authResult === "auth" ? "auth" : "https";
    const m = stageMessage(authResult === "auth" ? "auth" : "connection", "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, stage, m.summary));
  }

  const sql = mode === "query" ? "SELECT count() FROM system.tables WHERE database = currentDatabase()" : "SELECT 1";
  try {
    res = await withTimeout(chRequest(sql, config.CLICKHOUSE_DATABASE));
  } catch (err) {
    const m = stageMessage(classifyError(err) === "timeout" ? "timeout" : "query", "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, "database", m.summary));
  }
  const dbResult = classifyClickHouseResponse(res);
  if (dbResult !== "ok") {
    const stage = dbResult === "database" ? "database" : dbResult === "auth" ? "database" : "query";
    const m = stageMessage(dbResult === "query" ? "query" : "database", "ClickHouse");
    return done(m.status, m.summary, buildSteps(CH_STEPS, stage, m.summary));
  }
  const overrides: Record<string, Partial<DiagnosticStep>> =
    mode === "query" ? { query: { detail: `Tables in configured database: ${Number.parseInt(res.body.trim(), 10) || 0}` } } : {};
  return done("connected", "Connection healthy.", buildSteps(CH_STEPS, null, undefined, overrides), true);
}

// ─── Migrations ───────────────────────────────────────────────────────────────

export interface MigrationStatus {
  available: boolean;
  reason?: string;
  latestOnDisk: string | null;
  currentVersion: string | null;
  applied: number;
  pending: string[];
  checksumMismatches: string[];
  unknownApplied: string[];
  status: "up_to_date" | "pending" | "failed" | "unavailable";
  lastAppliedAt: string | null;
}

/** Read-only comparison of schema_migrations with the migration files. Never runs migrations. */
export async function getMigrationStatus(dir: string = defaultMigrationsDir()): Promise<MigrationStatus> {
  const empty: MigrationStatus = {
    available: false,
    latestOnDisk: null,
    currentVersion: null,
    applied: 0,
    pending: [],
    checksumMismatches: [],
    unknownApplied: [],
    status: "unavailable",
    lastAppliedAt: null,
  };
  let files;
  try {
    files = discoverMigrations(dir);
  } catch {
    return { ...empty, reason: "Migration files are not readable by the server." };
  }
  let rows: Array<{ version: string; checksum: string | null; applied_at: Date }>;
  try {
    const exists = await query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
    if (!exists.rows[0]?.t) {
      return { ...empty, available: true, latestOnDisk: files.at(-1)?.version ?? null, pending: files.map((f) => f.version), status: "pending", reason: "schema_migrations table does not exist yet." };
    }
    rows = (await query<{ version: string; checksum: string | null; applied_at: Date }>(
      "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
    )).rows;
  } catch {
    return { ...empty, reason: "PostgreSQL is unreachable; migration state could not be read." };
  }
  const applied = new Map(rows.map((r) => [r.version, r]));
  const fileVersions = new Set(files.map((f) => f.version));
  const pending = files.filter((f) => !applied.has(f.version)).map((f) => f.version);
  const checksumMismatches = files
    .filter((f) => {
      const row = applied.get(f.version);
      return row?.checksum && row.checksum !== checksumOf(readFileSync(join(dir, f.file), "utf-8"));
    })
    .map((f) => f.version);
  const unknownApplied = rows.filter((r) => !fileVersions.has(r.version)).map((r) => r.version);
  const last = rows.reduce<Date | null>((acc, r) => (!acc || r.applied_at > acc ? r.applied_at : acc), null);
  return {
    available: true,
    latestOnDisk: files.at(-1)?.version ?? null,
    currentVersion: rows.at(-1)?.version ?? null,
    applied: rows.length,
    pending,
    checksumMismatches,
    unknownApplied,
    status: checksumMismatches.length ? "failed" : pending.length ? "pending" : "up_to_date",
    lastAppliedAt: last ? last.toISOString() : null,
  };
}
