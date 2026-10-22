import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import { domainOf, encodingProblem, normalizeDomain, normalizeLinkUrl, parseCsv } from "../backlinks/core.js";
import { normalizeKeyword } from "../research/keywords.js";
import {
  classifyChange,
  compareWithCompetitor,
  distribution,
  evaluateRule,
  parseFeatures,
  parsePosition,
  previousComparable,
  top10Share,
  type AlertRule,
  type ChangeKind,
  type Observation,
  type ObservationStatus,
  type RuleType,
} from "../ranking/core.js";
import { RankProviderError, resolveRankProvider, type SerpProvider, type SerpResponse } from "../ranking/providers.js";
import { toCsv } from "./keyword-research.service.js";

/**
 * Rank tracking service. Every query is scoped by org_id; a project is only
 * reachable through its organization. Observations come from imported
 * ranking reports or a configured provider, never from estimates.
 */

export class RankError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "RankError";
  }
}

export interface ProjectRow {
  id: string;
  website_id: string;
  website_domain: string;
  name: string;
  search_engine: "google" | "bing";
  country: string | null;
  language: string | null;
  device: "desktop" | "mobile" | null;
  location: string | null;
  timezone: string;
  frequency: "manual" | "daily" | "weekly";
  status: "active" | "paused" | "archived";
  created_at: Date;
  updated_at: Date;
}

const PROJECT_SELECT = `SELECT p.id, p.website_id, w.domain AS website_domain, p.name, p.search_engine, p.country, p.language, p.device, p.location, p.timezone,
  p.frequency, p.status, p.created_at, p.updated_at FROM rank_projects p JOIN websites w ON w.id = p.website_id AND w.org_id = p.org_id`;

const ownDomain = (p: Pick<ProjectRow, "website_domain">) => normalizeDomain(p.website_domain) ?? p.website_domain.toLowerCase();

function todayIn(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectInput {
  websiteId: string;
  name: string;
  searchEngine: "google" | "bing";
  country?: string | null;
  language?: string | null;
  device?: "desktop" | "mobile" | null;
  location?: string | null;
  timezone: string;
  frequency: "manual" | "daily" | "weekly";
}

/** Scheduled tracking needs a provider that supports the configuration; manual projects are filled by imports. */
function assertTrackable(input: Pick<ProjectInput, "frequency" | "searchEngine" | "country" | "language" | "device" | "location">) {
  if (input.frequency === "manual") return;
  let provider: SerpProvider;
  try {
    provider = resolveRankProvider();
  } catch (err) {
    const e = err as RankProviderError;
    throw new RankError(422, "PROVIDER_NOT_CONFIGURED", `Scheduled tracking needs a SERP data provider. ${e.message}`);
  }
  const t = provider.info.targeting;
  const unsupported = [
    !provider.info.searchEngines.includes(input.searchEngine) && `search engine ${input.searchEngine}`,
    input.country && !t.countries && "country targeting",
    input.language && !t.languages && "language targeting",
    input.location && !t.locations && "location targeting",
    input.device && !t.devices.includes(input.device) && `${input.device} results`,
  ].filter(Boolean);
  if (unsupported.length) throw new RankError(422, "TARGETING_UNSUPPORTED", `${provider.info.name} does not support ${unsupported.join(", ")}.`);
}

export async function createProject(orgId: string, actorId: string, input: ProjectInput): Promise<ProjectRow> {
  const site = await query("SELECT 1 FROM websites WHERE id = $1 AND org_id = $2", [input.websiteId, orgId]);
  if (!site.rows[0]) throw new RankError(404, "NOT_FOUND", "Website not found");
  assertTrackable(input);
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO rank_projects (org_id, website_id, name, search_engine, country, language, device, location, timezone, frequency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [orgId, input.websiteId, input.name, input.searchEngine, input.country ?? null, input.language ?? null, input.device ?? null, input.location ?? null, input.timezone, input.frequency, actorId],
    );
    return (await getProject(orgId, rows[0].id))!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new RankError(409, "PROJECT_EXISTS", "A project with this website and search configuration already exists.");
    throw err;
  }
}

export async function getProject(orgId: string, projectId: string): Promise<ProjectRow | null> {
  const { rows } = await query<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [projectId, orgId]);
  return rows[0] ?? null;
}

export async function requireProject(orgId: string, projectId: string): Promise<ProjectRow> {
  const p = await getProject(orgId, projectId);
  if (!p) throw new RankError(404, "NOT_FOUND", "Project not found");
  return p;
}

export async function listProjects(orgId: string, websiteId?: string) {
  const params: unknown[] = [orgId];
  let where = "p.org_id = $1 AND p.status <> 'archived'";
  if (websiteId) { params.push(websiteId); where += ` AND p.website_id = $${params.length}`; }
  const { rows } = await query(
    `${PROJECT_SELECT.replace("FROM rank_projects p", `, (SELECT COUNT(*)::int FROM rank_keywords k WHERE k.project_id = p.id AND k.status <> 'removed') AS keywords,
       (SELECT MAX(o.observed_date)::text FROM rank_observations o WHERE o.project_id = p.id AND o.org_id = p.org_id) AS last_observed
       FROM rank_projects p`)} WHERE ${where} ORDER BY p.created_at DESC LIMIT 200`,
    params,
  );
  return rows;
}

export async function updateProject(orgId: string, projectId: string, patch: Partial<Pick<ProjectInput, "name" | "timezone" | "frequency">> & { status?: "active" | "paused" | "archived" }) {
  const p = await requireProject(orgId, projectId);
  if (patch.frequency && patch.frequency !== p.frequency) assertTrackable({ ...{ searchEngine: p.search_engine, country: p.country, language: p.language, device: p.device, location: p.location }, frequency: patch.frequency });
  await query(
    `UPDATE rank_projects SET name = COALESCE($3, name), timezone = COALESCE($4, timezone), frequency = COALESCE($5, frequency), status = COALESCE($6, status), updated_at = NOW()
      WHERE id = $1 AND org_id = $2`,
    [projectId, orgId, patch.name ?? null, patch.timezone ?? null, patch.frequency ?? null, patch.status ?? null],
  );
  if (patch.status === "paused" || patch.status === "archived") {
    await query("UPDATE rank_collection_jobs SET status = 'cancelled', finished_at = NOW(), lease_owner = NULL WHERE project_id = $1 AND org_id = $2 AND status IN ('queued','running')", [projectId, orgId]);
  }
  return requireProject(orgId, projectId);
}

// ─── Keywords ────────────────────────────────────────────────────────────────

const displayKeyword = (k: string) => k.normalize("NFKC").replace(/\s+/g, " ").trim();

function landingPageFor(raw: string | null | undefined, project: ProjectRow): { url: string | null; warning: string | null } {
  if (!raw?.trim()) return { url: null, warning: null };
  const url = normalizeLinkUrl(raw);
  if (!url) throw new RankError(400, "VALIDATION_ERROR", `Invalid landing page URL: ${raw.slice(0, 100)}`);
  const d = domainOf(url);
  const own = ownDomain(project);
  return { url, warning: d === own || d.endsWith(`.${own}`) ? null : `Landing page ${url} is not on ${own}.` };
}

export interface KeywordInput {
  keyword: string;
  group?: string | null;
  landingPage?: string | null;
}

