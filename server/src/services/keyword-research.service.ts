import { createHash } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { config } from "../config.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import { brandTermsFromDomain, classifyGap, classifyIntent, compareSnapshots, normalizeKeyword, type GapDataset } from "../research/keywords.js";
import { resolveProvider } from "../research/providers/registry.js";
import { METRICS, ResearchError, type Capability, type KeywordResearchProvider, type KeywordRow, type MetricName, type ProviderContext, type ProviderResult, type Targeting } from "../research/providers/types.js";

/**
 * Keyword research runs: validated, quota-checked, cached (only as long as the
 * provider allows), executed with a timeout, and stored as tenant-scoped
 * snapshots with provenance. Unsupported capabilities and missing data are
 * errors or explicit "not returned" values, never zeros.
 */

export const RUN_KINDS = ["overview", "ideas", "related", "organic", "gap"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
const CAPABILITY: Record<RunKind, Capability> = {
  overview: "keyword_overview",
  ideas: "keyword_ideas",
  related: "related_keywords",
  organic: "organic_keywords",
  gap: "keyword_gap",
};
const IN_FLIGHT_REUSE_MS = 2 * 60_000;
export const MAX_COMPETITORS = 5;
export const MAX_OVERVIEW_KEYWORDS = 100;

export interface RunInput {
  keyword?: string;
  keywords?: string[];
  seed?: string;
  competitors?: string[];
}

export interface RunRequest {
  orgId: string;
  userId: string;
  websiteId: string;
  kind: RunKind;
  input: RunInput;
  targeting: Targeting;
  provider?: string;
  limit?: number;
}

const maxResults = () => config.KEYWORD_RESEARCH_MAX_RESULTS ?? 500;
const providerTimeout = () => config.KEYWORD_RESEARCH_PROVIDER_TIMEOUT_MS ?? 30_000;
const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "").replace(/^www\./, "");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ResearchError(504, "PROVIDER_UNAVAILABLE", "The data source did not answer in time; try again.")), ms);
    }),
  ]);
}

/** Only finite numbers for metrics the provider declares; everything else is "not returned". */
function cleanMetrics(provider: KeywordResearchProvider, metrics: KeywordRow["metrics"]): Partial<Record<MetricName, number>> {
  const out: Partial<Record<MetricName, number>> = {};
  for (const m of METRICS) {
    const v = metrics?.[m];
    if (provider.info.metrics.includes(m) && typeof v === "number" && Number.isFinite(v)) out[m] = v;
  }
  return out;
}

async function websiteFor(orgId: string, websiteId: string) {
  const { rows } = await query<{ id: string; domain: string }>("SELECT id, domain FROM websites WHERE id = $1 AND org_id = $2", [websiteId, orgId]);
  return rows[0] ?? null;
}

interface StoredRow {
  keyword_key: string;
  keyword: string;
  metrics: Partial<Record<MetricName, number>>;
  intent: string | null;
  intent_rule: string | null;
  gap_category?: string | null;
  absence_from_sample?: boolean | null;
  competitors_present?: number | null;
  observations?: unknown;
}

