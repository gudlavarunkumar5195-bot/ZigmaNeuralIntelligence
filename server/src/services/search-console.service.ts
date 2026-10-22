import { randomUUID } from "node:crypto";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { config } from "../config.js";
import { encodeCursor, decodeCursor } from "../http/pagination.js";
import { GscApiError, propertyCoversWebsite, propertyType, READABLE_PERMISSIONS, type GscClient, type SearchAnalyticsRow } from "../integrations/google/search-console.js";
import { clientFor, IntegrationError } from "./integrations.service.js";
import { audit } from "./audit.service.js";

/**
 * Search Console property links, durable sync jobs and ingestion.
 *
 * A job covers a PT date range and is split into units (dimension set x day),
 * each fetched with a single-day Search Analytics query (Google's recommended
 * pattern), paged by 25,000 rows up to the documented 50,000 rows per day.
 * Units are checkpoints: a worker that dies loses at most the unit in flight;
 * the lease expires and any worker resumes the remaining units.
 *
 * Ingestion of a unit is one transaction, only after its fetch completed:
 * the day's rows for that set are replaced. A complete response with zero
 * rows where we already hold data keeps the previous data (outcome
 * kept_previous) instead of wiping it. Failed or partial fetches write
 * nothing. Re-running a unit produces the same rows (idempotent).
 */

export const DIMENSION_SETS = ["total", "query", "page", "country", "device", "searchAppearance"] as const;
export type DimensionSet = (typeof DIMENSION_SETS)[number];
export const PAGE_SIZE = 25_000;
export const MAX_ROWS_PER_DAY = 50_000;
/** Search Console keeps about 16 months of data. */
export const MAX_HISTORY_DAYS = 480;
const LEASE_MS = 2 * 60_000;
const MAX_UNIT_ATTEMPTS = 3;
const MAX_CLAIMS = 40;
const MAX_QUOTA_PAUSES = 12;

// ─── PT calendar helpers (Search Console dates are America/Los_Angeles) ──────