/** Adds keywords (normalized, deduplicated); re-adding a removed keyword restores it with its history. */
export async function addKeywords(orgId: string, project: ProjectRow, items: KeywordInput[], source: "manual" | "csv" | "observation_import", actorId: string, db: Queryable = { query } as Queryable) {
  const invalid: Array<{ keyword: string; reason: string }> = [];
  const warnings: string[] = [];
  const byKey = new Map<string, { keyword: string; group: string | null; landing: string | null }>();
  for (const item of items) {
    const keyword = displayKeyword(item.keyword ?? "");
    const key = normalizeKeyword(keyword);
    if (!key || key.length > 200 || keyword.length > 200) { invalid.push({ keyword: keyword.slice(0, 100), reason: "Empty or longer than 200 characters" }); continue; }
    let landing: string | null = null;
    try {
      const lp = landingPageFor(item.landingPage, project);
      landing = lp.url;
      if (lp.warning) warnings.push(lp.warning);
    } catch (err) {
      invalid.push({ keyword, reason: (err as Error).message });
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, { keyword, group: item.group?.trim().slice(0, 80) || null, landing });
  }
  const { rows: countRows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status <> 'removed'", [project.id, orgId]);
  const entries = [...byKey.entries()];
  const { rows: existing } = await db.query<{ keyword_key: string; status: string }>("SELECT keyword_key, status FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND keyword_key = ANY($3)", [project.id, orgId, entries.map(([k]) => k)]);
  const existingActive = new Set(existing.filter((e) => e.status !== "removed").map((e) => e.keyword_key));
  const newCount = entries.filter(([k]) => !existingActive.has(k)).length;
  if (countRows[0].n + newCount > config.RANK_MAX_KEYWORDS_PER_PROJECT) {
    throw new RankError(422, "KEYWORD_LIMIT", `A project can track at most ${config.RANK_MAX_KEYWORDS_PER_PROJECT} keywords (${countRows[0].n} tracked, ${newCount} new).`, { tracked: countRows[0].n, adding: newCount, limit: config.RANK_MAX_KEYWORDS_PER_PROJECT });
  }
  let added = 0;
  let restored = 0;
  for (const [key, v] of entries) {
    const r = await db.query<{ inserted: boolean }>(
      `INSERT INTO rank_keywords (org_id, project_id, keyword, keyword_key, group_name, landing_page, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT ON CONSTRAINT rank_keywords_key_unique DO UPDATE SET status = 'active', updated_at = NOW(),
         group_name = COALESCE(EXCLUDED.group_name, rank_keywords.group_name), landing_page = COALESCE(EXCLUDED.landing_page, rank_keywords.landing_page)
         WHERE rank_keywords.status = 'removed'
       RETURNING (xmax = 0) AS inserted`,
      [orgId, project.id, v.keyword, key, v.group, v.landing, source, actorId],
    );
    if (r.rows[0]?.inserted) added++;
    else if (r.rows[0]) restored++;
  }
  return { added, restored, alreadyTracked: entries.length - added - restored, invalid, warnings: [...new Set(warnings)].slice(0, 20), limit: config.RANK_MAX_KEYWORDS_PER_PROJECT };
}

export function parseKeywordCsv(csv: string): KeywordInput[] {
  const problem = encodingProblem(csv);
  if (problem) throw new RankError(422, "ENCODING_INVALID", problem);
  if (Buffer.byteLength(csv, "utf8") > 2_000_000) throw new RankError(413, "IMPORT_TOO_LARGE", "Keyword files are limited to 2 MB.");
  const { header, rows, truncated } = parseCsv(csv, config.RANK_MAX_KEYWORDS_PER_PROJECT + 1);
  if (truncated) throw new RankError(413, "IMPORT_TOO_LARGE", `At most ${config.RANK_MAX_KEYWORDS_PER_PROJECT} keywords per file.`);
  const h = header.map((x) => x.toLowerCase().trim());
  const col = (names: string[]) => h.findIndex((x) => names.includes(x));
  const kw = col(["keyword", "keywords", "query", "search term"]);
  if (kw < 0) {
    // A one-column list without a recognised header: the header itself is a keyword.
    if (header.length === 1) return [header[0], ...rows.map((r) => r[0])].filter((k) => k?.trim()).map((keyword) => ({ keyword }));
    throw new RankError(422, "COLUMNS_MISSING", "No 'keyword' column found.");
  }
  const group = col(["group", "tag", "tags", "topic", "campaign"]);
  const landing = col(["landing page", "landing_page", "url", "target url"]);
  return rows.filter((r) => r[kw]?.trim()).map((r) => ({ keyword: r[kw], group: group >= 0 ? r[group] : null, landingPage: landing >= 0 ? r[landing] : null }));
}

export async function listKeywords(orgId: string, projectId: string, opts: { search?: string; group?: string; status?: "active" | "paused"; limit: number; cursor?: string }) {
  const params: unknown[] = [projectId, orgId];
  const where = ["project_id = $1", "org_id = $2", "status <> 'removed'"];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.group) { params.push(opts.group); where.push(`group_name = $${params.length}`); }
  if (opts.search) { params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`keyword ILIKE $${params.length}`); }
  if (opts.cursor) {
    const c = decodeCursor<{ k: string; id: string }>(opts.cursor, (x) => typeof x.k === "string" && typeof x.id === "string");
    params.push(c.k, c.id);
    where.push(`(keyword_key, id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<{ id: string; keyword_key: string }>(
    `SELECT id, keyword, keyword_key, group_name, landing_page, status, source, created_at FROM rank_keywords WHERE ${where.join(" AND ")} ORDER BY keyword_key, id LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  const groups = await query<{ g: string }>("SELECT DISTINCT group_name AS g FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status <> 'removed' AND group_name IS NOT NULL ORDER BY 1", [projectId, orgId]);
  return { keywords: page, nextCursor: more && last ? encodeCursor({ k: last.keyword_key, id: last.id }) : null, groups: groups.rows.map((r) => r.g) };
}

export async function updateKeyword(orgId: string, project: ProjectRow, keywordId: string, patch: { group?: string | null; landingPage?: string | null; status?: "active" | "paused" | "removed" }) {
  const lp = patch.landingPage === undefined ? undefined : landingPageFor(patch.landingPage, project).url;
  const { rowCount } = await query(
    `UPDATE rank_keywords SET group_name = CASE WHEN $4 THEN $5 ELSE group_name END, landing_page = CASE WHEN $6 THEN $7 ELSE landing_page END,
            status = COALESCE($8, status), updated_at = NOW()
      WHERE id = $1 AND project_id = $2 AND org_id = $3 AND status <> 'removed'`,
    [keywordId, project.id, orgId, patch.group !== undefined, patch.group?.trim().slice(0, 80) || null, lp !== undefined, lp ?? null, patch.status ?? null],
  );
  if (!rowCount) throw new RankError(404, "NOT_FOUND", "Keyword not found");
}

// ─── Competitors ─────────────────────────────────────────────────────────────

export async function listCompetitors(orgId: string, projectId: string) {
  const { rows } = await query<{ domain: string; created_at: Date }>("SELECT domain, created_at FROM rank_competitors WHERE project_id = $1 AND org_id = $2 ORDER BY domain", [projectId, orgId]);
  return rows;
}

export async function addCompetitor(orgId: string, project: ProjectRow, raw: string, actorId: string) {
  const domain = normalizeDomain(raw);
  if (!domain) throw new RankError(400, "VALIDATION_ERROR", "Invalid domain.");
  if (domain === ownDomain(project)) throw new RankError(400, "VALIDATION_ERROR", "That is the project's own website.");
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rank_competitors WHERE project_id = $1 AND org_id = $2", [project.id, orgId]);
    if (rows[0].n >= config.RANK_MAX_COMPETITORS) throw new RankError(422, "COMPETITOR_LIMIT", `At most ${config.RANK_MAX_COMPETITORS} competitors per project.`);
    const r = await tx.query("INSERT INTO rank_competitors (org_id, project_id, domain, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [orgId, project.id, domain, actorId]);
    return { domain, added: (r.rowCount ?? 0) > 0 };
  });
}

export async function removeCompetitor(orgId: string, projectId: string, domain: string) {
  const { rowCount } = await query("DELETE FROM rank_competitors WHERE project_id = $1 AND org_id = $2 AND domain = $3", [projectId, orgId, domain]);
  return { removed: (rowCount ?? 0) > 0 };
}

// ─── Ranking-report import ───────────────────────────────────────────────────