/** Run a research request. Returns null when the website is not in the organization. */
export async function runResearch(req: RunRequest) {
  const website = await websiteFor(req.orgId, req.websiteId);
  if (!website) return null;
  const provider = resolveProvider(CAPABILITY[req.kind], req.provider);
  const limit = Math.max(1, Math.min(req.limit ?? 100, maxResults()));
  const params = {
    keyword: req.input.keyword ? normalizeKeyword(req.input.keyword) : undefined,
    keywords: req.input.keywords ? [...new Set(req.input.keywords.map(normalizeKeyword))].sort() : undefined,
    seed: req.input.seed ? normalizeKeyword(req.input.seed) : undefined,
    competitors: req.input.competitors ? [...new Set(req.input.competitors.map(normalizeDomain))].sort() : undefined,
    targeting: req.targeting,
    limit,
  };
  const paramsHash = createHash("sha256").update(JSON.stringify({ kind: req.kind, provider: provider.info.id, websiteId: req.websiteId, params })).digest("hex");

  // Cache reuse, in-flight reuse and quota are decided under one per-org lock.
  const admitted = await withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`keyword-research:${req.orgId}`]);
    const { rows: prior } = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM research_runs
        WHERE org_id = $1 AND params_hash = $2
          AND ((status IN ('completed','partial') AND $3 AND created_at > NOW() - ($4 || ' minutes')::interval)
               OR (status = 'running' AND created_at > NOW() - ($5 || ' milliseconds')::interval))
        ORDER BY created_at DESC LIMIT 1`,
      [req.orgId, paramsHash, provider.info.caching.allowed, provider.info.caching.maxAgeMinutes, IN_FLIGHT_REUSE_MS],
    );
    if (prior[0]) return { runId: prior[0].id, reused: prior[0].status === "running" ? ("in_progress" as const) : ("cache" as const) };
    const { rows: used } = await tx.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id = $1 AND created_at > NOW() - interval '24 hours'", [req.orgId]);
    const quota = config.KEYWORD_RESEARCH_MAX_RUNS_PER_ORG_PER_DAY ?? 200;
    if (Number(used[0].n) >= quota) {
      throw new ResearchError(429, "QUOTA_EXCEEDED", `Your organization reached its limit of ${quota} research runs in 24 hours.`, { limit: quota });
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO research_runs (org_id, website_id, kind, provider, capability, params, params_hash, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
      [req.orgId, req.websiteId, req.kind, provider.info.id, CAPABILITY[req.kind], JSON.stringify(params), paramsHash, req.userId],
    );
    return { runId: rows[0].id, reused: null };
  });
  if (admitted.reused) return admitted;

  const runId = admitted.runId;
  const ctx: ProviderContext = { orgId: req.orgId, websiteId: req.websiteId, websiteDomain: website.domain, targeting: req.targeting, limit };
  const brand = brandTermsFromDomain(website.domain);
  try {
    let result: ProviderResult;
    let rows: StoredRow[];
    let summary: Record<string, unknown> = {};
    if (req.kind === "gap") {
      ({ result, rows, summary } = await runGap(provider, ctx, params.competitors ?? [], brand));
    } else {
      result = await withTimeout(callProvider(provider, req.kind, ctx, params), providerTimeout());
      const seen = new Set<string>();
      rows = [];
      for (const r of result.rows) {
        const key = normalizeKeyword(r.keyword ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const intent = classifyIntent(r.keyword, brand);
        rows.push({ keyword_key: key, keyword: r.keyword.trim().slice(0, 400), metrics: cleanMetrics(provider, r.metrics), intent: intent?.intent ?? null, intent_rule: intent?.rule ?? null });
        if (rows.length >= limit) break;
      }
    }
    await withTransaction(async (tx) => {
      if (rows.length) {
        await tx.query(
          `INSERT INTO research_results (run_id, org_id, seq, keyword_key, keyword, metrics, intent, intent_rule, gap_category, absence_from_sample, competitors_present, observations)
           SELECT $1, $2, x.seq, x.keyword_key, x.keyword, x.metrics, x.intent, x.intent_rule, x.gap_category, x.absence_from_sample, x.competitors_present, x.observations
             FROM jsonb_to_recordset($3::jsonb) AS x(seq int, keyword_key text, keyword text, metrics jsonb, intent text, intent_rule text,
                  gap_category text, absence_from_sample boolean, competitors_present int, observations jsonb)`,
          [runId, req.orgId, JSON.stringify(rows.map((r, seq) => ({ seq, ...r })))],
        );
      }
      await tx.query(
        `UPDATE research_runs SET status = $3, result_count = $4, sample = $5, observed_through = $6, notes = $7::jsonb, summary = $8::jsonb, finished_at = NOW()
          WHERE id = $1 AND org_id = $2`,
        [runId, req.orgId, result.partial ? "partial" : "completed", rows.length, result.sample, result.observedThrough, JSON.stringify(result.notes.slice(0, 20).map((n) => n.slice(0, 300))), JSON.stringify(summary)],
      );
    });
    return { runId, reused: null };
  } catch (err) {
    const known = err instanceof ResearchError;
    await query(
      "UPDATE research_runs SET status = 'failed', error_code = $3, error = $4, finished_at = NOW() WHERE id = $1 AND org_id = $2",
      [runId, req.orgId, known ? err.code : "PROVIDER_UNAVAILABLE", known ? err.message.slice(0, 500) : "The data source failed; try again."],
    );
    if (known) throw Object.assign(err, { runId });
    console.error(JSON.stringify({ event: "keyword_research_failed", runId, orgId: req.orgId, error: (err as Error).name }));
    throw Object.assign(new ResearchError(502, "PROVIDER_UNAVAILABLE", "The data source failed; try again."), { runId });
  }
}

function callProvider(provider: KeywordResearchProvider, kind: Exclude<RunKind, "gap">, ctx: ProviderContext, params: { keyword?: string; keywords?: string[]; seed?: string }): Promise<ProviderResult> {
  switch (kind) {
    case "overview":
      return provider.keywordOverview!(ctx, (params.keywords ?? [params.keyword!]).slice(0, MAX_OVERVIEW_KEYWORDS));
    case "ideas":
      return provider.keywordIdeas!(ctx, params.seed!);
    case "related":
      return provider.relatedKeywords!(ctx, params.keyword!);
    case "organic":
      return provider.organicKeywords!(ctx, null);
  }
}

/** Gap: the customer's organic keywords vs each competitor's, from the same provider. */
async function runGap(provider: KeywordResearchProvider, ctx: ProviderContext, competitors: string[], brand: string[]) {
  const own = await withTimeout(provider.organicKeywords!(ctx, null), providerTimeout());
  // Resolve competitor domains to websites of this organization (providers that
  // cover arbitrary domains simply ignore websiteId).
  const { rows: sites } = await query<{ id: string; domain: string }>("SELECT id, domain FROM websites WHERE org_id = $1", [ctx.orgId]);
  const byDomain = new Map(sites.map((s) => [normalizeDomain(s.domain), s.id]));
  const datasets: GapDataset[] = [];
  const unavailable: Array<{ domain: string; reason: string }> = [];
  for (const domain of competitors) {
    if (normalizeDomain(ctx.websiteDomain) === domain) {
      unavailable.push({ domain, reason: "This is the website being analysed." });
      continue;
    }
    try {
      const res = await withTimeout(provider.organicKeywords!(ctx, { domain, websiteId: byDomain.get(domain) }), providerTimeout());
      datasets.push({ id: domain, label: domain, role: "competitor", complete: !res.sample, observedAt: res.observedThrough, rows: res.rows.map((r) => ({ keyword: r.keyword, position: r.metrics.position ?? null, clicks: r.metrics.clicks ?? null, impressions: r.metrics.impressions ?? null })) });
    } catch (err) {
      if (!(err instanceof ResearchError)) throw err;
      unavailable.push({ domain, reason: err.message });
    }
  }
  if (datasets.length === 0) {
    throw new ResearchError(422, "COMPETITOR_DATA_UNAVAILABLE", "No competitor data is available for the domains given.", { unavailable });
  }
  const customer: GapDataset = {
    id: normalizeDomain(ctx.websiteDomain), label: ctx.websiteDomain, role: "customer", complete: !own.sample, observedAt: own.observedThrough,
    rows: own.rows.map((r) => ({ keyword: r.keyword, position: r.metrics.position ?? null, clicks: r.metrics.clicks ?? null, impressions: r.metrics.impressions ?? null })),
  };
  const gap = classifyGap(customer, datasets);
  const rows: StoredRow[] = gap.rows.slice(0, maxResults()).map((r) => {
    const intent = classifyIntent(r.keyword, brand);
    const mine = r.observations[customer.id];
    return {
      keyword_key: r.key,
      keyword: r.keyword.slice(0, 400),
      metrics: cleanMetrics(provider, { position: mine?.position ?? undefined, clicks: mine?.clicks ?? undefined, impressions: mine?.impressions ?? undefined } as KeywordRow["metrics"]),
      intent: intent?.intent ?? null,
      intent_rule: intent?.rule ?? null,
      gap_category: r.category,
      absence_from_sample: r.absenceFromSample,
      competitors_present: r.competitorsPresent,
      observations: r.observations,
    };
  });
  const notes = [
    ...own.notes,
    "Shared: observed for you and at least one competitor. Missing: observed for a competitor, not for you. Unique: observed for you, for no competitor.",
    ...(own.sample ? ["Every dataset is a sample, so \"missing\" and \"unique\" mean \"not observed\", not \"absent\"."] : []),
    ...unavailable.map((u) => `No data for ${u.domain}: ${u.reason}`),
  ];
  return {
    result: { rows: [], sample: own.sample || datasets.some((d) => !d.complete), partial: unavailable.length > 0 || gap.rows.length > rows.length, observedThrough: own.observedThrough, notes },
    rows,
    summary: { counts: gap.counts, datasets: gap.datasets, unavailable, truncatedTo: gap.rows.length > rows.length ? rows.length : null },
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const RUN_COLUMNS = `id, website_id, kind, provider, capability, params, status, result_count, sample, to_char(observed_through,'YYYY-MM-DD') AS observed_through,
  notes, summary, error_code, error, requested_by, created_at, finished_at`;

export async function listRuns(orgId: string, filters: { websiteId?: string; kind?: RunKind }, page: { limit: number; cursor?: string }) {
  const params: unknown[] = [orgId];
  const where = ["org_id = $1"];
  if (filters.websiteId) { params.push(filters.websiteId); where.push(`website_id = $${params.length}`); }
  if (filters.kind) { params.push(filters.kind); where.push(`kind = $${params.length}`); }
  if (page.cursor) {
    const c = decodeCursor<{ t: string; i: string }>(page.cursor, (v) => typeof v.t === "string" && !Number.isNaN(Date.parse(v.t)) && /^[0-9a-f-]{36}$/i.test(String(v.i)));
    params.push(c.t, c.i);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(page.limit + 1);
  const { rows } = await query<{ id: string; created_at: Date }>(`SELECT ${RUN_COLUMNS} FROM research_runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const more = rows.length > page.limit;
  const data = more ? rows.slice(0, page.limit) : rows;
  const last = data[data.length - 1];
  return { runs: data, nextCursor: more && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id }) : null };
}

