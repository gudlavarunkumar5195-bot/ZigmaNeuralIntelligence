import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import {
  compareSnapshots,
  encodingProblem,
  gapCompatibility,
  mapHeaders,
  matchTopics,
  normalizeDomain,
  parseCsv,
  referringDomainGap,
  scoreOpportunity,
  topicTerms,
  validateRows,
  type DatasetMeta,
  type LinkField,
  type SnapshotLink,
} from "../backlinks/core.js";
import { createVerifier, type Verifier } from "../backlinks/verify.js";
import { toCsv } from "./keyword-research.service.js";

/**
 * Backlink intelligence service. Every query is scoped by org_id AND
 * website_id; callers have already checked that the website belongs to the
 * caller's organization. Data comes only from imported datasets and our own
 * live checks.
 */

export class BacklinkError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "BacklinkError";
  }
}

export interface WebsiteRef {
  id: string;
  orgId: string;
  domain: string;
}

const siteDomain = (w: WebsiteRef) => normalizeDomain(w.domain) ?? w.domain.toLowerCase();

// ─── Import ───────────────────────────────────────────────────────────────────

export interface ImportInput {
  csv: string;
  subject: "own" | "competitor";
  competitorDomain?: string;
  filename?: string;
  sourceLabel: string;
  coverage: "complete" | "partial" | "unknown";
  exportedAt?: string;
}

function subjectOf(w: WebsiteRef, input: Pick<ImportInput, "subject" | "competitorDomain">): string {
  if (input.subject === "own") return siteDomain(w);
  const d = input.competitorDomain ? normalizeDomain(input.competitorDomain) : null;
  if (!d) throw new BacklinkError(400, "VALIDATION_ERROR", "A valid competitor domain is required.");
  if (d === siteDomain(w)) throw new BacklinkError(400, "VALIDATION_ERROR", "The competitor domain is your own website.");
  return d;
}

function analyse(w: WebsiteRef, input: Pick<ImportInput, "csv" | "subject" | "competitorDomain">) {
  if (Buffer.byteLength(input.csv, "utf8") > config.BACKLINK_IMPORT_MAX_BYTES) {
    throw new BacklinkError(413, "IMPORT_TOO_LARGE", `The file is larger than ${Math.round(config.BACKLINK_IMPORT_MAX_BYTES / 1_000_000)} MB. Split it into smaller files.`);
  }
  const encoding = encodingProblem(input.csv);
  if (encoding) throw new BacklinkError(422, "ENCODING_INVALID", encoding);
  const subject = subjectOf(w, input);
  const parsed = parseCsv(input.csv, config.BACKLINK_IMPORT_MAX_ROWS);
  if (!parsed.header.length || parsed.header.every((h) => !h)) throw new BacklinkError(422, "CSV_EMPTY", "The file has no header row.");
  const headers = mapHeaders(parsed.header);
  const result = validateRows(parsed.header, parsed.rows, headers.mapping, { maxRows: config.BACKLINK_IMPORT_MAX_ROWS, maxField: 2048, targetDomain: subject });
  return { subject, parsed, headers, result };
}

const mappingByName = (header: string[], mapping: Partial<Record<LinkField, number>>) =>
  Object.fromEntries(Object.entries(mapping).map(([field, idx]) => [field, header[idx!]]));

/** Validates a CSV without storing anything. */
export function previewImport(w: WebsiteRef, input: Pick<ImportInput, "csv" | "subject" | "competitorDomain">) {
  const { subject, parsed, headers, result } = analyse(w, input);
  return {
    subjectDomain: subject,
    delimiter: parsed.delimiter === "\t" ? "tab" : parsed.delimiter,
    columns: mappingByName(parsed.header, headers.mapping),
    unmappedColumns: headers.unmapped,
    missingRequired: headers.missingRequired,
    rowLimitExceeded: parsed.truncated,
    rows: { total: result.rowsTotal, accepted: result.links.length, rejected: result.rejected.length, duplicate: result.duplicates, skipped: result.skipped },
    rejectedSamples: result.rejected.slice(0, 20),
    warnings: result.warnings,
    observed: { from: result.observedFrom, to: result.observedTo },
    sample: result.links.slice(0, 10).map(({ linkKey: _k, ...l }) => l),
  };
}

export interface DatasetRow {
  id: string;
  website_id: string;
  subject_kind: "own" | "competitor";
  subject_domain: string;
  source: string;
  source_label: string;
  coverage: "complete" | "partial" | "unknown";
  exported_at: string | null;
  retrieved_at: Date;
  observed_from: string | null;
  observed_to: string | null;
  filename: string | null;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  rows_duplicate: number;
  rows_skipped: number;
  rejected_samples: Array<{ row: number; reason: string }>;
  column_mapping: Record<string, string>;
  referring_domains: number;
  created_at: Date;
}

const DATASET_COLUMNS = `id, website_id, subject_kind, subject_domain, source, source_label, coverage, to_char(exported_at, 'YYYY-MM-DD') AS exported_at, retrieved_at,
  to_char(observed_from, 'YYYY-MM-DD') AS observed_from, to_char(observed_to, 'YYYY-MM-DD') AS observed_to, filename, rows_total, rows_accepted, rows_rejected,
  rows_duplicate, rows_skipped, rejected_samples, column_mapping, referring_domains, created_at`;