export function todayPT(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** The earliest and latest days a sync may request. */
export function allowedRange(now = new Date()): { min: string; max: string } {
  const today = todayPT(now);
  return { min: addDays(today, -MAX_HISTORY_DAYS), max: addDays(today, -1) };
}

// ─── Property links ──────────────────────────────────────────────────────────

export interface PropertyRow {
  id: string;
  org_id: string;
  website_id: string;
  integration_id: string;
  site_url: string;
  property_type: "domain" | "url_prefix";
  permission_level: string;
  status: "active" | "access_lost";
  status_reason: string | null;
  sync_enabled: boolean;
  next_sync_at: string | null;
  last_sync_success_at: string | null;
  last_synced_through: string | null;
  first_incomplete_date: string | null;
}

export async function getProperty(orgId: string, websiteId: string): Promise<PropertyRow | null> {
  const { rows } = await query<PropertyRow>(
    `SELECT id, org_id, website_id, integration_id, site_url, property_type, permission_level, status, status_reason, sync_enabled,
            next_sync_at, last_sync_success_at, to_char(last_synced_through, 'YYYY-MM-DD') AS last_synced_through,
            to_char(first_incomplete_date, 'YYYY-MM-DD') AS first_incomplete_date
       FROM gsc_properties WHERE org_id = $1 AND website_id = $2`,
    [orgId, websiteId],
  );
  return rows[0] ?? null;
}

/** Link status for the UI: property, Google account, freshness, active and recent jobs. */
export async function getLinkStatus(orgId: string, websiteId: string) {
  const property = await getProperty(orgId, websiteId);
  if (!property) return null;
  const [{ rows: integration }, { rows: jobs }, { rows: fresh }] = await Promise.all([
    query("SELECT id, account_email, status, status_reason FROM integrations WHERE id = $1 AND org_id = $2", [property.integration_id, orgId]),
    query(
      `SELECT id, kind, status, to_char(date_from,'YYYY-MM-DD') AS date_from, to_char(date_to,'YYYY-MM-DD') AS date_to, units_total, units_done, units_failed,
              rows_written, error_code, error, created_at, started_at, finished_at, cancel_requested, run_after, quota_pauses
         FROM gsc_sync_jobs WHERE org_id = $1 AND property_id = $2 ORDER BY created_at DESC, id DESC LIMIT 5`,
      [orgId, property.id],
    ),
    query<{ latest_final: string | null; latest_any: string | null }>(
      `SELECT to_char(MAX(day) FILTER (WHERE data_state = 'final'), 'YYYY-MM-DD') AS latest_final, to_char(MAX(day), 'YYYY-MM-DD') AS latest_any
         FROM gsc_coverage WHERE org_id = $1 AND property_id = $2 AND dimension_set = 'total'`,
      [orgId, property.id],
    ),
  ]);
  return {
    property,
    integration: integration[0] ?? null,
    activeJob: jobs.find((j) => j.status === "queued" || j.status === "running") ?? null,
    recentJobs: jobs,
    freshness: { latestFinalDay: fresh[0]?.latest_final ?? null, latestDay: fresh[0]?.latest_any ?? null, firstIncompleteDate: property.first_incomplete_date },
  };
}

/**
 * Link a Search Console property to a ZigmaNeural website. Requires: the
 * website is verified in ZigmaNeural (our own ownership check), the Google
 * integration is active, the property covers the website's URL, and the
 * Google account currently has a data-reading permission on it (checked live).
 */
export async function linkProperty(input: { orgId: string; websiteId: string; integrationId: string; siteUrl: string; actorId: string }, client?: GscClient) {
  const { rows: sites } = await query<{ id: string; url: string; verified: boolean }>("SELECT id, url, verified FROM websites WHERE id = $1 AND org_id = $2", [input.websiteId, input.orgId]);
  const website = sites[0];
  if (!website) return null;
  if (!website.verified) throw new IntegrationError(422, "WEBSITE_NOT_VERIFIED", "Verify ownership of this website in ZigmaNeural before linking Search Console");
  const { rows: ints } = await query<{ status: string }>("SELECT status FROM integrations WHERE id = $1 AND org_id = $2", [input.integrationId, input.orgId]);
  if (!ints[0]) throw new IntegrationError(404, "INTEGRATION_NOT_FOUND", "Google connection not found");
  if (ints[0].status !== "active") throw new IntegrationError(409, "INTEGRATION_REAUTH_REQUIRED", "Reconnect this Google account first");
  const type = propertyType(input.siteUrl);
  if (!type) throw new IntegrationError(400, "INVALID_PROPERTY", "Not a Search Console property URL (expected sc-domain:example.com or https://example.com/)");
  if (!propertyCoversWebsite(input.siteUrl, website.url)) {
    throw new IntegrationError(422, "PROPERTY_MISMATCH", "This Search Console property does not cover the website's URL");
  }
  const live = (await (client ?? clientFor(input.orgId, input.integrationId)).listSites()).find((s) => s.siteUrl === input.siteUrl);
  if (!live || !READABLE_PERMISSIONS.has(live.permissionLevel)) {
    throw new IntegrationError(403, "PROPERTY_ACCESS_DENIED", "The connected Google account does not have access to this property's data");
  }
  const propertyId = await withTransaction(async (tx) => {
    const { rows: existing } = await tx.query<{ id: string; site_url: string; integration_id: string }>(
      "SELECT id, site_url, integration_id FROM gsc_properties WHERE website_id = $1 AND org_id = $2 FOR UPDATE",
      [input.websiteId, input.orgId],
    );
    // Another property for this website: its data belongs to that property, so it goes.
    if (existing[0] && (existing[0].site_url !== input.siteUrl || existing[0].integration_id !== input.integrationId)) {
      await tx.query("DELETE FROM gsc_properties WHERE id = $1 AND org_id = $2", [existing[0].id, input.orgId]);
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level, linked_by, next_sync_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' minutes')::interval)
       ON CONFLICT (website_id) DO UPDATE SET permission_level = EXCLUDED.permission_level, status = 'active', status_reason = NULL, updated_at = NOW()
       RETURNING id`,
      [input.orgId, input.websiteId, input.integrationId, input.siteUrl, type, live.permissionLevel, input.actorId, config.GSC_SYNC_INTERVAL_MINUTES ?? 1_440],
    );
    return rows[0].id;
  });
  await audit({ userId: input.actorId, orgId: input.orgId, action: "gsc_property_linked", resourceType: "website", resourceId: input.websiteId, result: "success", metadata: { propertyType: type } });
  // Initial historical sync.
  const job = await requestSync({ orgId: input.orgId, websiteId: input.websiteId, actorId: input.actorId, kind: "initial" });
  return { propertyId, permissionLevel: live.permissionLevel, propertyType: type, job };
}

export async function unlinkProperty(orgId: string, websiteId: string, actorId: string) {
  const { rowCount } = await query("DELETE FROM gsc_properties WHERE website_id = $1 AND org_id = $2", [websiteId, orgId]);
  if (rowCount) await audit({ userId: actorId, orgId, action: "gsc_property_unlinked", resourceType: "website", resourceId: websiteId, result: "success" });
  return (rowCount ?? 0) > 0;
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface JobRow {
  id: string;
  org_id: string;
  property_id: string;
  kind: "initial" | "incremental" | "manual";
  status: string;
  date_from: string;
  date_to: string;
  claims: number;
  quota_pauses: number;
  cancel_requested: boolean;
}

/**
 * Queue a sync for a website's property. At most one queued/running job per
 * property (partial unique index): a duplicate request returns the active job.
 * Ranges: initial = the configured lookback; incremental/manual default =
 * from (last synced day - revisit window) to yesterday (PT); explicit ranges
 * must lie within Search Console's ~16 months.
 */
export async function requestSync(input: { orgId: string; websiteId: string; actorId: string | null; kind: JobRow["kind"]; from?: string; to?: string }, now = new Date()) {
  const property = await getProperty(input.orgId, input.websiteId);
  if (!property) throw new IntegrationError(404, "SEARCH_CONSOLE_NOT_LINKED", "Link a Search Console property to this website first");
  if (property.status !== "active") throw new IntegrationError(409, "PROPERTY_ACCESS_LOST", "The Google account lost access to this property; relink it");
  const { rows: ints } = await query<{ status: string }>("SELECT status FROM integrations WHERE id = $1 AND org_id = $2", [property.integration_id, input.orgId]);
  if (ints[0]?.status !== "active") throw new IntegrationError(409, "INTEGRATION_REAUTH_REQUIRED", "Reconnect the Google account to sync");

  const { min, max } = allowedRange(now);
  let from: string;
  let to: string;
  if (input.from || input.to) {
    if (!isDay(input.from) || !isDay(input.to)) throw new IntegrationError(400, "INVALID_DATE_RANGE", "from and to must be YYYY-MM-DD");
    if (input.from > input.to) throw new IntegrationError(400, "INVALID_DATE_RANGE", "from must be on or before to");
    if (input.from < min || input.to > max) throw new IntegrationError(400, "DATE_RANGE_UNAVAILABLE", `Search Console data can be requested from ${min} to ${max}`);
    from = input.from;
    to = input.to;
  } else if (input.kind === "initial" || !property.last_synced_through) {
    from = addDays(max, -((config.GSC_INITIAL_LOOKBACK_DAYS ?? 90) - 1));
    to = max;
  } else {
    // Revisit recent days: Google keeps updating them for a few days.
    from = addDays(property.last_synced_through, -(config.GSC_REVISIT_DAYS ?? 5));
    to = max;
  }
  if (from < min) from = min;

  const jobId = randomUUID();
  try {
    await withTransaction(async (tx) => {
      const days = daysBetween(from, to) + 1;
      await tx.query(
        `INSERT INTO gsc_sync_jobs (id, org_id, property_id, kind, date_from, date_to, units_total, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [jobId, input.orgId, property.id, input.kind, from, to, days * DIMENSION_SETS.length, input.actorId],
      );
      await tx.query(
        `INSERT INTO gsc_sync_units (job_id, org_id, dimension_set, day)
         SELECT $1, $2, s, d::date FROM unnest($3::text[]) AS s, generate_series($4::date, $5::date, interval '1 day') AS d`,
        [jobId, input.orgId, [...DIMENSION_SETS], from, to],
      );
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const { rows } = await query("SELECT id, kind, status, date_from, date_to FROM gsc_sync_jobs WHERE property_id = $1 AND org_id = $2 AND status IN ('queued','running')", [property.id, input.orgId]);
    return { job: rows[0], deduplicated: true as const };
  }
  return { job: { id: jobId, kind: input.kind, status: "queued", date_from: from, date_to: to }, deduplicated: false as const };
}

export async function cancelSync(orgId: string, websiteId: string, jobId: string) {
  const property = await getProperty(orgId, websiteId);
  if (!property) return null;
  const { rows } = await query<{ id: string; status: string }>(
    `UPDATE gsc_sync_jobs SET cancel_requested = TRUE,
            status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            finished_at = CASE WHEN status = 'queued' THEN NOW() ELSE finished_at END
      WHERE id = $1 AND org_id = $2 AND property_id = $3 AND status IN ('queued','running')
      RETURNING id, status`,
    [jobId, orgId, property.id],
  );
  if (rows[0]) return rows[0];
  const { rows: other } = await query<{ id: string; status: string }>("SELECT id, status FROM gsc_sync_jobs WHERE id = $1 AND org_id = $2 AND property_id = $3", [jobId, orgId, property.id]);
  if (!other[0]) return null;
  throw new IntegrationError(409, "SYNC_NOT_ACTIVE", `This sync is already ${other[0].status}`);
}

export async function listSyncJobs(orgId: string, websiteId: string, page: { limit: number; cursor?: string }) {
  const property = await getProperty(orgId, websiteId);
  if (!property) return null;
  const params: unknown[] = [orgId, property.id];
  let where = "org_id = $1 AND property_id = $2";
  if (page.cursor) {
    const c = decodeCursor<{ t: string; i: string }>(page.cursor, (v) => typeof v.t === "string" && !Number.isNaN(Date.parse(v.t)) && /^[0-9a-f-]{36}$/i.test(String(v.i)));
    params.push(c.t, c.i);
    where += " AND (created_at, id) < ($3::timestamptz, $4::uuid)";
  }
  params.push(page.limit + 1);
  const { rows } = await query<{ id: string; created_at: Date }>(
    `SELECT id, kind, status, to_char(date_from,'YYYY-MM-DD') AS date_from, to_char(date_to,'YYYY-MM-DD') AS date_to, units_total, units_done, units_failed,
            rows_written, quota_pauses, error_code, error, cancel_requested, created_at, started_at, finished_at, run_after
       FROM gsc_sync_jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > page.limit;
  const data = more ? rows.slice(0, page.limit) : rows;
  const last = data[data.length - 1];
  return { jobs: data, nextCursor: more && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id }) : null };
}

/** Failed units of a job (what could not be fetched and why). */
export async function listJobFailures(orgId: string, jobId: string) {
  const { rows } = await query(
    `SELECT dimension_set, to_char(day,'YYYY-MM-DD') AS day, attempts, error_code FROM gsc_sync_units
      WHERE org_id = $1 AND job_id = $2 AND status = 'failed' ORDER BY day DESC, dimension_set LIMIT 100`,
    [orgId, jobId],
  );
  return rows;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export async function claimSyncJob(ownerId = randomUUID()): Promise<(JobRow & { owner: string }) | null> {
  const { rows } = await query<JobRow>(
    `UPDATE gsc_sync_jobs SET status = 'running', lease_owner = $1, lease_until = NOW() + ($2 || ' milliseconds')::interval,
            claims = claims + 1, started_at = COALESCE(started_at, NOW())
      WHERE id = (
        SELECT id FROM gsc_sync_jobs
         WHERE (status = 'queued' AND run_after <= NOW()) OR (status = 'running' AND lease_until < NOW())
         ORDER BY run_after, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, property_id, kind, status, to_char(date_from,'YYYY-MM-DD') AS date_from, to_char(date_to,'YYYY-MM-DD') AS date_to,
                claims, quota_pauses, cancel_requested`,
    [ownerId, LEASE_MS],
  );
  return rows[0] ? { ...rows[0], owner: ownerId } : null;
}

/** Lease-guarded update: does nothing if another worker took the job over. */
async function updateOwnedJob(db: Queryable, job: { id: string; owner: string }, set: string, params: unknown[] = []) {
  const { rows } = await db.query(`UPDATE gsc_sync_jobs SET ${set} WHERE id = $1 AND lease_owner = $2 RETURNING id`, [job.id, job.owner, ...params]);
  return rows.length > 0;
}

async function finishJob(job: JobRow & { owner: string }, status: "completed" | "partial" | "failed" | "cancelled", errorCode: string | null = null, error: string | null = null) {
  await withTransaction(async (tx) => {
    const owned = await updateOwnedJob(tx, job, "status = $3, finished_at = NOW(), lease_owner = NULL, lease_until = NULL, error_code = $4, error = $5", [status, errorCode, error?.slice(0, 1000) ?? null]);
    if (!owned) return;
    if (status === "completed") {
      await tx.query(
        `UPDATE gsc_properties SET last_sync_success_at = NOW(),
                last_synced_through = GREATEST(COALESCE(last_synced_through, $3::date), $3::date), updated_at = NOW()
          WHERE id = $1 AND org_id = $2`,
        [job.property_id, job.org_id, job.date_to],
      );
    }
    await tx.query(
      "UPDATE gsc_properties SET next_sync_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW() WHERE id = $1 AND org_id = $2",
      [job.property_id, job.org_id, config.GSC_SYNC_INTERVAL_MINUTES ?? 1_440],
    );
  });
  console.log(JSON.stringify({ event: "gsc_sync_finished", jobId: job.id, orgId: job.org_id, status, errorCode }));
}

const SET_DIMENSION: Record<DimensionSet, string | null> = { total: null, query: "query", page: "page", country: "country", device: "device", searchAppearance: "searchAppearance" };

/** Fetch every row Google returns for one (set, day), paging by 25,000 up to 50,000. */
export async function fetchUnit(client: GscClient, siteUrl: string, set: DimensionSet, day: string) {
  const dimension = SET_DIMENSION[set];
  const rows: SearchAnalyticsRow[] = [];
  let firstIncompleteDate: string | null = null;
  let truncated = false;
  for (let startRow = 0; ; startRow += PAGE_SIZE) {
    const res = await client.searchAnalytics(siteUrl, {
      startDate: day, endDate: day, dimensions: dimension ? ["date", dimension] : ["date"], type: "web", dataState: "all", rowLimit: PAGE_SIZE, startRow,
    });
    firstIncompleteDate = res.firstIncompleteDate ?? firstIncompleteDate;
    rows.push(...res.rows);
    if (res.rows.length < PAGE_SIZE) break;
    if (rows.length >= MAX_ROWS_PER_DAY) {
      truncated = true;
      break;
    }
  }
  return { rows, firstIncompleteDate, truncated };
}

/** Replace one (property, set, day) in a single transaction; never wipe data with an empty answer. */
async function ingestUnit(job: JobRow & { owner: string }, set: DimensionSet, day: string, fetched: Awaited<ReturnType<typeof fetchUnit>>) {
  const dataState = fetched.firstIncompleteDate && day >= fetched.firstIncompleteDate ? "fresh" : "final";
  const values = fetched.rows.map((r) => ({
    v: SET_DIMENSION[set] ? String(r.keys[1] ?? "").slice(0, 4096) : "",
    c: Math.max(0, Math.round(r.clicks)), i: Math.max(0, Math.round(r.impressions)), r: Math.max(0, r.ctr), p: Math.max(0, r.position),
  }));
  return withTransaction(async (tx) => {
    if (!(await updateOwnedJob(tx, job, "lease_until = NOW() + ($3 || ' milliseconds')::interval", [LEASE_MS]))) return null;
    const { rows: prev } = await tx.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM gsc_search_daily WHERE property_id = $1 AND dimension_set = $2 AND day = $3",
      [job.property_id, set, day],
    );
    const keepPrevious = values.length === 0 && Number(prev[0].n) > 0;
    const outcome = keepPrevious ? "kept_previous" : fetched.truncated ? "truncated" : "complete";
    if (!keepPrevious) {
      await tx.query("DELETE FROM gsc_search_daily WHERE property_id = $1 AND dimension_set = $2 AND day = $3", [job.property_id, set, day]);
      if (values.length > 0) {
        await tx.query(
          `INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state)
           SELECT $1, $2, $3, $4, x.v, x.c, x.i, x.r, x.p, $5 FROM jsonb_to_recordset($6::jsonb) AS x(v text, c bigint, i bigint, r float8, p float8)
           ON CONFLICT (property_id, dimension_set, day, dim_value) DO UPDATE SET
             clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position,
             data_state = EXCLUDED.data_state, fetched_at = NOW()`,
          [job.property_id, job.org_id, set, day, dataState, JSON.stringify(values)],
        );
      }
    }
    await tx.query(
      `INSERT INTO gsc_coverage (property_id, org_id, dimension_set, day, outcome, row_count, data_state, job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (property_id, dimension_set, day) DO UPDATE SET outcome = EXCLUDED.outcome, row_count = EXCLUDED.row_count,
         data_state = EXCLUDED.data_state, job_id = EXCLUDED.job_id, fetched_at = NOW()`,
      [job.property_id, job.org_id, set, day, outcome, keepPrevious ? Number(prev[0].n) : values.length, dataState, job.id],
    );
    await tx.query(
      "UPDATE gsc_sync_units SET status = 'done', row_count = $4, outcome = $5, attempts = attempts + 1, error_code = NULL, updated_at = NOW() WHERE job_id = $1 AND dimension_set = $2 AND day = $3",
      [job.id, set, day, values.length, outcome],
    );
    await tx.query("UPDATE gsc_sync_jobs SET units_done = units_done + 1, rows_written = rows_written + $2 WHERE id = $1", [job.id, keepPrevious ? 0 : values.length]);
    if (fetched.firstIncompleteDate) {
      await tx.query("UPDATE gsc_properties SET first_incomplete_date = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2", [job.property_id, job.org_id, fetched.firstIncompleteDate]);
    }
    return outcome;
  });
}

async function failUnit(job: JobRow, set: DimensionSet, day: string, code: string, permanent: boolean) {
  const { rows } = await query<{ status: string }>(
    `UPDATE gsc_sync_units SET attempts = attempts + 1, error_code = $4, updated_at = NOW(),
            status = CASE WHEN $5 OR attempts + 1 >= $6 THEN 'failed' ELSE 'pending' END
      WHERE job_id = $1 AND dimension_set = $2 AND day = $3 RETURNING status`,
    [job.id, set, day, code, permanent, MAX_UNIT_ATTEMPTS],
  );
  if (rows[0]?.status === "failed") await query("UPDATE gsc_sync_jobs SET units_failed = units_failed + 1 WHERE id = $1", [job.id]);
}

export interface SliceOptions {
  deadline: number;
  now?: () => number;
  client?: GscClient;
}

/**
 * Work on a claimed job until the time budget runs out, then hand it back
 * (re-queued, checkpoint kept) so the worker loop stays responsive.
 */
export async function runSyncSlice(job: JobRow & { owner: string }, opts: SliceOptions): Promise<"finished" | "yielded" | "paused" | "lost"> {
  const now = opts.now ?? Date.now;
  const { rows: props } = await query<PropertyRow & { integration_status: string }>(
    `SELECT p.id, p.org_id, p.integration_id, p.site_url, p.status, i.status AS integration_status
       FROM gsc_properties p JOIN integrations i ON i.id = p.integration_id AND i.org_id = p.org_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [job.property_id, job.org_id],
  );
  const property = props[0];
  if (!property) return "lost"; // unlinked meanwhile: the job row went with it
  const stop: [boolean, Parameters<typeof finishJob>[1], string | null, string | null][] = [
    [job.cancel_requested, "cancelled", null, null],
    [property.integration_status !== "active", "failed", "INTEGRATION_REAUTH_REQUIRED", "Reconnect the Google account"],
    [property.status !== "active", "failed", "PROPERTY_ACCESS_LOST", "The Google account lost access to this property"],
    [job.claims > MAX_CLAIMS, "failed", "TOO_MANY_ATTEMPTS", "The sync was interrupted too many times"],
  ];
  const reason = stop.find(([hit]) => hit);
  if (reason) {
    await finishJob(job, reason[1], reason[2], reason[3]);
    return "finished";
  }
  const client = opts.client ?? clientFor(job.org_id, property.integration_id);

  for (;;) {
    if (now() >= opts.deadline) {
      await updateOwnedJob({ query }, job, "status = 'queued', run_after = NOW(), lease_owner = NULL, lease_until = NULL");
      return "yielded";
    }
    const { rows: flags } = await query<{ cancel_requested: boolean; lease_owner: string | null }>("SELECT cancel_requested, lease_owner FROM gsc_sync_jobs WHERE id = $1", [job.id]);
    if (!flags[0] || flags[0].lease_owner !== job.owner) return "lost";
    if (flags[0].cancel_requested) {
      await finishJob(job, "cancelled");
      return "finished";
    }
    // Newest days first: recent data is what users look at.
    const { rows: units } = await query<{ dimension_set: DimensionSet; day: string }>(
      `SELECT dimension_set, to_char(day,'YYYY-MM-DD') AS day FROM gsc_sync_units
        WHERE job_id = $1 AND status = 'pending' ORDER BY day DESC, array_position($2::text[], dimension_set) LIMIT 1`,
      [job.id, [...DIMENSION_SETS]],
    );
    const unit = units[0];
    if (!unit) break;
    try {
      const fetched = await fetchUnit(client, property.site_url, unit.dimension_set, unit.day);
      if ((await ingestUnit(job, unit.dimension_set, unit.day, fetched)) === null) return "lost";
    } catch (err) {
      if (!(err instanceof GscApiError)) throw err;
      if (err.kind === "quota") {
        if (job.quota_pauses + 1 >= MAX_QUOTA_PAUSES) {
          await finishJob(job, "partial", "QUOTA_EXHAUSTED", "Search Console API quota kept being exceeded; try again later");
          return "finished";
        }
        await updateOwnedJob({ query }, job, "status = 'queued', quota_pauses = quota_pauses + 1, run_after = NOW() + ($3 || ' milliseconds')::interval, lease_owner = NULL, lease_until = NULL", [err.retryAfterMs ?? 15 * 60_000]);
        console.warn(JSON.stringify({ event: "gsc_sync_quota_pause", jobId: job.id, orgId: job.org_id, retryAfterMs: err.retryAfterMs }));
        return "paused";
      }
      if (err.kind === "auth") {
        await finishJob(job, "failed", "INTEGRATION_REAUTH_REQUIRED", "Google access was revoked or expired; reconnect the account");
        return "finished";
      }
      if (err.kind === "permission") {
        await query("UPDATE gsc_properties SET status = 'access_lost', status_reason = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2", [property.id, job.org_id, "The connected Google account can no longer read this property"]);
        await finishJob(job, "failed", "PROPERTY_ACCESS_LOST", "The Google account lost access to this property");
        return "finished";
      }
      await failUnit(job, unit.dimension_set, unit.day, err.kind === "bad_request" ? "BAD_REQUEST" : "TRANSIENT", err.kind === "bad_request");
    }
  }

  const { rows: counts } = await query<{ done: string; failed: string }>(
    "SELECT COUNT(*) FILTER (WHERE status = 'done')::text AS done, COUNT(*) FILTER (WHERE status = 'failed')::text AS failed FROM gsc_sync_units WHERE job_id = $1",
    [job.id],
  );
  const done = Number(counts[0].done);
  const failed = Number(counts[0].failed);
  if (failed === 0) await finishJob(job, "completed");
  else if (done > 0) await finishJob(job, "partial", "SOME_DAYS_FAILED", `${failed} day/dimension fetch(es) failed after retries`);
  else await finishJob(job, "failed", "ALL_FETCHES_FAILED", "No data could be fetched");
  return "finished";
}

/** Queue incremental syncs for properties that are due (one per property at most). */
export async function scheduleDueSyncs(limit = 20) {
  const { rows } = await query<{ org_id: string; website_id: string; id: string }>(
    `UPDATE gsc_properties p SET next_sync_at = NOW() + ($2 || ' minutes')::interval
      WHERE p.id IN (
        SELECT p2.id FROM gsc_properties p2 JOIN integrations i ON i.id = p2.integration_id AND i.org_id = p2.org_id
         WHERE p2.sync_enabled AND p2.status = 'active' AND i.status = 'active' AND p2.next_sync_at <= NOW()
         ORDER BY p2.next_sync_at LIMIT $1 FOR UPDATE OF p2 SKIP LOCKED)
      RETURNING p.org_id, p.website_id, p.id`,
    [limit, config.GSC_SYNC_INTERVAL_MINUTES ?? 1_440],
  );
  let queued = 0;
  for (const r of rows) {
    try {
      const res = await requestSync({ orgId: r.org_id, websiteId: r.website_id, actorId: null, kind: "incremental" });
      if (!res.deduplicated) queued++;
    } catch (err) {
      console.warn(JSON.stringify({ event: "gsc_schedule_skipped", propertyId: r.id, code: (err as { code?: string }).code ?? "ERROR" }));
    }
  }
  return queued;
}

let lastRetentionRun = 0;

/** Drop observations older than the retention window (bounded batch, at most hourly). */
export async function pruneRetention(now = Date.now()) {
  if (now - lastRetentionRun < 60 * 60_000) return 0;
  lastRetentionRun = now;
  const { rows } = await query<{ n: string }>(
    `WITH gone AS (
       DELETE FROM gsc_search_daily WHERE ctid IN (
         SELECT ctid FROM gsc_search_daily WHERE day < CURRENT_DATE - ($1 || ' days')::interval LIMIT 10000)
       RETURNING 1)
     SELECT COUNT(*)::text AS n FROM gone`,
    [config.GSC_DATA_RETENTION_DAYS ?? 490],
  );
  await query("DELETE FROM gsc_coverage WHERE day < CURRENT_DATE - ($1 || ' days')::interval", [config.GSC_DATA_RETENTION_DAYS ?? 490]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * One worker tick: schedule due syncs, then work on one job for at most
 * `budgetMs` (default 20 s) before yielding back to the loop.
 */
export async function processSearchConsoleTick(budgetMs = 20_000): Promise<void> {
  const { googleOAuthStatus } = await import("../integrations/google/oauth.js");
  if (!googleOAuthStatus().configured) return;
  await scheduleDueSyncs().catch((err: unknown) => console.error(JSON.stringify({ event: "gsc_schedule_failed", error: (err as Error).message })));
  await pruneRetention().catch(() => 0);
  const job = await claimSyncJob();
  if (!job) return;
  try {
    await runSyncSlice(job, { deadline: Date.now() + budgetMs });
  } catch (err) {
    // Unexpected error: release the job; it resumes from its checkpoint.
    console.error(JSON.stringify({ event: "gsc_sync_slice_error", jobId: job.id, error: (err as Error).message }));
    await updateOwnedJob({ query }, job, "status = 'queued', run_after = NOW() + interval '1 minute', lease_owner = NULL, lease_until = NULL").catch(() => undefined);
  }
}