export interface RunRow {
  id: string;
  website_id: string;
  kind: RunKind;
  provider: string;
  capability: string;
  params: Record<string, unknown>;
  status: "running" | "completed" | "partial" | "failed";
  result_count: number;
  sample: boolean;
  observed_through: string | null;
  notes: string[];
  summary: Record<string, unknown>;
  error_code: string | null;
  error: string | null;
  requested_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export async function getRunRow(orgId: string, runId: string): Promise<RunRow | null> {
  const { rows } = await query<RunRow>(`SELECT ${RUN_COLUMNS} FROM research_runs WHERE id = $1 AND org_id = $2`, [runId, orgId]);
  return rows[0] ?? null;
}

export const RESULT_SORTS = ["seq", "keyword", "clicks", "impressions", "ctr", "position", "search_volume", "keyword_difficulty", "cpc", "competition"] as const;
export type ResultSort = (typeof RESULT_SORTS)[number];

export async function listResults(
  orgId: string,
  runId: string,
  opts: { sort: ResultSort; order: "asc" | "desc"; intent?: string; gapCategory?: string; search?: string; limit: number; cursor?: string },
) {
  const params: unknown[] = [orgId, runId];
  const where = ["org_id = $1", "run_id = $2"];
  if (opts.intent === "unclassified") where.push("intent IS NULL");
  else if (opts.intent) { params.push(opts.intent); where.push(`intent = $${params.length}`); }
  if (opts.gapCategory) { params.push(opts.gapCategory); where.push(`gap_category = $${params.length}`); }
  if (opts.search) { params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`keyword ILIKE $${params.length}`); }
  // Not-returned metrics sort last in either direction.
  const value = opts.sort === "seq" ? "seq::float8" : opts.sort === "keyword" ? "keyword_key" : `COALESCE((metrics->>'${opts.sort}')::float8, ${opts.order === "desc" ? "'-Infinity'" : "'Infinity'"}::float8)`;
  const dir = opts.order === "desc" ? "DESC" : "ASC";
  if (opts.cursor) {
    const c = decodeCursor<{ v: number | string; s: number; k: string; o: string }>(opts.cursor, (x) => Number.isInteger(x.s) && x.k === opts.sort && x.o === opts.order && (typeof x.v === "number" || (typeof x.v === "string" && (opts.sort === "keyword" || x.v === "Infinity" || x.v === "-Infinity"))));
    params.push(c.v, c.s);
    const cast = opts.sort === "keyword" ? "::text" : "::float8";
    where.push(`(${value} ${opts.order === "desc" ? "<" : ">"} $${params.length - 1}${cast} OR (${value} = $${params.length - 1}${cast} AND seq > $${params.length}::int))`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<{ seq: number; sort_value: number | string }>(
    `SELECT seq, keyword_key, keyword, metrics, intent, intent_rule, gap_category, absence_from_sample, competitors_present, observations, ${value} AS sort_value
       FROM research_results WHERE ${where.join(" AND ")} ORDER BY ${value} ${dir}, seq ASC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const data = (more ? rows.slice(0, opts.limit) : rows).map(({ sort_value: _v, ...r }) => r);
  const last = more ? rows[opts.limit - 1] : null;
  // The ±Infinity "not returned" sentinel has no JSON form; carry it as text (PostgreSQL casts 'Infinity'::float8).
  const toNumber = (v: number | string) => {
    if (opts.sort === "keyword") return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : n > 0 ? "Infinity" : "-Infinity";
  };
  return {
    results: data,
    nextCursor: last ? encodeCursor({ v: toNumber(last.sort_value), s: last.seq, k: opts.sort, o: opts.order }) : null,
  };
}

/** All rows of a run, for export and comparison (bounded by the per-run maximum). */
export async function allResults(orgId: string, runId: string) {
  const { rows } = await query<StoredRow & { seq: number }>(
    "SELECT seq, keyword_key, keyword, metrics, intent, intent_rule, gap_category, absence_from_sample, competitors_present FROM research_results WHERE org_id = $1 AND run_id = $2 ORDER BY seq",
    [orgId, runId],
  );
  return rows;
}

export async function compareRuns(orgId: string, runId: string, otherId: string) {
  const [a, b] = await Promise.all([getRunRow(orgId, otherId), getRunRow(orgId, runId)]);
  if (!a || !b) return null;
  if (a.website_id !== b.website_id || a.kind !== b.kind) {
    throw new ResearchError(422, "CAPABILITY_UNSUPPORTED", "Only runs of the same kind for the same website can be compared.");
  }
  const [older, newer] = new Date(a.created_at) <= new Date(b.created_at) ? [a, b] : [b, a];
  const [ro, rn] = await Promise.all([allResults(orgId, older.id), allResults(orgId, newer.id)]);
  const diff = compareSnapshots(
    ro.map((r) => ({ key: r.keyword_key, metrics: r.metrics })),
    rn.map((r) => ({ key: r.keyword_key, metrics: r.metrics })),
  );
  return { older: { id: older.id, createdAt: older.created_at, observedThrough: older.observed_through }, newer: { id: newer.id, createdAt: newer.created_at, observedThrough: newer.observed_through }, ...diff };
}

/** CSV with formula-injection protection (cells starting with = + - @ tab CR are prefixed with '). */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export async function exportRunCsv(orgId: string, runId: string) {
  const run = await getRunRow(orgId, runId);
  if (!run) return null;
  const rows = await allResults(orgId, runId);
  const metricCols = METRICS.filter((m) => rows.some((r) => r.metrics?.[m] !== undefined));
  const flat = rows.map((r) => ({
    keyword: r.keyword,
    ...Object.fromEntries(metricCols.map((m) => [m, r.metrics?.[m] ?? ""])),
    intent: r.intent ?? "",
    intent_source: r.intent ? "rule-based" : "",
    gap_category: r.gap_category ?? "",
    not_observed_in_sample: r.absence_from_sample ?? "",
    source: run.provider,
    observed_through: run.observed_through ?? "",
  }));
  const columns = ["keyword", ...metricCols, "intent", "intent_source", ...(run.kind === "gap" ? ["gap_category", "not_observed_in_sample"] : []), "source", "observed_through"];
  return { run, csv: toCsv(flat, columns) };
}

// ─── Saved lists ─────────────────────────────────────────────────────────────

export const MAX_LIST_ITEMS = 1_000;

export async function listKeywordLists(orgId: string) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.created_at, COUNT(i.keyword_key)::int AS items
       FROM keyword_lists l LEFT JOIN keyword_list_items i ON i.list_id = l.id AND i.org_id = l.org_id
      WHERE l.org_id = $1 GROUP BY l.id ORDER BY l.created_at DESC, l.id`,
    [orgId],
  );
  return rows;
}

export async function createKeywordList(orgId: string, userId: string, name: string) {
  try {
    const { rows } = await query("INSERT INTO keyword_lists (org_id, name, created_by) VALUES ($1,$2,$3) RETURNING id, name, created_at", [orgId, name, userId]);
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new ResearchError(409, "LIST_CONFLICT", "A list with this name already exists.");
    throw err;
  }
}

export async function getKeywordList(orgId: string, listId: string) {
  const { rows } = await query("SELECT id, name, created_at FROM keyword_lists WHERE id = $1 AND org_id = $2", [listId, orgId]);
  if (!rows[0]) return null;
  const { rows: items } = await query(
    "SELECT keyword_key, keyword, source_run_id, added_at FROM keyword_list_items WHERE list_id = $1 AND org_id = $2 ORDER BY added_at DESC, keyword_key LIMIT $3",
    [listId, orgId, MAX_LIST_ITEMS],
  );
  return { ...rows[0], items };
}

/** Add keywords from a run of this organization; unknown keys are ignored, duplicates are no-ops. */
export async function addListItems(orgId: string, userId: string, listId: string, runId: string, keys: string[]) {
  return withTransaction(async (tx) => {
    const { rows: list } = await tx.query("SELECT id FROM keyword_lists WHERE id = $1 AND org_id = $2 FOR UPDATE", [listId, orgId]);
    if (!list[0]) return null;
    const { rows: run } = await tx.query("SELECT id FROM research_runs WHERE id = $1 AND org_id = $2", [runId, orgId]);
    if (!run[0]) return null;
    const { rows: count } = await tx.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM keyword_list_items WHERE list_id = $1", [listId]);
    const room = MAX_LIST_ITEMS - Number(count[0].n);
    if (room <= 0) throw new ResearchError(409, "LIST_FULL", `A list holds at most ${MAX_LIST_ITEMS} keywords.`);
    const { rows } = await tx.query<{ keyword_key: string }>(
      `INSERT INTO keyword_list_items (list_id, org_id, keyword_key, keyword, source_run_id, added_by)
       SELECT $1, $2, r.keyword_key, r.keyword, r.run_id, $5 FROM research_results r
        WHERE r.org_id = $2 AND r.run_id = $3 AND r.keyword_key = ANY($4::text[])
        ORDER BY r.seq LIMIT $6
       ON CONFLICT (list_id, keyword_key) DO NOTHING RETURNING keyword_key`,
      [listId, orgId, runId, keys.map(normalizeKeyword), userId, room],
    );
    return { added: rows.length };
  });
}

export async function removeListItem(orgId: string, listId: string, key: string) {
  const { rowCount } = await query("DELETE FROM keyword_list_items WHERE list_id = $1 AND org_id = $2 AND keyword_key = $3", [listId, orgId, normalizeKeyword(key)]);
  return (rowCount ?? 0) > 0;
}

export async function deleteKeywordList(orgId: string, listId: string) {
  const { rowCount } = await query("DELETE FROM keyword_lists WHERE id = $1 AND org_id = $2", [listId, orgId]);
  return (rowCount ?? 0) > 0;
}

// ─── Retention ───────────────────────────────────────────────────────────────

let lastPrune = 0;
export async function pruneResearch(now = Date.now()) {
  if (now - lastPrune < 60 * 60_000) return 0;
  lastPrune = now;
  const { rowCount } = await query(
    "DELETE FROM research_runs WHERE id IN (SELECT id FROM research_runs WHERE created_at < NOW() - ($1 || ' days')::interval LIMIT 1000)",
    [config.KEYWORD_RESEARCH_RETENTION_DAYS ?? 400],
  );
  return rowCount ?? 0;
}