const asOf = (d: Pick<DatasetRow, "exported_at" | "retrieved_at">) => (d.exported_at ? Date.parse(d.exported_at) : d.retrieved_at.getTime());
export const isStale = (d: Pick<DatasetRow, "exported_at" | "retrieved_at">, now = Date.now()) => now - asOf(d) > config.BACKLINK_STALE_DAYS * 86_400_000;
const present = (d: DatasetRow) => ({ ...d, stale: isStale(d) });

/**
 * Stores a validated import as a new snapshot and records changes against
 * the previous snapshot of the same subject. Importing the same file again
 * for the same subject returns the existing snapshot (no duplicates).
 */
export async function createImport(w: WebsiteRef, actorId: string, input: ImportInput) {
  const { subject, parsed, headers, result } = analyse(w, input);
  if (headers.missingRequired.length) throw new BacklinkError(422, "COLUMNS_MISSING", "No source URL column was found. Use a column named for example 'Source URL' or 'Linking page'.", { unmappedColumns: headers.unmapped });
  if (parsed.truncated) throw new BacklinkError(413, "IMPORT_TOO_LARGE", `The file has more than ${config.BACKLINK_IMPORT_MAX_ROWS} rows. Split it into smaller files.`);
  if (!result.links.length) throw new BacklinkError(422, "NO_VALID_ROWS", "No row has a valid source URL.", { rejectedSamples: result.rejected.slice(0, 20) });
  const sha = createHash("sha256").update(input.csv, "utf8").digest("hex");
  const domains = new Set(result.links.map((l) => l.sourceDomain));

  return withTransaction(async (tx) => {
    // One import per subject at a time, so change detection sees a consistent history.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`backlinks:${w.orgId}:${w.id}:${subject}`]);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO backlink_datasets (org_id, website_id, subject_kind, subject_domain, source, source_label, coverage, exported_at, observed_from, observed_to, filename,
         content_sha256, rows_total, rows_accepted, rows_rejected, rows_duplicate, rows_skipped, rejected_samples, column_mapping, referring_domains, created_by)
       VALUES ($1,$2,$3,$4,'csv_import',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT ON CONSTRAINT backlink_datasets_content_unique DO NOTHING RETURNING id`,
      [w.orgId, w.id, input.subject, subject, input.sourceLabel, input.coverage, input.exportedAt ?? null, result.observedFrom, result.observedTo, input.filename ?? null,
        sha, result.rowsTotal, result.links.length, result.rejected.length, result.duplicates, result.skipped, JSON.stringify(result.rejected.slice(0, 50)),
        JSON.stringify(mappingByName(parsed.header, headers.mapping)), domains.size, actorId],
    );
    if (!inserted.rows[0]) {
      const existing = await tx.query<DatasetRow>(`SELECT ${DATASET_COLUMNS} FROM backlink_datasets WHERE org_id = $1 AND website_id = $2 AND subject_domain = $3 AND content_sha256 = $4`, [w.orgId, w.id, subject, sha]);
      return { dataset: present(existing.rows[0]), duplicateImport: true, changes: 0 };
    }
    const datasetId = inserted.rows[0].id;
    for (let i = 0; i < result.links.length; i += 1000) {
      const batch = result.links.slice(i, i + 1000);
      await tx.query(
        `INSERT INTO backlink_links (org_id, dataset_id, link_key, source_url, source_domain, target_url, target_domain, anchor, link_type, first_seen, last_seen, provider_lost, source_row)
         SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::date[], $11::date[], $12::boolean[], $13::int[])`,
        [w.orgId, datasetId, batch.map((l) => l.linkKey), batch.map((l) => l.sourceUrl), batch.map((l) => l.sourceDomain), batch.map((l) => l.targetUrl), batch.map((l) => l.targetDomain),
          batch.map((l) => l.anchor), batch.map((l) => l.linkType), batch.map((l) => l.firstSeen), batch.map((l) => l.lastSeen), batch.map((l) => l.providerLost), batch.map((l) => l.sourceRow)],
      );
    }
    const changes = await detectChanges(tx, w, subject, datasetId);
    const { rows } = await tx.query<DatasetRow>(`SELECT ${DATASET_COLUMNS} FROM backlink_datasets WHERE id = $1 AND org_id = $2`, [datasetId, w.orgId]);
    return { dataset: present(rows[0]), duplicateImport: false, changes, warnings: result.warnings };
  });
}

async function snapshotLinks(db: Queryable, orgId: string, datasetId: string): Promise<SnapshotLink[]> {
  const { rows } = await db.query<{ link_key: string; source_url: string; target_url: string | null; anchor: string | null; link_type: SnapshotLink["linkType"]; provider_lost: boolean | null }>(
    "SELECT link_key, source_url, target_url, anchor, link_type, provider_lost FROM backlink_links WHERE org_id = $1 AND dataset_id = $2",
    [orgId, datasetId],
  );
  return rows.map((r) => ({ linkKey: r.link_key, sourceUrl: r.source_url, targetUrl: r.target_url, anchor: r.anchor, linkType: r.link_type, providerLost: r.provider_lost }));
}

/** Changes between a snapshot and the one before it (by export date, then import time). Idempotent. */
async function detectChanges(db: Queryable, w: WebsiteRef, subject: string, datasetId: string): Promise<number> {
  const { rows } = await db.query<{ id: string; coverage: "complete" | "partial" | "unknown" }>(
    `SELECT id, coverage FROM backlink_datasets WHERE org_id = $1 AND website_id = $2 AND subject_domain = $3
      ORDER BY COALESCE(exported_at, retrieved_at::date) DESC, retrieved_at DESC`,
    [w.orgId, w.id, subject],
  );
  const idx = rows.findIndex((r) => r.id === datasetId);
  const previous = rows[idx + 1];
  if (idx < 0 || !previous) return 0;
  const changes = compareSnapshots(await snapshotLinks(db, w.orgId, previous.id), await snapshotLinks(db, w.orgId, datasetId), rows[idx].coverage);
  let stored = 0;
  for (let i = 0; i < changes.length; i += 500) {
    const batch = changes.slice(i, i + 500);
    const r = await db.query(
      `INSERT INTO backlink_changes (org_id, website_id, subject_domain, change_type, link_key, source_url, target_url, from_dataset_id, to_dataset_id, evidence, details)
       SELECT $1, $2, $3, c.type, c.key, c.src, c.tgt, $4, $5, c.ev, c.det::jsonb
         FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS c(type, key, src, tgt, ev, det)
       ON CONFLICT ON CONSTRAINT backlink_changes_unique DO NOTHING`,
      [w.orgId, w.id, subject, previous.id, datasetId, batch.map((c) => c.type), batch.map((c) => c.linkKey), batch.map((c) => c.sourceUrl), batch.map((c) => c.targetUrl), batch.map((c) => c.evidence), batch.map((c) => JSON.stringify(c.details))],
    );
    stored += r.rowCount ?? 0;
  }
  return stored;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listDatasets(w: WebsiteRef) {
  const { rows } = await query<DatasetRow>(
    `SELECT ${DATASET_COLUMNS} FROM backlink_datasets WHERE org_id = $1 AND website_id = $2 ORDER BY retrieved_at DESC, id LIMIT 200`,
    [w.orgId, w.id],
  );
  return rows.map(present);
}

/** Latest snapshot per subject (by export date, then import time). */
export async function latestDatasets(w: WebsiteRef): Promise<DatasetRow[]> {
  const { rows } = await query<DatasetRow>(
    `SELECT DISTINCT ON (subject_domain) ${DATASET_COLUMNS} FROM backlink_datasets WHERE org_id = $1 AND website_id = $2
      ORDER BY subject_domain, COALESCE(exported_at, retrieved_at::date) DESC, retrieved_at DESC`,
    [w.orgId, w.id],
  );
  return rows;
}

async function resolveDataset(w: WebsiteRef, datasetId?: string, subject?: string): Promise<DatasetRow | null> {
  if (datasetId) {
    const { rows } = await query<DatasetRow>(`SELECT ${DATASET_COLUMNS} FROM backlink_datasets WHERE id = $1 AND org_id = $2 AND website_id = $3`, [datasetId, w.orgId, w.id]);
    return rows[0] ?? null;
  }
  const want = subject ? normalizeDomain(subject) : siteDomain(w);
  return (await latestDatasets(w)).find((d) => d.subject_domain === want) ?? null;
}

// Link state: what is known about each link, strongest evidence first.
const LINK_STATE_SQL = `CASE
    WHEN c.outcome = 'link_found' THEN 'verified_live'
    WHEN c.consecutive_missing >= 2 THEN 'lost_verified'
    WHEN l.provider_lost THEN 'provider_reported_lost'
    WHEN c.outcome = 'link_missing' THEN 'verification_missing_once'
    WHEN c.outcome IS NOT NULL THEN 'unverified_check_failed'
    ELSE 'unverified' END`;
export const LINK_STATES = ["verified_live", "lost_verified", "provider_reported_lost", "verification_missing_once", "unverified_check_failed", "unverified"] as const;

export async function getSummary(w: WebsiteRef) {
  const latest = await latestDatasets(w);
  const own = latest.find((d) => d.subject_domain === siteDomain(w)) ?? null;
  let ownStats: Record<string, unknown> | null = null;
  if (own) {
    const [types, states] = await Promise.all([
      query<{ link_type: string | null; n: number }>("SELECT link_type, COUNT(*)::int AS n FROM backlink_links WHERE org_id = $1 AND dataset_id = $2 GROUP BY link_type", [w.orgId, own.id]),
      query<{ state: string; n: number }>(
        `SELECT ${LINK_STATE_SQL} AS state, COUNT(*)::int AS n FROM backlink_links l
           LEFT JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
          WHERE l.org_id = $1 AND l.dataset_id = $2 GROUP BY 1`,
        [w.orgId, own.id, w.id],
      ),
    ]);
    ownStats = {
      links: own.rows_accepted,
      referringDomains: own.referring_domains,
      linkTypes: Object.fromEntries(types.rows.map((r) => [r.link_type ?? "unknown", r.n])),
      states: Object.fromEntries(states.rows.map((r) => [r.state, r.n])),
    };
  }
  const changes = await query<{ change_type: string; n: number }>(
    "SELECT change_type, COUNT(*)::int AS n FROM backlink_changes WHERE org_id = $1 AND website_id = $2 AND subject_domain = $3 AND detected_at > NOW() - interval '90 days' GROUP BY change_type",
    [w.orgId, w.id, siteDomain(w)],
  );
  const job = await query("SELECT id, status, links_total, links_checked, created_at, finished_at, error FROM backlink_verification_jobs WHERE org_id = $1 AND website_id = $2 ORDER BY created_at DESC LIMIT 1", [w.orgId, w.id]);
  return {
    siteDomain: siteDomain(w),
    own: own ? { dataset: present(own), ...ownStats } : null,
    competitors: latest.filter((d) => d.subject_domain !== siteDomain(w)).map((d) => ({ dataset: present(d) })),
    changesLast90Days: Object.fromEntries(changes.rows.map((r) => [r.change_type, r.n])),
    latestVerification: job.rows[0] ?? null,
    staleAfterDays: config.BACKLINK_STALE_DAYS,
  };
}

export const LINK_SORTS = ["source_domain", "last_seen", "first_seen"] as const;

export async function listLinks(
  w: WebsiteRef,
  opts: { datasetId?: string; subject?: string; linkType?: string; state?: string; domain?: string; search?: string; sort: (typeof LINK_SORTS)[number]; order: "asc" | "desc"; limit: number; cursor?: string },
) {
  const dataset = await resolveDataset(w, opts.datasetId, opts.subject);
  if (!dataset) return { dataset: null, links: [], nextCursor: null };
  const params: unknown[] = [w.orgId, dataset.id, w.id];
  const where = ["l.org_id = $1", "l.dataset_id = $2"];
  if (opts.linkType) {
    if (opts.linkType === "unknown") where.push("l.link_type IS NULL");
    else { params.push(opts.linkType); where.push(`l.link_type = $${params.length}`); }
  }
  if (opts.state) { params.push(opts.state); where.push(`${LINK_STATE_SQL} = $${params.length}`); }
  if (opts.domain) { params.push(opts.domain); where.push(`l.source_domain = $${params.length}`); }
  if (opts.search) {
    params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(l.source_url ILIKE $${params.length} OR l.anchor ILIKE $${params.length} OR l.target_url ILIKE $${params.length})`);
  }
  const value = opts.sort === "source_domain" ? "l.source_domain" : `COALESCE(to_char(l.${opts.sort}, 'YYYY-MM-DD'), '${opts.order === "desc" ? "0000-00-00" : "9999-99-99"}')`;
  if (opts.cursor) {
    const c = decodeCursor<{ v: string; id: string; s: string; o: string }>(opts.cursor, (x) => typeof x.v === "string" && typeof x.id === "string" && x.s === opts.sort && x.o === opts.order);
    params.push(c.v, c.id);
    where.push(`(${value} ${opts.order === "desc" ? "<" : ">"} $${params.length - 1} OR (${value} = $${params.length - 1} AND l.id > $${params.length}::uuid))`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<Record<string, unknown> & { id: string; sort_value: string }>(
    `SELECT l.id, l.source_url, l.source_domain, l.target_url, l.anchor, l.link_type, to_char(l.first_seen, 'YYYY-MM-DD') AS first_seen,
            to_char(l.last_seen, 'YYYY-MM-DD') AS last_seen, l.provider_lost, ${LINK_STATE_SQL} AS state,
            c.checked_at, c.outcome AS check_outcome, c.http_status AS check_http_status, c.observed_link_type, c.observed_anchor, ${value} AS sort_value
       FROM backlink_links l
       LEFT JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
      WHERE ${where.join(" AND ")} ORDER BY ${value} ${opts.order === "desc" ? "DESC" : "ASC"}, l.id ASC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return {
    dataset: present(dataset),
    links: page.map(({ sort_value: _s, ...r }) => r),
    nextCursor: more && last ? encodeCursor({ v: last.sort_value, id: last.id, s: opts.sort, o: opts.order }) : null,
  };
}

export async function listReferringDomains(w: WebsiteRef, opts: { datasetId?: string; subject?: string; search?: string; sort: "links" | "domain" | "last_seen"; limit: number; offset: number }) {
  const dataset = await resolveDataset(w, opts.datasetId, opts.subject);
  if (!dataset) return { dataset: null, domains: [], total: 0 };
  const params: unknown[] = [w.orgId, dataset.id, w.id];
  let filter = "";
  if (opts.search) { params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); filter = `AND l.source_domain ILIKE $${params.length}`; }
  const order = opts.sort === "domain" ? "source_domain ASC" : opts.sort === "last_seen" ? "last_seen DESC NULLS LAST, source_domain" : "links DESC, source_domain";
  params.push(opts.limit, opts.offset);
  const { rows } = await query(
    `SELECT l.source_domain, COUNT(*)::int AS links,
            COUNT(*) FILTER (WHERE l.link_type = 'follow')::int AS follow,
            COUNT(*) FILTER (WHERE l.link_type IN ('nofollow','sponsored','ugc'))::int AS not_followed,
            COUNT(*) FILTER (WHERE l.link_type IS NULL)::int AS attributes_unknown,
            to_char(MIN(l.first_seen), 'YYYY-MM-DD') AS first_seen, to_char(MAX(l.last_seen), 'YYYY-MM-DD') AS last_seen,
            COUNT(*) FILTER (WHERE c.outcome = 'link_found')::int AS verified_live,
            COUNT(*) OVER ()::int AS total
       FROM backlink_links l
       LEFT JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
      WHERE l.org_id = $1 AND l.dataset_id = $2 ${filter}
      GROUP BY l.source_domain ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
  return { dataset: present(dataset), domains: rows.map(({ total: _t, ...r }) => r), total };
}

export async function listChanges(w: WebsiteRef, opts: { type?: string; subject?: string; limit: number; cursor?: string }) {
  const params: unknown[] = [w.orgId, w.id, opts.subject ? normalizeDomain(opts.subject) ?? "" : siteDomain(w)];
  const where = ["org_id = $1", "website_id = $2", "subject_domain = $3"];
  if (opts.type) { params.push(opts.type); where.push(`change_type = $${params.length}`); }
  if (opts.cursor) {
    const c = decodeCursor<{ t: string; id: string }>(opts.cursor, (x) => typeof x.t === "string" && typeof x.id === "string");
    params.push(c.t, c.id);
    where.push(`(detected_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<{ id: string; detected_at: Date }>(
    `SELECT id, change_type, source_url, target_url, evidence, details, from_dataset_id, to_dataset_id, detected_at FROM backlink_changes
      WHERE ${where.join(" AND ")} ORDER BY detected_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return { changes: page, nextCursor: more && last ? encodeCursor({ t: last.detected_at.toISOString(), id: last.id }) : null };
}

// ─── Gap and opportunities ───────────────────────────────────────────────────

async function domainsOf(orgId: string, datasetId: string): Promise<Set<string>> {
  const { rows } = await query<{ d: string }>("SELECT DISTINCT source_domain AS d FROM backlink_links WHERE org_id = $1 AND dataset_id = $2", [orgId, datasetId]);
  return new Set(rows.map((r) => r.d));
}

const meta = (d: DatasetRow): DatasetMeta => ({ id: d.id, subject: d.subject_domain, sourceLabel: d.source_label, coverage: d.coverage, retrievedAt: d.retrieved_at, exportedAt: d.exported_at, links: d.rows_accepted });

async function comparisonSet(w: WebsiteRef, competitorsRaw: string[]) {
  const latest = await latestDatasets(w);
  const own = latest.find((d) => d.subject_domain === siteDomain(w));
  if (!own) throw new BacklinkError(422, "OWN_DATASET_MISSING", "Import a backlink export for your own website first.");
  const wanted = competitorsRaw.length ? competitorsRaw.map((c) => normalizeDomain(c)).filter((d): d is string => !!d) : latest.filter((d) => d.subject_kind === "competitor").map((d) => d.subject_domain);
  let competitors = wanted.map((d) => latest.find((x) => x.subject_domain === d && x.subject_kind === "competitor")).filter((d): d is DatasetRow => !!d);
  const missing = wanted.filter((d) => !competitors.some((c) => c.subject_domain === d));
  // Without an explicit selection, competitors that cannot be compared with the own snapshot are left out (and listed), not allowed to block the rest.
  const excluded: Array<{ subject: string; reason: string }> = [];
  if (!competitorsRaw.length) {
    competitors = competitors.filter((c) => {
      const pair = gapCompatibility([own, c].map(meta));
      if (!pair.compatible) excluded.push({ subject: c.subject_domain, reason: pair.problems.join(" ") });
      return pair.compatible;
    });
  }
  if (!competitors.length) {
    throw excluded.length
      ? new BacklinkError(422, "DATASETS_INCOMPATIBLE", `No competitor dataset can be compared with yours: ${excluded.map((e) => `${e.subject}: ${e.reason}`).join(" ")}`, { excluded })
      : new BacklinkError(422, "COMPETITOR_DATASET_MISSING", "Import a backlink export for at least one competitor first.", { missing });
  }
  const compat = gapCompatibility([own, ...competitors].map(meta));
  if (!compat.compatible) throw new BacklinkError(422, "DATASETS_INCOMPATIBLE", compat.problems.join(" "), { problems: compat.problems });
  for (const e of excluded) compat.warnings.push(`${e.subject} was left out: ${e.reason}`);
  return { own, competitors, missing, compat, excluded };
}

const datasetBrief = (d: DatasetRow) => ({ id: d.id, subject: d.subject_domain, sourceLabel: d.source_label, coverage: d.coverage, exportedAt: d.exported_at, retrievedAt: d.retrieved_at, observedFrom: d.observed_from, observedTo: d.observed_to, links: d.rows_accepted, stale: isStale(d) });

export async function backlinkGap(w: WebsiteRef, opts: { competitors: string[]; category?: "shared" | "competitor_only" | "own_only"; limit: number; offset: number }) {
  const { own, competitors, missing, compat } = await comparisonSet(w, opts.competitors);
  const ownDomains = await domainsOf(w.orgId, own.id);
  const sets = await Promise.all(competitors.map(async (c) => ({ subject: c.subject_domain, domains: await domainsOf(w.orgId, c.id) })));
  const rows = referringDomainGap({ subject: own.subject_domain, domains: ownDomains }, sets);
  const counts = { shared: 0, competitor_only: 0, own_only: 0 };
  for (const r of rows) counts[r.category]++;
  const filtered = opts.category ? rows.filter((r) => r.category === opts.category) : rows;

  // Anchor texts used in links to the own site and to at least one competitor.
  const anchors = await query<{ anchor: string; own: number; competitors: number }>(
    `SELECT lower(anchor) AS anchor, COUNT(*) FILTER (WHERE dataset_id = $2)::int AS own, COUNT(*) FILTER (WHERE dataset_id <> $2)::int AS competitors
       FROM backlink_links WHERE org_id = $1 AND dataset_id = ANY($3::uuid[]) AND anchor IS NOT NULL AND char_length(anchor) BETWEEN 2 AND 120
      GROUP BY lower(anchor) HAVING COUNT(*) FILTER (WHERE dataset_id = $2) > 0 AND COUNT(*) FILTER (WHERE dataset_id <> $2) > 0
      ORDER BY COUNT(*) DESC LIMIT 25`,
    [w.orgId, own.id, [own.id, ...competitors.map((c) => c.id)]],
  );
  return {
    datasets: [own, ...competitors].map(datasetBrief),
    missingCompetitors: missing,
    warnings: compat.warnings,
    counts,
    rows: filtered.slice(opts.offset, opts.offset + opts.limit),
    total: filtered.length,
    sharedAnchors: anchors.rows,
  };
}

/** Topic terms: explicit input, else the website's top Search Console queries (real data) when available. */
async function topicTermsFor(w: WebsiteRef, explicit?: string): Promise<{ terms: string[]; source: "input" | "search_console" | null }> {
  if (explicit?.trim()) return { terms: topicTerms(explicit), source: "input" };
  const { rows } = await query<{ q: string }>(
    `SELECT d.dim_value AS q FROM gsc_search_daily d JOIN gsc_properties p ON p.id = d.property_id AND p.org_id = d.org_id
      WHERE d.org_id = $1 AND p.website_id = $2 AND d.dimension_set = 'query' AND d.day > CURRENT_DATE - 90
      GROUP BY d.dim_value ORDER BY SUM(d.impressions) DESC LIMIT 15`,
    [w.orgId, w.id],
  );
  const terms = topicTerms(rows.map((r) => r.q).join(" "));
  return terms.length ? { terms, source: "search_console" } : { terms: [], source: null };
}

export async function opportunities(w: WebsiteRef, opts: { competitors: string[]; topics?: string; kind?: "competitor_only" | "reclaim"; minScore?: number; linkType?: "follow" | "any"; limit: number; offset: number }) {
  const { own, competitors, missing, compat } = await comparisonSet(w, opts.competitors);
  const topics = await topicTermsFor(w, opts.topics);
  const ownDomains = await domainsOf(w.orgId, own.id);

  const evidence = await query<{ domain: string; subjects: string[]; any_follow: boolean | null; last_seen: string | null; verified: boolean | null; urls: string[]; anchors: string[]; links: number }>(
    `SELECT l.source_domain AS domain, array_agg(DISTINCT d.subject_domain) AS subjects,
            CASE WHEN bool_or(l.link_type IS NOT NULL) THEN bool_or(l.link_type = 'follow') END AS any_follow,
            to_char(MAX(l.last_seen), 'YYYY-MM-DD') AS last_seen,
            CASE WHEN bool_or(c.outcome = 'link_found') THEN TRUE WHEN bool_or(c.outcome = 'link_missing') THEN FALSE END AS verified,
            (array_agg(l.source_url ORDER BY l.last_seen DESC NULLS LAST))[1:5] AS urls,
            (array_agg(l.anchor) FILTER (WHERE l.anchor IS NOT NULL))[1:5] AS anchors, COUNT(*)::int AS links
       FROM backlink_links l JOIN backlink_datasets d ON d.id = l.dataset_id AND d.org_id = l.org_id
       LEFT JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
      WHERE l.org_id = $1 AND l.dataset_id = ANY($2::uuid[])
      GROUP BY l.source_domain`,
    [w.orgId, competitors.map((c) => c.id), w.id],
  );
  // Domains that linked to the own site in an earlier snapshot.
  const history = await query<{ domain: string; last_seen: string | null; urls: string[] }>(
    `SELECT l.source_domain AS domain, to_char(MAX(COALESCE(l.last_seen, d.exported_at, d.retrieved_at::date)), 'YYYY-MM-DD') AS last_seen, (array_agg(l.source_url))[1:5] AS urls
       FROM backlink_links l JOIN backlink_datasets d ON d.id = l.dataset_id AND d.org_id = l.org_id
      WHERE l.org_id = $1 AND d.website_id = $2 AND d.subject_domain = $3 AND d.id <> $4
      GROUP BY l.source_domain`,
    [w.orgId, w.id, own.subject_domain, own.id],
  );
  const previously = new Map(history.rows.map((r) => [r.domain, r]));

  const items = [];
  for (const e of evidence.rows) {
    if (ownDomains.has(e.domain)) continue; // already links to the own site in the latest snapshot
    const s = scoreOpportunity({
      domain: e.domain,
      kind: previously.has(e.domain) ? "reclaim" : "competitor_only",
      competitorsLinking: e.subjects.length,
      competitorsCompared: competitors.length,
      anyFollow: e.any_follow,
      lastSeen: e.last_seen,
      verifiedLive: e.verified,
      topicMatches: topics.terms.length ? { matched: matchTopics(topics.terms, [...e.urls, ...(e.anchors ?? [])]), terms: topics.terms.length } : null,
      previouslyLinked: previously.has(e.domain),
    });
    items.push({ domain: e.domain, kind: previously.has(e.domain) ? "reclaim" : "competitor_only", competitors: e.subjects.sort(), links: e.links, sampleUrls: e.urls, ...s,
      why: `Linked to ${e.subjects.join(", ")}${previously.has(e.domain) ? "; linked to your site in an earlier snapshot" : ""}; not observed in your latest data (${own.coverage} coverage).` });
  }
  // Reclaim candidates that link to no compared competitor.
  for (const [domain, h] of previously) {
    if (ownDomains.has(domain) || items.some((i) => i.domain === domain)) continue;
    const s = scoreOpportunity({ domain, kind: "reclaim", competitorsLinking: 0, competitorsCompared: competitors.length, anyFollow: null, lastSeen: h.last_seen, verifiedLive: null, topicMatches: topics.terms.length ? { matched: matchTopics(topics.terms, h.urls), terms: topics.terms.length } : null, previouslyLinked: true });
    items.push({ domain, kind: "reclaim", competitors: [], links: 0, sampleUrls: h.urls, ...s, why: `Linked to your site in an earlier snapshot; not observed in your latest data (${own.coverage} coverage).` });
  }
  const filtered = items
    .filter((i) => !opts.kind || i.kind === opts.kind)
    .filter((i) => opts.minScore === undefined || i.score >= opts.minScore)
    .filter((i) => opts.linkType !== "follow" || i.signals.find((s) => s.id === "follow_links")?.value === 1)
    .sort((a, b) => b.score - a.score || b.competitors.length - a.competitors.length || a.domain.localeCompare(b.domain));
  return {
    datasets: [own, ...competitors].map(datasetBrief),
    missingCompetitors: missing,
    warnings: compat.warnings,
    topics,
    total: filtered.length,
    opportunities: filtered.slice(opts.offset, opts.offset + opts.limit),
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportCsv(w: WebsiteRef, kind: "links" | "referring_domains" | "opportunities" | "changes", opts: { subject?: string; competitors: string[] }) {
  if (kind === "links") {
    const all = await listLinks(w, { subject: opts.subject, sort: "source_domain", order: "asc", limit: 100_000 });
    if (!all.dataset) throw new BacklinkError(404, "DATASET_NOT_FOUND", "No dataset to export.");
    return toCsv(all.links.map((l) => ({ ...l, source: all.dataset!.source_label, dataset_retrieved_at: all.dataset!.retrieved_at.toISOString() })),
      ["source_url", "source_domain", "target_url", "anchor", "link_type", "first_seen", "last_seen", "state", "checked_at", "check_outcome", "source", "dataset_retrieved_at"]);
  }
  if (kind === "referring_domains") {
    const r = await listReferringDomains(w, { subject: opts.subject, sort: "links", limit: 100_000, offset: 0 });
    if (!r.dataset) throw new BacklinkError(404, "DATASET_NOT_FOUND", "No dataset to export.");
    return toCsv(r.domains as Array<Record<string, unknown>>, ["source_domain", "links", "follow", "not_followed", "attributes_unknown", "first_seen", "last_seen", "verified_live"]);
  }
  if (kind === "opportunities") {
    const o = await opportunities(w, { competitors: opts.competitors, limit: 100_000, offset: 0 });
    return toCsv(o.opportunities.map((i) => ({ ...i, competitors: i.competitors.join(" "), signals: i.signals.map((s) => `${s.id}=${s.value === null ? "unavailable" : s.value}`).join("; ") })),
      ["domain", "kind", "score", "basis", "competitors", "links", "why", "signals"]);
  }
  const c = await listChanges(w, { subject: opts.subject, limit: 100_000 });
  return toCsv(c.changes as Array<Record<string, unknown>>, ["detected_at", "change_type", "source_url", "target_url", "evidence"]);
}

// ─── Live verification jobs ──────────────────────────────────────────────────

const LEASE_MS = 60_000;
const MAX_CLAIMS = 50;
const SLICE_LINKS = 40;

export async function requestVerification(w: WebsiteRef, datasetId: string, actorId: string) {
  const { rows: ds } = await query<{ n: number }>(
    "SELECT rows_accepted AS n FROM backlink_datasets WHERE id = $1 AND org_id = $2 AND website_id = $3",
    [datasetId, w.orgId, w.id],
  );
  if (!ds[0]) throw new BacklinkError(404, "DATASET_NOT_FOUND", "Dataset not found.");
  const total = Math.min(ds[0].n, config.BACKLINK_VERIFY_MAX_LINKS);
  try {
    const { rows } = await query(
      `INSERT INTO backlink_verification_jobs (org_id, website_id, dataset_id, links_total, requested_by) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, status, links_total, links_checked, created_at`,
      [w.orgId, w.id, datasetId, total, actorId],
    );
    return { job: rows[0], deduplicated: false, capped: ds[0].n > total };
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const { rows } = await query("SELECT id, status, links_total, links_checked, created_at FROM backlink_verification_jobs WHERE dataset_id = $1 AND org_id = $2 AND status IN ('queued','running')", [datasetId, w.orgId]);
    return { job: rows[0], deduplicated: true, capped: ds[0].n > total };
  }
}

export async function getVerificationJob(w: WebsiteRef, jobId: string) {
  const { rows } = await query(
    "SELECT id, dataset_id, status, links_total, links_checked, error, created_at, started_at, finished_at FROM backlink_verification_jobs WHERE id = $1 AND org_id = $2 AND website_id = $3",
    [jobId, w.orgId, w.id],
  );
  return rows[0] ?? null;
}

interface ClaimedJob { id: string; org_id: string; website_id: string; dataset_id: string; links_total: number; links_checked: number; created_at: Date; claims: number }

async function claimJob(owner: string): Promise<ClaimedJob | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<ClaimedJob>(
      `SELECT id, org_id, website_id, dataset_id, links_total, links_checked, created_at, claims FROM backlink_verification_jobs
        WHERE status = 'queued' OR (status = 'running' AND lease_until < NOW())
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const job = rows[0];
    if (!job) return null;
    if (job.claims >= MAX_CLAIMS) {
      await tx.query("UPDATE backlink_verification_jobs SET status = 'failed', error = 'Gave up after repeated interruptions', finished_at = NOW(), lease_owner = NULL WHERE id = $1", [job.id]);
      return null;
    }
    await tx.query(
      "UPDATE backlink_verification_jobs SET status = 'running', lease_owner = $2, lease_until = NOW() + make_interval(secs => $3), claims = claims + 1, started_at = COALESCE(started_at, NOW()) WHERE id = $1",
      [job.id, owner, LEASE_MS / 1000],
    );
    return job;
  });
}

async function recordCheck(job: ClaimedJob, linkKey: string, r: Awaited<ReturnType<Verifier["check"]>>) {
  await query(
    `INSERT INTO backlink_link_checks (org_id, website_id, link_key, checked_at, outcome, http_status, observed_link_type, observed_anchor, consecutive_missing, last_found_at)
     VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7, CASE WHEN $4 = 'link_missing' THEN 1 ELSE 0 END, CASE WHEN $4 = 'link_found' THEN NOW() END)
     ON CONFLICT (org_id, website_id, link_key) DO UPDATE SET checked_at = NOW(), outcome = EXCLUDED.outcome, http_status = EXCLUDED.http_status,
       observed_link_type = EXCLUDED.observed_link_type, observed_anchor = EXCLUDED.observed_anchor,
       consecutive_missing = CASE WHEN EXCLUDED.outcome = 'link_missing' THEN backlink_link_checks.consecutive_missing + 1
                                  WHEN EXCLUDED.outcome = 'link_found' THEN 0 ELSE backlink_link_checks.consecutive_missing END,
       last_found_at = CASE WHEN EXCLUDED.outcome = 'link_found' THEN NOW() ELSE backlink_link_checks.last_found_at END`,
    [job.org_id, job.website_id, linkKey, r.outcome, r.httpStatus, r.linkType, r.anchor],
  );
}

/**
 * One bounded slice of verification work. Idempotent: links already checked
 * since the job was created are skipped, so a re-claimed job continues where
 * it stopped. Each source site is requested sequentially; at most
 * BACKLINK_VERIFY_CONCURRENCY sites in parallel.
 */
export async function runVerificationSlice(verifier: Verifier = createVerifier(), budgetMs = 15_000): Promise<"idle" | "progress" | "finished"> {
  const owner = randomUUID();
  const job = await claimJob(owner);
  if (!job) return "idle";
  const deadline = Date.now() + budgetMs;
  const remaining = Math.max(0, job.links_total - job.links_checked);
  const { rows: links } = await query<{ link_key: string; source_url: string; target_url: string | null; target_domain: string | null; subject_domain: string }>(
    `SELECT l.link_key, l.source_url, l.target_url, l.target_domain, d.subject_domain FROM backlink_links l
       JOIN backlink_datasets d ON d.id = l.dataset_id AND d.org_id = l.org_id
       LEFT JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
      WHERE l.org_id = $1 AND l.dataset_id = $2 AND (c.checked_at IS NULL OR c.checked_at < $4)
      ORDER BY l.source_row LIMIT $5`,
    [job.org_id, job.dataset_id, job.website_id, job.created_at, Math.min(remaining, SLICE_LINKS)],
  );
  const byOrigin = new Map<string, typeof links>();
  for (const l of links) { const o = new URL(l.source_url).origin; byOrigin.set(o, [...(byOrigin.get(o) ?? []), l]); }
  const queues = [...byOrigin.values()];
  let checked = 0;
  const workers = Array.from({ length: Math.min(config.BACKLINK_VERIFY_CONCURRENCY, queues.length) }, async () => {
    for (let q = queues.shift(); q; q = queues.shift()) {
      for (const l of q) {
        if (Date.now() > deadline) return;
        let r: Awaited<ReturnType<Verifier["check"]>>;
        try {
          r = await verifier.check({ sourceUrl: l.source_url, targetUrl: l.target_url, targetDomain: l.target_domain ?? l.subject_domain });
        } catch {
          r = { outcome: "error", httpStatus: null, linkType: null, anchor: null };
        }
        await recordCheck(job, l.link_key, r);
        checked++;
      }
    }
  });
  await Promise.all(workers);
  const done = job.links_checked + checked >= job.links_total || links.length === 0;
  await query(
    `UPDATE backlink_verification_jobs SET links_checked = LEAST(links_total, links_checked + $2), lease_owner = NULL, lease_until = NULL,
            status = CASE WHEN $3 THEN 'completed' ELSE 'queued' END, finished_at = CASE WHEN $3 THEN NOW() END
      WHERE id = $1 AND lease_owner = $4`,
    [job.id, checked, done, owner],
  );
  if (done) await recordVerifiedLosses(job);
  return done ? "finished" : "progress";
}

/** Two consecutive "link missing" checks on a reachable HTML page: a verified loss (deduplicated). */
async function recordVerifiedLosses(job: ClaimedJob) {
  await query(
    `INSERT INTO backlink_changes (org_id, website_id, subject_domain, change_type, link_key, source_url, target_url, from_dataset_id, to_dataset_id, evidence, details)
     SELECT l.org_id, $3, d.subject_domain, 'lost', l.link_key, l.source_url, l.target_url, NULL, l.dataset_id,
            'Two consecutive live checks of the linking page did not find the link.', jsonb_build_object('checkedAt', c.checked_at)
       FROM backlink_links l JOIN backlink_datasets d ON d.id = l.dataset_id AND d.org_id = l.org_id
       JOIN backlink_link_checks c ON c.org_id = l.org_id AND c.website_id = $3 AND c.link_key = l.link_key
      WHERE l.org_id = $1 AND l.dataset_id = $2 AND c.consecutive_missing >= 2
     ON CONFLICT ON CONSTRAINT backlink_changes_unique DO NOTHING`,
    [job.org_id, job.dataset_id, job.website_id],
  );
}

/** Worker tick entry: at most one slice per tick. */
export async function processBacklinkVerificationTick(budgetMs = 15_000): Promise<void> {
  await runVerificationSlice(createVerifier(), budgetMs);
}