type RankField = "keyword" | "date" | "position" | "url" | "domain" | "engine" | "country" | "language" | "device" | "depth" | "features" | "owned_features" | "result_type";
const ALIASES: Record<RankField, string[]> = {
  keyword: ["keyword", "query", "search term", "keyword text"],
  date: ["date", "observed at", "observed_at", "checked at", "check date", "day"],
  position: ["position", "rank", "ranking", "google position", "current position", "pos"],
  url: ["url", "ranking url", "ranking_url", "landing page", "found url", "result url"],
  domain: ["domain", "site", "website", "competitor", "subject domain", "subject"],
  engine: ["search engine", "engine", "se"],
  country: ["country", "country code", "location country"],
  language: ["language", "lang"],
  device: ["device"],
  depth: ["depth", "result depth", "results checked", "checked depth"],
  features: ["serp features", "features", "serp_features"],
  owned_features: ["owned features", "owned serp features", "features owned", "your features"],
  result_type: ["result type", "type", "result_type"],
};
const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

function mapRankHeaders(header: string[]) {
  const mapping: Partial<Record<RankField, number>> = {};
  const used = new Set<number>();
  for (const f of Object.keys(ALIASES) as RankField[]) {
    const idx = header.findIndex((h, i) => !used.has(i) && ALIASES[f].map(norm).includes(norm(h)));
    if (idx >= 0) { mapping[f] = idx; used.add(idx); }
  }
  const missing = (["keyword", "date", "position"] as RankField[]).filter((f) => mapping[f] === undefined);
  return { mapping, unmapped: header.filter((_, i) => !used.has(i)), missing };
}

interface ParsedObservation {
  keyword: string;
  keywordKey: string;
  subject: string;
  date: string;
  status: ObservationStatus;
  position: number | null;
  depth: number | null;
  url: string | null;
  resultType: string | null;
  features: string[];
  owned: string[];
  row: number;
}

function analyseReport(project: ProjectRow, competitors: Set<string>, csv: string) {
  if (Buffer.byteLength(csv, "utf8") > config.RANK_IMPORT_MAX_BYTES) throw new RankError(413, "IMPORT_TOO_LARGE", `The file is larger than ${Math.round(config.RANK_IMPORT_MAX_BYTES / 1_000_000)} MB.`);
  const problem = encodingProblem(csv);
  if (problem) throw new RankError(422, "ENCODING_INVALID", problem);
  const parsed = parseCsv(csv, config.RANK_IMPORT_MAX_ROWS);
  const { mapping, unmapped, missing } = mapRankHeaders(parsed.header);
  const own = ownDomain(project);
  const accepted = new Map<string, ParsedObservation>();
  const rejected: Array<{ row: number; reason: string }> = [];
  let duplicates = 0;
  let skipped = 0;
  const today = todayIn(project.timezone);
  const warn = new Set<string>();
  if (!missing.length) {
    parsed.rows.forEach((cells, i) => {
      const row = i + 2;
      if (cells.every((c) => !c.trim())) return void skipped++;
      const get = (f: RankField) => (mapping[f] === undefined ? undefined : (cells[mapping[f]!] ?? "").trim());
      if (cells.some((c) => c.length > 2048)) return void rejected.push({ row, reason: "A field is longer than 2048 characters" });
      const keyword = displayKeyword(get("keyword") ?? "");
      const keywordKey = normalizeKeyword(keyword);
      if (!keywordKey || keyword.length > 200) return void rejected.push({ row, reason: "Missing or too long keyword" });
      const dateRaw = get("date") ?? "";
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateRaw);
      const t = iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : Date.parse(dateRaw);
      const date = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
      if (!date || date < "2000-01-01" || date > today) return void rejected.push({ row, reason: "Missing, unreadable or future date" });
      const pos = parsePosition(get("position"), get("depth"));
      if ("error" in pos) return void rejected.push({ row, reason: pos.error });
      const subjectRaw = get("domain");
      const subject = subjectRaw ? normalizeDomain(subjectRaw) : own;
      if (!subject) return void rejected.push({ row, reason: "Invalid domain" });
      if (subject !== own && !competitors.has(subject)) return void rejected.push({ row, reason: `${subject} is neither the project's website nor one of its competitors` });
      // Rows for another search configuration belong to another project.
      const engine = get("engine")?.toLowerCase();
      if (engine && !engine.includes(project.search_engine)) return void rejected.push({ row, reason: `Search engine ${engine} differs from the project's ${project.search_engine}` });
      const country = get("country")?.toLowerCase();
      if (country && project.country && country !== project.country) return void rejected.push({ row, reason: `Country ${country} differs from the project's ${project.country}` });
      const device = get("device")?.toLowerCase();
      if (device && project.device && !device.startsWith(project.device === "desktop" ? "desk" : "mob")) return void rejected.push({ row, reason: `Device ${device} differs from the project's ${project.device}` });
      const language = get("language")?.toLowerCase();
      if (language && project.language && !language.startsWith(project.language)) return void rejected.push({ row, reason: `Language ${language} differs from the project's ${project.language}` });
      let url: string | null = null;
      const urlRaw = get("url");
      if (urlRaw && urlRaw !== "-") {
        url = normalizeLinkUrl(urlRaw);
        if (!url) return void rejected.push({ row, reason: "Invalid ranking URL" });
        if (pos.status !== "ranked") url = null;
        else {
          const d = domainOf(url);
          if (d !== subject && !d.endsWith(`.${subject}`)) warn.add(`Some ranking URLs are not on the row's domain (row ${row}: ${d}).`);
        }
      }
      const features = parseFeatures(get("features"));
      const owned = pos.status === "ranked" ? parseFeatures(get("owned_features")) : [];
      if (owned.some((f) => !features.includes(f))) return void rejected.push({ row, reason: "An owned SERP feature is not listed among the page's features" });
      const k = `${keywordKey}\n${subject}\n${date}`;
      if (accepted.has(k)) return void duplicates++;
      accepted.set(k, { keyword, keywordKey, subject, date, status: pos.status, position: pos.position, depth: pos.depth, url, resultType: get("result_type")?.slice(0, 40) || null, features, owned, row });
    });
  }
  const observations = [...accepted.values()];
  if (mapping.depth === undefined && observations.some((o) => o.status === "not_in_results")) warn.add("The report does not state how many results were checked; 'not found' rows have no depth.");
  if (mapping.url === undefined) warn.add("No ranking URL column: landing pages are unknown.");
  if (mapping.features === undefined) warn.add("No SERP feature column: SERP features are unknown for these observations.");
  return { parsed, mapping, unmapped, missing, observations, rejected, duplicates, skipped, warnings: [...warn] };
}

const mappingNames = (header: string[], mapping: Partial<Record<RankField, number>>) => Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, header[i!]]));

export async function previewObservationImport(orgId: string, project: ProjectRow, csv: string) {
  const competitors = new Set((await listCompetitors(orgId, project.id)).map((c) => c.domain));
  const a = analyseReport(project, competitors, csv);
  const keys = [...new Set(a.observations.map((o) => o.keywordKey))];
  const known = keys.length ? (await query<{ keyword_key: string }>("SELECT keyword_key FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND keyword_key = ANY($3)", [project.id, orgId, keys])).rows.length : 0;
  return {
    columns: mappingNames(a.parsed.header, a.mapping),
    unmappedColumns: a.unmapped,
    missingRequired: a.missing,
    rowLimitExceeded: a.parsed.truncated,
    rows: { total: a.parsed.rows.length, accepted: a.observations.length, rejected: a.rejected.length, duplicate: a.duplicates, skipped: a.skipped },
    rejectedSamples: a.rejected.slice(0, 20),
    warnings: a.warnings,
    newKeywords: keys.length - known,
    statuses: a.observations.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {}),
    sample: a.observations.slice(0, 10).map(({ keywordKey: _k, row: _r, ...o }) => o),
  };
}

export async function importObservations(orgId: string, project: ProjectRow, actorId: string, input: { csv: string; filename?: string; sourceLabel: string; createMissingKeywords: boolean }) {
  const competitors = new Set((await listCompetitors(orgId, project.id)).map((c) => c.domain));
  const a = analyseReport(project, competitors, input.csv);
  if (a.missing.length) throw new RankError(422, "COLUMNS_MISSING", `Required columns not found: ${a.missing.join(", ")}.`, { unmappedColumns: a.unmapped });
  if (a.parsed.truncated) throw new RankError(413, "IMPORT_TOO_LARGE", `The file has more than ${config.RANK_IMPORT_MAX_ROWS} rows. Split it first.`);
  if (!a.observations.length) throw new RankError(422, "NO_VALID_ROWS", "No row could be imported.", { rejectedSamples: a.rejected.slice(0, 20) });
  const sha = createHash("sha256").update(input.csv, "utf8").digest("hex");

  const result = await withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`rank-import:${project.id}`]);
    const existing = await tx.query("SELECT id, rows_accepted, created_at FROM rank_imports WHERE project_id = $1 AND content_sha256 = $2", [project.id, sha]);
    if (existing.rows[0]) return { importId: existing.rows[0].id as string, duplicateImport: true, inserted: 0, alreadyObserved: 0, keywordsCreated: 0, skippedUnknownKeywords: 0 };

    const keys = [...new Set(a.observations.map((o) => o.keywordKey))];
    let keywordsCreated = 0;
    if (input.createMissingKeywords) {
      const names = new Map(a.observations.map((o) => [o.keywordKey, o.keyword]));
      const r = await addKeywords(orgId, project, keys.map((k) => ({ keyword: names.get(k)! })), "observation_import", actorId, tx);
      keywordsCreated = r.added + r.restored;
    }
    const { rows: kws } = await tx.query<{ id: string; keyword_key: string }>("SELECT id, keyword_key FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND keyword_key = ANY($3) AND status <> 'removed'", [project.id, orgId, keys]);
    const idByKey = new Map(kws.map((k) => [k.keyword_key, k.id]));
    const usable = a.observations.filter((o) => idByKey.has(o.keywordKey));
    const imp = await tx.query<{ id: string }>(
      `INSERT INTO rank_imports (org_id, project_id, source_label, filename, content_sha256, rows_total, rows_accepted, rows_rejected, rows_duplicate, rows_skipped, keywords_created, rejected_samples, column_mapping, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [orgId, project.id, input.sourceLabel, input.filename ?? null, sha, a.parsed.rows.length, usable.length, a.rejected.length, a.duplicates, a.skipped + (a.observations.length - usable.length), keywordsCreated, JSON.stringify(a.rejected.slice(0, 50)), JSON.stringify(mappingNames(a.parsed.header, a.mapping)), actorId],
    );
    const importId = imp.rows[0].id;
    let inserted = 0;
    for (let i = 0; i < usable.length; i += 1000) {
      const b = usable.slice(i, i + 1000);
      const r = await tx.query(
        `INSERT INTO rank_observations (org_id, project_id, keyword_id, subject_domain, observed_date, observed_at, status, position, result_depth, ranking_url, result_type,
           search_engine, country, language, device, serp_features, owned_features, source, source_label, import_id)
         SELECT $1, $2, x.kw, x.subject, x.d, x.d::timestamptz, x.status, x.pos, x.depth, x.url, x.rtype, $3, $4, $5, $6,
                COALESCE((SELECT array_agg(f) FROM jsonb_array_elements_text(x.features) f), '{}'), COALESCE((SELECT array_agg(f) FROM jsonb_array_elements_text(x.owned) f), '{}'),
                'csv_import', $7, $8
           FROM jsonb_to_recordset($9::jsonb) AS x(kw uuid, subject text, d date, status text, pos int, depth int, url text, rtype text, features jsonb, owned jsonb)
         ON CONFLICT ON CONSTRAINT rank_observations_unique DO NOTHING`,
        [orgId, project.id, project.search_engine, project.country, project.language, project.device, input.sourceLabel, importId,
          JSON.stringify(b.map((o) => ({ kw: idByKey.get(o.keywordKey), subject: o.subject, d: o.date, status: o.status, pos: o.position, depth: o.depth, url: o.url, rtype: o.resultType, features: o.features, owned: o.owned })))],
      );
      inserted += r.rowCount ?? 0;
    }
    return { importId, duplicateImport: false, inserted, alreadyObserved: usable.length - inserted, keywordsCreated, skippedUnknownKeywords: a.observations.length - usable.length };
  });
  const alerts = result.duplicateImport ? 0 : await evaluateAlerts(orgId, project.id);
  return { ...result, warnings: a.warnings, rejected: a.rejected.length, duplicates: a.duplicates, alertsCreated: alerts };
}

export async function listImports(orgId: string, projectId: string) {
  const { rows } = await query(
    "SELECT id, source_label, filename, rows_total, rows_accepted, rows_rejected, rows_duplicate, rows_skipped, keywords_created, rejected_samples, created_at FROM rank_imports WHERE project_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 100",
    [projectId, orgId],
  );
  return rows;
}

// ─── Observations and reads ──────────────────────────────────────────────────

interface ObsRow {
  id: string;
  keyword_id: string;
  subject_domain: string;
  observed_date: string;
  status: ObservationStatus;
  position: number | null;
  result_depth: number | null;
  ranking_url: string | null;
  source: string;
  source_label: string;
  serp_features: string[];
  owned_features: string[];
  result_type: string | null;
  error_code: string | null;
}

const OBS_COLS = "o.id, o.keyword_id, o.subject_domain, to_char(o.observed_date, 'YYYY-MM-DD') AS observed_date, o.status, o.position, o.result_depth, o.ranking_url, o.source, o.source_label, o.serp_features, o.owned_features, o.result_type, o.error_code";

export const toObservation = (r: ObsRow): Observation => ({ id: r.id, observedDate: r.observed_date, status: r.status, position: r.position, resultDepth: r.result_depth, rankingUrl: r.ranking_url, source: r.source, serpFeatures: r.serp_features, ownedFeatures: r.owned_features });

/** The recent observation history (newest first, at most `perKeyword` days) of every tracked keyword for one subject. */
async function recentHistory(orgId: string, projectId: string, subject: string, perKeyword = 30, keywordIds?: string[]): Promise<Map<string, ObsRow[]>> {
  const params: unknown[] = [orgId, projectId, subject, perKeyword];
  let filter = "";
  if (keywordIds) { params.push(keywordIds); filter = `AND o.keyword_id = ANY($${params.length}::uuid[])`; }
  const { rows } = await query<ObsRow>(
    `SELECT * FROM (SELECT ${OBS_COLS}, row_number() OVER (PARTITION BY o.keyword_id ORDER BY o.observed_date DESC, o.created_at DESC) AS rn
       FROM rank_observations o WHERE o.org_id = $1 AND o.project_id = $2 AND o.subject_domain = $3 ${filter}) t WHERE rn <= $4`,
    params,
  );
  const map = new Map<string, ObsRow[]>();
  for (const r of rows) map.set(r.keyword_id, [...(map.get(r.keyword_id) ?? []), r]);
  return map;
}

export interface RankingRow {
  keywordId: string;
  keyword: string;
  group: string | null;
  status: string;
  landingPage: string | null;
  latest: ObsRow | null;
  previous: ObsRow | null;
  change: { kind: ChangeKind; delta: number | null; reason: string };
}

async function rankingRows(orgId: string, project: ProjectRow, group?: string): Promise<RankingRow[]> {
  const params: unknown[] = [project.id, orgId];
  let filter = "";
  if (group) { params.push(group); filter = `AND group_name = $${params.length}`; }
  const { rows: kws } = await query<{ id: string; keyword: string; group_name: string | null; status: string; landing_page: string | null }>(
    `SELECT id, keyword, group_name, status, landing_page FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status <> 'removed' ${filter} ORDER BY keyword_key`,
    params,
  );
  const history = await recentHistory(orgId, project.id, ownDomain(project));
  return kws.map((k) => {
    const h = history.get(k.id) ?? [];
    const latest = h[0] ?? null;
    const prev = latest ? previousComparable(h.map(toObservation), toObservation(latest)) : null;
    const previous = prev ? h.find((r) => r.id === prev.id)! : null;
    return { keywordId: k.id, keyword: k.keyword, group: k.group_name, status: k.status, landingPage: k.landing_page, latest, previous, change: classifyChange(prev, latest ? toObservation(latest) : null) };
  });
}

export async function listRankings(orgId: string, project: ProjectRow, opts: { group?: string; change?: ChangeKind; search?: string; sort: "keyword" | "position" | "change"; limit: number; offset: number }) {
  let rows = await rankingRows(orgId, project, opts.group);
  if (opts.change) rows = rows.filter((r) => r.change.kind === opts.change);
  if (opts.search) { const s = opts.search.toLowerCase(); rows = rows.filter((r) => r.keyword.toLowerCase().includes(s)); }
  const pos = (r: RankingRow) => (r.latest?.status === "ranked" ? r.latest.position! : Number.POSITIVE_INFINITY);
  if (opts.sort === "position") rows.sort((a, b) => pos(a) - pos(b) || a.keyword.localeCompare(b.keyword));
  if (opts.sort === "change") rows.sort((a, b) => (b.change.delta ?? -Infinity) - (a.change.delta ?? -Infinity) || a.keyword.localeCompare(b.keyword));
  return { total: rows.length, rows: rows.slice(opts.offset, opts.offset + opts.limit) };
}

export async function dashboard(orgId: string, project: ProjectRow, opts: { group?: string; from?: string; to?: string }) {
  const rows = await rankingRows(orgId, project, opts.group);
  const changes: Record<ChangeKind, number> = { improved: 0, declined: 0, unchanged: 0, entered: 0, dropped_out: 0, unavailable: 0 };
  for (const r of rows) changes[r.change.kind]++;
  const pages = new Map<string, { url: string; keywords: number; positionSum: number; best: number }>();
  for (const r of rows) {
    if (r.latest?.status !== "ranked" || !r.latest.ranking_url) continue;
    const p = pages.get(r.latest.ranking_url) ?? { url: r.latest.ranking_url, keywords: 0, positionSum: 0, best: Infinity };
    p.keywords++;
    p.positionSum += r.latest.position!;
    p.best = Math.min(p.best, r.latest.position!);
    pages.set(p.url, p);
  }
  const to = opts.to ?? todayIn(project.timezone);
  const from = opts.from ?? new Date(Date.parse(to) - 89 * 86_400_000).toISOString().slice(0, 10);
  const params: unknown[] = [orgId, project.id, ownDomain(project), from, to];
  let groupFilter = "";
  if (opts.group) { params.push(opts.group); groupFilter = `AND k.group_name = $${params.length}`; }
  const trend = await query<{ day: string; source: string; ranked_top10: number; conclusive: number; total: number }>(
    `SELECT to_char(o.observed_date, 'YYYY-MM-DD') AS day, o.source,
            COUNT(*) FILTER (WHERE o.status = 'ranked' AND o.position <= 10)::int AS ranked_top10,
            COUNT(*) FILTER (WHERE o.status IN ('ranked','not_in_results'))::int AS conclusive, COUNT(*)::int AS total
       FROM rank_observations o JOIN rank_keywords k ON k.id = o.keyword_id AND k.org_id = o.org_id
      WHERE o.org_id = $1 AND o.project_id = $2 AND o.subject_domain = $3 AND o.observed_date BETWEEN $4::date AND $5::date AND k.status <> 'removed' ${groupFilter}
      GROUP BY o.observed_date, o.source ORDER BY o.observed_date`,
    params,
  );
  const [lastImport, lastJob, usage] = await Promise.all([
    query("SELECT created_at, source_label, rows_accepted FROM rank_imports WHERE project_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 1", [project.id, orgId]),
    query("SELECT id, status, provider, keywords_total, keywords_done, keywords_failed, error, created_at, finished_at FROM rank_collection_jobs WHERE project_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 1", [project.id, orgId]),
    usageToday(orgId),
  ]);
  return {
    keywords: { tracked: rows.length, active: rows.filter((r) => r.status === "active").length, paused: rows.filter((r) => r.status === "paused").length, withObservations: rows.filter((r) => r.latest).length },
    changes,
    distribution: distribution(rows.map((r) => (r.latest ? toObservation(r.latest) : null))),
    topPages: [...pages.values()].map((p) => ({ url: p.url, keywords: p.keywords, averagePosition: Math.round((p.positionSum / p.keywords) * 10) / 10, bestPosition: p.best })).sort((a, b) => b.keywords - a.keywords || a.averagePosition - b.averagePosition).slice(0, 10),
    top10Trend: trend.rows.map((t) => ({ day: t.day, source: t.source, share: t.conclusive ? Math.round((t.ranked_top10 / t.conclusive) * 1000) / 10 : null, top10: t.ranked_top10, conclusive: t.conclusive, excluded: t.total - t.conclusive })),
    range: { from, to },
    activity: { lastImport: lastImport.rows[0] ?? null, lastJob: lastJob.rows[0] ?? null, usageToday: usage },
  };
}

export async function keywordHistory(orgId: string, projectId: string, keywordId: string, opts: { from?: string; to?: string }) {
  const k = await query<{ id: string; keyword: string }>("SELECT id, keyword FROM rank_keywords WHERE id = $1 AND project_id = $2 AND org_id = $3", [keywordId, projectId, orgId]);
  if (!k.rows[0]) throw new RankError(404, "NOT_FOUND", "Keyword not found");
  const { rows } = await query<ObsRow>(
    `SELECT ${OBS_COLS} FROM rank_observations o WHERE o.org_id = $1 AND o.project_id = $2 AND o.keyword_id = $3
        AND o.observed_date BETWEEN COALESCE($4::date, '2000-01-01') AND COALESCE($5::date, '9999-12-31')
      ORDER BY o.observed_date, o.subject_domain LIMIT 5000`,
    [orgId, projectId, keywordId, opts.from ?? null, opts.to ?? null],
  );
  return { keyword: k.rows[0], observations: rows };
}

/** Feature presence vs ownership for each keyword's latest own observation. */
export async function serpFeatures(orgId: string, project: ProjectRow) {
  const rows = await rankingRows(orgId, project);
  const summary = new Map<string, { feature: string; present: number; owned: number; keywords: Array<{ keyword: string; owned: boolean }> }>();
  let withFeatureData = 0;
  for (const r of rows) {
    if (!r.latest || !(r.latest.status === "ranked" || r.latest.status === "not_in_results")) continue;
    if (r.latest.serp_features.length) withFeatureData++;
    for (const f of r.latest.serp_features) {
      const s = summary.get(f) ?? { feature: f, present: 0, owned: 0, keywords: [] };
      const owned = r.latest.owned_features.includes(f);
      s.present++;
      if (owned) s.owned++;
      if (s.keywords.length < 50) s.keywords.push({ keyword: r.keyword, owned });
      summary.set(f, s);
    }
  }
  return { keywordsObserved: rows.filter((r) => r.latest).length, keywordsWithFeatureData: withFeatureData, features: [...summary.values()].sort((a, b) => b.present - a.present) };
}

export async function competitorComparison(orgId: string, project: ProjectRow, competitor?: string) {
  const competitors = (await listCompetitors(orgId, project.id)).map((c) => c.domain).filter((d) => !competitor || d === competitor);
  if (!competitors.length) throw new RankError(422, "NO_COMPETITORS", competitor ? "That domain is not a competitor of this project." : "Add a competitor to this project first.");
  const own = await recentHistory(orgId, project.id, ownDomain(project));
  const { rows: kws } = await query<{ id: string; keyword: string }>("SELECT id, keyword FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status <> 'removed' ORDER BY keyword_key", [project.id, orgId]);
  const out = [];
  for (const c of competitors) {
    const theirs = await recentHistory(orgId, project.id, c);
    const counts = { both_ranked: 0, own_only: 0, competitor_only: 0, neither: 0, not_comparable: 0, ownAhead: 0, competitorAhead: 0 };
    const keywords = kws.map((k) => {
      const ownH = (own.get(k.id) ?? []).map(toObservation);
      const compH = (theirs.get(k.id) ?? []).map(toObservation);
      // Latest day with conclusive observations of both sites from the same source.
      const ownCur = ownH.find((o) => compH.some((x) => x.observedDate === o.observedDate && x.source === o.source && (x.status === "ranked" || x.status === "not_in_results")) && (o.status === "ranked" || o.status === "not_in_results")) ?? null;
      const compCur = ownCur ? compH.find((x) => x.observedDate === ownCur.observedDate && x.source === ownCur.source) ?? null : null;
      const cmp = compareWithCompetitor(ownCur, compCur);
      counts[cmp.relation]++;
      if (cmp.ahead === "own") counts.ownAhead++;
      if (cmp.ahead === "competitor") counts.competitorAhead++;
      const compLatest = compH[0] ?? null;
      const compPrev = compLatest ? previousComparable(compH, compLatest) : null;
      return {
        keywordId: k.id,
        keyword: k.keyword,
        date: ownCur?.observedDate ?? null,
        relation: cmp.relation,
        ahead: cmp.ahead,
        reason: cmp.reason,
        own: ownCur ? { position: ownCur.position, status: ownCur.status, url: ownCur.rankingUrl, ownedFeatures: ownCur.ownedFeatures } : null,
        competitor: compCur ? { position: compCur.position, status: compCur.status, url: compCur.rankingUrl, ownedFeatures: compCur.ownedFeatures } : null,
        competitorMovement: classifyChange(compPrev, compLatest),
      };
    });
    out.push({ competitor: c, counts, keywords });
  }
  return { competitors: out, note: "Compared only on the same day and from the same source. Missing data on either side is 'not comparable', never read as one site outranking the other." };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export async function exportCsv(orgId: string, project: ProjectRow, kind: "rankings" | "history" | "keywords") {
  if (kind === "keywords") {
    const { rows } = await query("SELECT keyword, group_name, landing_page, status, source, created_at FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status <> 'removed' ORDER BY keyword_key", [project.id, orgId]);
    return toCsv(rows as Array<Record<string, unknown>>, ["keyword", "group_name", "landing_page", "status", "source", "created_at"]);
  }
  if (kind === "rankings") {
    const rows = await rankingRows(orgId, project);
    return toCsv(rows.map((r) => ({ keyword: r.keyword, group: r.group, date: r.latest?.observed_date, status: r.latest?.status, position: r.latest?.position, depth: r.latest?.result_depth, url: r.latest?.ranking_url, previous_date: r.previous?.observed_date, previous_position: r.previous?.position, change: r.change.kind, delta: r.change.delta, source: r.latest?.source_label })),
      ["keyword", "group", "date", "status", "position", "depth", "url", "previous_date", "previous_position", "change", "delta", "source"]);
  }
  const { rows } = await query(
    `SELECT k.keyword, o.subject_domain, to_char(o.observed_date, 'YYYY-MM-DD') AS date, o.status, o.position, o.result_depth, o.ranking_url, array_to_string(o.serp_features, ';') AS serp_features,
            array_to_string(o.owned_features, ';') AS owned_features, o.source_label FROM rank_observations o JOIN rank_keywords k ON k.id = o.keyword_id AND k.org_id = o.org_id
      WHERE o.org_id = $1 AND o.project_id = $2 ORDER BY k.keyword_key, o.observed_date, o.subject_domain LIMIT 200000`,
    [orgId, project.id],
  );
  return toCsv(rows as Array<Record<string, unknown>>, ["keyword", "subject_domain", "date", "status", "position", "result_depth", "ranking_url", "serp_features", "owned_features", "source_label"]);
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export interface AlertRuleInput {
  type: RuleType;
  params: AlertRule["params"];
  keywordId?: string | null;
  notify: "in_app" | "none";
}

export async function createAlertRule(orgId: string, project: ProjectRow, actorId: string, input: AlertRuleInput) {
  if (input.type === "competitor_overtake") {
    const d = input.params.competitor ? normalizeDomain(input.params.competitor) : null;
    if (!d || !(await listCompetitors(orgId, project.id)).some((c) => c.domain === d)) throw new RankError(400, "VALIDATION_ERROR", "competitor_overtake needs one of the project's competitors.");
    input.params.competitor = d;
  }
  if (input.keywordId) {
    const k = await query("SELECT 1 FROM rank_keywords WHERE id = $1 AND project_id = $2 AND org_id = $3", [input.keywordId, project.id, orgId]);
    if (!k.rows[0]) throw new RankError(404, "NOT_FOUND", "Keyword not found");
  }
  const { rows } = await query(
    "INSERT INTO rank_alert_rules (org_id, project_id, rule_type, params, keyword_id, notify, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, rule_type, params, keyword_id, enabled, notify, created_at",
    [orgId, project.id, input.type, JSON.stringify(input.params), input.keywordId ?? null, input.notify, actorId],
  );
  await evaluateAlerts(orgId, project.id);
  return rows[0];
}

export async function listAlertRules(orgId: string, projectId: string) {
  const { rows } = await query("SELECT id, rule_type, params, keyword_id, enabled, notify, created_at FROM rank_alert_rules WHERE project_id = $1 AND org_id = $2 ORDER BY created_at", [projectId, orgId]);
  return rows;
}

export async function setAlertRule(orgId: string, projectId: string, ruleId: string, patch: { enabled?: boolean; notify?: "in_app" | "none" }) {
  const { rowCount } = await query("UPDATE rank_alert_rules SET enabled = COALESCE($4, enabled), notify = COALESCE($5, notify) WHERE id = $1 AND project_id = $2 AND org_id = $3", [ruleId, projectId, orgId, patch.enabled ?? null, patch.notify ?? null]);
  if (!rowCount) throw new RankError(404, "NOT_FOUND", "Alert rule not found");
}

export async function listAlertEvents(orgId: string, projectId: string, opts: { unacknowledged?: boolean; limit: number; cursor?: string }) {
  const params: unknown[] = [orgId, projectId];
  const where = ["e.org_id = $1", "e.project_id = $2"];
  if (opts.unacknowledged) where.push("e.acknowledged_at IS NULL");
  if (opts.cursor) {
    const c = decodeCursor<{ t: string; id: string }>(opts.cursor, (x) => typeof x.t === "string" && typeof x.id === "string");
    params.push(c.t, c.id);
    where.push(`(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<{ id: string; created_at: Date }>(
    `SELECT e.id, e.rule_id, r.rule_type, e.keyword_id, k.keyword, e.message, e.evidence, e.observation_id, e.created_at, e.acknowledged_at
       FROM rank_alert_events e JOIN rank_alert_rules r ON r.id = e.rule_id AND r.org_id = e.org_id JOIN rank_keywords k ON k.id = e.keyword_id AND k.org_id = e.org_id
      WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return { events: page, nextCursor: more && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function acknowledgeAlert(orgId: string, projectId: string, eventId: string, actorId: string) {
  const { rowCount } = await query("UPDATE rank_alert_events SET acknowledged_at = NOW(), acknowledged_by = $4 WHERE id = $1 AND project_id = $2 AND org_id = $3 AND acknowledged_at IS NULL", [eventId, projectId, orgId, actorId]);
  return { acknowledged: (rowCount ?? 0) > 0 };
}

/**
 * Evaluates every enabled in-app rule of a project against the stored
 * observations. Each event names its triggering observation, so repeated
 * evaluation (after every import or job) never duplicates an alert.
 */
export async function evaluateAlerts(orgId: string, projectId: string): Promise<number> {
  const { rows: rules } = await query<{ id: string; rule_type: RuleType; params: AlertRule["params"]; keyword_id: string | null }>(
    "SELECT id, rule_type, params, keyword_id FROM rank_alert_rules WHERE project_id = $1 AND org_id = $2 AND enabled AND notify = 'in_app'",
    [projectId, orgId],
  );
  if (!rules.length) return 0;
  const project = await requireProject(orgId, projectId);
  const { rows: kws } = await query<{ id: string; keyword: string }>("SELECT id, keyword FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status = 'active'", [projectId, orgId]);
  const own = await recentHistory(orgId, projectId, ownDomain(project));
  const compCache = new Map<string, Map<string, ObsRow[]>>();
  let created = 0;
  for (const rule of rules) {
    let comp: Map<string, ObsRow[]> | undefined;
    if (rule.rule_type === "competitor_overtake" && rule.params.competitor) {
      if (!compCache.has(rule.params.competitor)) compCache.set(rule.params.competitor, await recentHistory(orgId, projectId, rule.params.competitor));
      comp = compCache.get(rule.params.competitor);
    }
    for (const k of kws) {
      if (rule.keyword_id && rule.keyword_id !== k.id) continue;
      const ev = evaluateRule({ id: rule.id, type: rule.rule_type, params: rule.params }, k.keyword, (own.get(k.id) ?? []).map(toObservation), (comp?.get(k.id) ?? []).map(toObservation));
      if (!ev) continue;
      const r = await query(
        `INSERT INTO rank_alert_events (org_id, project_id, rule_id, keyword_id, event_key, observation_id, message, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ON CONSTRAINT rank_alert_events_unique DO NOTHING`,
        [orgId, projectId, rule.id, k.id, ev.eventKey, ev.observationId, ev.message.slice(0, 500), JSON.stringify(ev.evidence)],
      );
      created += r.rowCount ?? 0;
    }
  }
  return created;
}

// ─── Provider collection jobs ────────────────────────────────────────────────

export async function usageToday(orgId: string) {
  const { rows } = await query<{ provider: string; requests: number; failures: number }>("SELECT provider, requests, failures FROM rank_provider_usage WHERE org_id = $1 AND day = CURRENT_DATE", [orgId]);
  return { day: new Date().toISOString().slice(0, 10), limit: config.RANK_MAX_REQUESTS_PER_ORG_PER_DAY, used: rows.reduce((s, r) => s + r.requests, 0), byProvider: rows };
}

/** Manual refresh: needs a configured provider and enough daily quota; one active job per project. */
export async function requestRefresh(orgId: string, project: ProjectRow, actorId: string, trigger: "manual" | "scheduled" = "manual") {
  if (project.status !== "active") throw new RankError(409, "PROJECT_NOT_ACTIVE", "Resume the project before refreshing.");
  let provider: SerpProvider;
  try {
    provider = resolveRankProvider();
  } catch (err) {
    const e = err as RankProviderError;
    throw new RankError(e.statusCode, e.code, e.message);
  }
  assertTrackable({ frequency: "daily", searchEngine: project.search_engine, country: project.country, language: project.language, device: project.device, location: project.location });
  const { rows: kc } = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rank_keywords WHERE project_id = $1 AND org_id = $2 AND status = 'active'", [project.id, orgId]);
  if (!kc[0].n) throw new RankError(422, "NO_KEYWORDS", "Add active keywords before refreshing.");
  const usage = await usageToday(orgId);
  if (usage.used + kc[0].n > usage.limit) {
    throw new RankError(429, "QUOTA_EXCEEDED", `This refresh needs ${kc[0].n} requests; ${usage.limit - usage.used} of today's ${usage.limit} remain.`, { needed: kc[0].n, used: usage.used, limit: usage.limit });
  }
  try {
    const { rows } = await query(
      `INSERT INTO rank_collection_jobs (org_id, project_id, provider, trigger, observed_date, keywords_total, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, status, provider, trigger, observed_date, keywords_total, keywords_done, keywords_failed, created_at`,
      [orgId, project.id, provider.info.id, trigger, todayIn(project.timezone), kc[0].n, trigger === "manual" ? actorId : null],
    );
    return { job: rows[0], deduplicated: false };
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const { rows } = await query("SELECT id, status, provider, trigger, observed_date, keywords_total, keywords_done, keywords_failed, created_at FROM rank_collection_jobs WHERE project_id = $1 AND org_id = $2 AND status IN ('queued','running')", [project.id, orgId]);
    if (!rows[0]) throw new RankError(409, "ALREADY_COLLECTED", "Today's scheduled collection already ran.");
    return { job: rows[0], deduplicated: true };
  }
}

export async function listJobs(orgId: string, projectId: string) {
  const { rows } = await query(
    "SELECT id, status, provider, trigger, to_char(observed_date, 'YYYY-MM-DD') AS observed_date, keywords_total, keywords_done, keywords_failed, claims, error, created_at, started_at, finished_at FROM rank_collection_jobs WHERE project_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 50",
    [projectId, orgId],
  );
  return rows;
}

export async function cancelJob(orgId: string, projectId: string, jobId: string) {
  const { rowCount } = await query("UPDATE rank_collection_jobs SET status = 'cancelled', finished_at = NOW(), lease_owner = NULL WHERE id = $1 AND project_id = $2 AND org_id = $3 AND status IN ('queued','running')", [jobId, projectId, orgId]);
  return { cancelled: (rowCount ?? 0) > 0 };
}

/** Queues today's scheduled collection for due projects (idempotent: one scheduled job per project and day). */
export async function scheduleDueRankJobs(): Promise<number> {
  try {
    resolveRankProvider();
  } catch {
    return 0; // nothing can collect
  }
  const { rows } = await query<{ id: string; org_id: string }>(
    `SELECT p.id, p.org_id FROM rank_projects p
      WHERE p.status = 'active' AND p.frequency IN ('daily','weekly')
        AND NOT EXISTS (SELECT 1 FROM rank_collection_jobs j WHERE j.project_id = p.id AND j.status IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM rank_collection_jobs j WHERE j.project_id = p.id AND j.trigger = 'scheduled'
                         AND j.created_at > NOW() - CASE WHEN p.frequency = 'daily' THEN interval '20 hours' ELSE interval '6 days 20 hours' END)
      LIMIT 50`,
  );
  let queued = 0;
  for (const r of rows) {
    try {
      const project = await requireProject(r.org_id, r.id);
      const out = await requestRefresh(r.org_id, project, "", "scheduled");
      if (!out.deduplicated) queued++;
    } catch {
      /* quota, no keywords or already collected today: skipped, retried next tick */
    }
  }
  return queued;
}

const LEASE_SECONDS = 120;
const MAX_CLAIMS = 8;
const SLICE_KEYWORDS = 25;
const backoffSeconds = (claims: number) => Math.min(3600, 30 * 2 ** Math.max(0, claims - 1));

interface ClaimedRankJob { id: string; org_id: string; project_id: string; provider: string; observed_date: string; keywords_total: number; keywords_done: number; keywords_failed: number; claims: number; created_at: Date }

async function claimRankJob(owner: string): Promise<ClaimedRankJob | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<ClaimedRankJob>(
      `SELECT id, org_id, project_id, provider, to_char(observed_date, 'YYYY-MM-DD') AS observed_date, keywords_total, keywords_done, keywords_failed, claims, created_at
         FROM rank_collection_jobs WHERE (status = 'queued' AND next_attempt_at <= NOW()) OR (status = 'running' AND lease_until < NOW())
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const job = rows[0];
    if (!job) return null;
    await tx.query("UPDATE rank_collection_jobs SET status = 'running', lease_owner = $2, lease_until = NOW() + make_interval(secs => $3), claims = claims + 1, started_at = COALESCE(started_at, NOW()) WHERE id = $1", [job.id, owner, LEASE_SECONDS]);
    return { ...job, claims: job.claims + 1 };
  });
}

async function recordUsage(orgId: string, provider: string, failed: boolean) {
  await query(
    `INSERT INTO rank_provider_usage (org_id, provider, day, requests, failures) VALUES ($1,$2,CURRENT_DATE,1,$3)
     ON CONFLICT (org_id, provider, day) DO UPDATE SET requests = rank_provider_usage.requests + 1, failures = rank_provider_usage.failures + EXCLUDED.failures`,
    [orgId, provider, failed ? 1 : 0],
  );
}

/**
 * One bounded slice of a collection job. Idempotent: keywords that already
 * have an own observation from this provider for the job's day (other than
 * a failure) are skipped. A transient provider error ends the slice and
 * re-queues the job with exponential backoff; after MAX_CLAIMS the remaining
 * keywords are recorded as failed collections (never as ranking losses).
 */
export async function runRankSlice(providerOverride?: SerpProvider, budgetMs = 20_000): Promise<"idle" | "progress" | "finished"> {
  const owner = randomUUID();
  const job = await claimRankJob(owner);
  if (!job) return "idle";
  const finish = async (status: "completed" | "partial" | "failed" | "queued", error: string | null, retryInSeconds = 0, done = 0, failed = 0) => {
    await query(
      `UPDATE rank_collection_jobs SET keywords_done = keywords_done + $3, keywords_failed = keywords_failed + $4, status = $5, error = $6,
              next_attempt_at = NOW() + make_interval(secs => $7), lease_owner = NULL, lease_until = NULL,
              finished_at = CASE WHEN $5 IN ('completed','partial','failed') THEN NOW() END
        WHERE id = $1 AND lease_owner = $2`,
      [job.id, owner, done, failed, status, error, retryInSeconds],
    );
  };
  let provider: SerpProvider;
  try {
    provider = providerOverride ?? resolveRankProvider();
  } catch (err) {
    await finish("failed", (err as Error).message.slice(0, 500));
    return "finished";
  }
  const project = await getProject(job.org_id, job.project_id);
  if (!project || project.status !== "active") {
    await finish("failed", "The project is no longer active.");
    return "finished";
  }
  const own = ownDomain(project);
  const competitors = (await listCompetitors(job.org_id, project.id)).map((c) => c.domain);
  const { rows: pending } = await query<{ id: string; keyword: string }>(
    `SELECT k.id, k.keyword FROM rank_keywords k
      WHERE k.project_id = $1 AND k.org_id = $2 AND k.status = 'active'
        -- Done for this job: a real observation today, or a failure already recorded by this job (a later job retries it).
        AND NOT EXISTS (SELECT 1 FROM rank_observations o WHERE o.keyword_id = k.id AND o.subject_domain = $3 AND o.observed_date = $4::date AND o.source = $5
                          AND (o.status <> 'failed' OR o.job_id = $7))
      ORDER BY k.keyword_key LIMIT $6`,
    [project.id, job.org_id, own, job.observed_date, provider.info.id, SLICE_KEYWORDS, job.id],
  );
  if (!pending.length) {
    await finish(job.keywords_failed > 0 ? "partial" : "completed", null);
    await evaluateAlerts(job.org_id, project.id);
    return "finished";
  }
  const deadline = Date.now() + budgetMs;
  let done = 0;
  let failed = 0;
  let transient: RankProviderError | null = null;
  const queue = [...pending];
  const worker = async () => {
    for (let k = queue.shift(); k && !transient; k = queue.shift()) {
      if (Date.now() > deadline) { queue.unshift(k); return; }
      const usage = await usageToday(job.org_id);
      if (usage.used >= usage.limit) { transient = new RankProviderError(429, "QUOTA_EXCEEDED", "The daily request quota is used up.", false); queue.unshift(k); return; }
      try {
        const res = await provider.fetchSerp({ keyword: k.keyword, searchEngine: project.search_engine, country: project.country, language: project.language, device: project.device, location: project.location, depth: provider.info.maxDepth }, AbortSignal.timeout(30_000));
        await recordUsage(job.org_id, provider.info.id, false);
        await storeSerp(job, project, provider, k.id, res, [own, ...competitors]);
        done++;
      } catch (err) {
        await recordUsage(job.org_id, provider.info.id, true);
        const e = err instanceof RankProviderError ? err : new RankProviderError(502, "PROVIDER_UNAVAILABLE", "The provider request failed.", true);
        if (e.retryable) { transient = e; queue.unshift(k); return; }
        await storeFailure(job, project, provider, k.id, e.code);
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.RANK_PROVIDER_CONCURRENCY, pending.length) }, worker));
  const t = transient as RankProviderError | null;
  if (t && t.code === "QUOTA_EXCEEDED") {
    await finish("partial", "Stopped: the daily request quota is used up. The remaining keywords were not collected.", 0, done, failed);
    await evaluateAlerts(job.org_id, project.id);
    return "finished";
  }
  if (t) {
    if (job.claims >= MAX_CLAIMS) {
      for (const k of queue) await storeFailure(job, project, provider, k.id, t.code);
      await finish("failed", `Gave up after ${job.claims} attempts: ${t.message}`.slice(0, 500), 0, done, failed + queue.length);
      await evaluateAlerts(job.org_id, project.id);
      return "finished";
    }
    await finish("queued", `Retrying: ${t.message}`.slice(0, 500), backoffSeconds(job.claims), done, failed);
    return "progress";
  }
  await finish("queued", null, 0, done, failed);
  return "progress";
}

async function storeSerp(job: ClaimedRankJob, project: ProjectRow, provider: SerpProvider, keywordId: string, res: SerpResponse, subjects: string[]) {
  for (const subject of subjects) {
    const hit = res.results
      .filter((r) => { const u = normalizeLinkUrl(r.url); if (!u) return false; const d = domainOf(u); return d === subject || d.endsWith(`.${subject}`); })
      .sort((a, b) => a.position - b.position)[0];
    const url = hit ? normalizeLinkUrl(hit.url) : null;
    // Ownership only when the provider attributes the feature to this subject's URL.
    const owned = res.features.filter((f) => (res.featureUrls[f] ?? []).some((u) => { const n = normalizeLinkUrl(u); if (!n) return false; const d = domainOf(n); return d === subject || d.endsWith(`.${subject}`); }));
    await query(
      `INSERT INTO rank_observations (org_id, project_id, keyword_id, subject_domain, observed_date, observed_at, status, position, result_depth, ranking_url, result_type,
         search_engine, country, language, device, serp_features, owned_features, source, source_label, job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT ON CONSTRAINT rank_observations_unique DO UPDATE SET status = EXCLUDED.status, position = EXCLUDED.position, result_depth = EXCLUDED.result_depth,
         ranking_url = EXCLUDED.ranking_url, result_type = EXCLUDED.result_type, serp_features = EXCLUDED.serp_features, owned_features = EXCLUDED.owned_features,
         observed_at = EXCLUDED.observed_at, job_id = EXCLUDED.job_id, error_code = NULL
         WHERE rank_observations.status = 'failed'`,
      [job.org_id, project.id, keywordId, subject, job.observed_date, res.observedAt, hit ? "ranked" : "not_in_results", hit?.position ?? null, res.depth, url, hit?.type?.slice(0, 40) ?? null,
        project.search_engine, project.country, project.language, project.device, res.features, owned, provider.info.id, provider.info.name.slice(0, 80), job.id],
    );
  }
}

async function storeFailure(job: ClaimedRankJob, project: ProjectRow, provider: SerpProvider, keywordId: string, code: string) {
  await query(
    `INSERT INTO rank_observations (org_id, project_id, keyword_id, subject_domain, observed_date, observed_at, status, search_engine, country, language, device, source, source_label, job_id, error_code)
     VALUES ($1,$2,$3,$4,$5,NOW(),'failed',$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT ON CONSTRAINT rank_observations_unique DO UPDATE SET job_id = EXCLUDED.job_id, error_code = EXCLUDED.error_code, observed_at = EXCLUDED.observed_at
       WHERE rank_observations.status = 'failed'`,
    [job.org_id, project.id, keywordId, ownDomain(project), job.observed_date, project.search_engine, project.country, project.language, project.device, provider.info.id, provider.info.name.slice(0, 80), job.id, code.slice(0, 60)],
  );
}

/** Worker tick entry: schedule due projects, then run at most one slice. */
export async function processRankTrackingTick(budgetMs = 20_000): Promise<void> {
  await scheduleDueRankJobs();
  await runRankSlice(undefined, budgetMs);
}
