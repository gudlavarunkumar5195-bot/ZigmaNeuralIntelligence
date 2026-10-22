import { query } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import { addDays, daysBetween, type DimensionSet } from "./search-console.service.js";

/**
 * Search performance read model, from persisted observations only.
 *
 * Day states (never conflated):
 * - complete:    fetched completely; a day with no row is a real zero for
 *                the property total;
 * - fresh:       fetched, but Google marked the day incomplete (may change);
 * - missing:     never fetched (sync not run, failed, or outside retention):
 *                metrics are null, not zero;
 * - not_returned: for a single query/page/country/device, Google returned no
 *                row that day. Google omits low-volume rows, so this is
 *                reported as unknown (null), not as zero.
 *
 * Range position is the impression-weighted average of daily positions, and
 * CTR is clicks / impressions over the range. Query/page sums can be lower
 * than the property total: Google drops rare and anonymized queries.
 */

export type BreakdownDimension = Exclude<DimensionSet, "total">;
export const BREAKDOWNS: BreakdownDimension[] = ["query", "page", "country", "device", "searchAppearance"];
export const MAX_RANGE_DAYS = 480;

export interface Metrics {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

interface DayRow {
  day: string;
  clicks: string;
  impressions: string;
  position: number;
}

function totals(rows: Array<{ clicks: number; impressions: number; position: number }>): Metrics {
  if (rows.length === 0) return { clicks: null, impressions: null, ctr: null, position: null };
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const weighted = rows.reduce((a, r) => a + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : null, position: impressions > 0 ? weighted / impressions : null };
}

export async function performance(input: { orgId: string; propertyId: string; from: string; to: string; filter?: { dimension: BreakdownDimension; value: string } }) {
  const set: DimensionSet = input.filter?.dimension ?? "total";
  const value = input.filter?.value ?? "";
  const [{ rows: coverage }, { rows: data }] = await Promise.all([
    query<{ day: string; outcome: string; data_state: string }>(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, outcome, data_state FROM gsc_coverage
        WHERE org_id = $1 AND property_id = $2 AND dimension_set = $3 AND day BETWEEN $4 AND $5`,
      [input.orgId, input.propertyId, set, input.from, input.to],
    ),
    query<DayRow>(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, clicks::text, impressions::text, position FROM gsc_search_daily
        WHERE org_id = $1 AND property_id = $2 AND dimension_set = $3 AND dim_value = $4 AND day BETWEEN $5 AND $6`,
      [input.orgId, input.propertyId, set, value, input.from, input.to],
    ),
  ]);
  const cov = new Map(coverage.map((c) => [c.day, c]));
  const byDay = new Map(data.map((d) => [d.day, { clicks: Number(d.clicks), impressions: Number(d.impressions), position: d.position }]));
  const series: Array<Metrics & { date: string; state: "complete" | "fresh" | "missing" | "not_returned" }> = [];
  const observed: Array<{ clicks: number; impressions: number; position: number }> = [];
  for (let day = input.from; day <= input.to; day = addDays(day, 1)) {
    const c = cov.get(day);
    const row = byDay.get(day);
    if (!c) {
      series.push({ date: day, state: "missing", clicks: null, impressions: null, ctr: null, position: null });
      continue;
    }
    const state = c.data_state === "fresh" ? "fresh" : "complete";
    if (row) {
      observed.push(row);
      series.push({ date: day, state, clicks: row.clicks, impressions: row.impressions, ctr: row.impressions > 0 ? row.clicks / row.impressions : 0, position: row.position });
    } else if (set === "total") {
      // Google omits days without any search data from a complete answer.
      observed.push({ clicks: 0, impressions: 0, position: 0 });
      series.push({ date: day, state, clicks: 0, impressions: 0, ctr: null, position: null });
    } else {
      series.push({ date: day, state: "not_returned", clicks: null, impressions: null, ctr: null, position: null });
    }
  }
  const days = daysBetween(input.from, input.to) + 1;
  return {
    dimensionSet: set,
    filter: input.filter ?? null,
    totals: totals(observed),
    coverage: {
      days,
      daysWithData: series.filter((s) => s.state === "complete" || s.state === "fresh").length,
      daysMissing: series.filter((s) => s.state === "missing").length,
      daysFresh: series.filter((s) => s.state === "fresh").length,
      daysNotReturned: series.filter((s) => s.state === "not_returned").length,
    },
    series,
  };
}

export function compareMetrics(current: Metrics, previous: Metrics) {
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : (a - b) / b);
  return {
    clicks: { change: delta(current.clicks, previous.clicks), changePct: pct(current.clicks, previous.clicks) },
    impressions: { change: delta(current.impressions, previous.impressions), changePct: pct(current.impressions, previous.impressions) },
    ctr: { change: delta(current.ctr, previous.ctr), changePct: null },
    // Lower is better for position; the sign is reported as-is.
    position: { change: delta(current.position, previous.position), changePct: null },
  };
}

export const SORTS = ["clicks", "impressions", "ctr", "position"] as const;
export type SortKey = (typeof SORTS)[number];

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Aggregated rows of one breakdown over a range, keyset-paginated on (metric, key). */
export async function topRows(input: {
  orgId: string;
  propertyId: string;
  dimension: BreakdownDimension;
  from: string;
  to: string;
  sort: SortKey;
  order: "asc" | "desc";
  search?: string;
  limit: number;
  cursor?: string;
}) {
  const params: unknown[] = [input.orgId, input.propertyId, input.dimension, input.from, input.to];
  let searchSql = "";
  if (input.search) {
    params.push(`%${likeEscape(input.search)}%`);
    searchSql = ` AND dim_value ILIKE $${params.length}`;
  }
  const metric = `COALESCE(${input.sort}, 0)`;
  const cmp = input.order === "desc" ? "<" : ">";
  let cursorSql = "";
  if (input.cursor) {
    const c = decodeCursor<{ v: number; k: string; s: string; o: string }>(input.cursor, (x) => typeof x.v === "number" && Number.isFinite(x.v) && typeof x.k === "string" && x.s === input.sort && x.o === input.order);
    params.push(c.v, c.k);
    const n = params.length;
    cursorSql = `WHERE (${metric} ${cmp} $${n - 1}::float8 OR (${metric} = $${n - 1}::float8 AND key > $${n}::text))`;
  }
  params.push(input.limit + 1);
  const { rows } = await query<{ key: string; clicks: number; impressions: number; ctr: number | null; position: number | null; days: string }>(
    `SELECT * FROM (
       SELECT dim_value AS key, SUM(clicks)::float8 AS clicks, SUM(impressions)::float8 AS impressions,
              SUM(clicks)::float8 / NULLIF(SUM(impressions), 0) AS ctr,
              SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position,
              COUNT(*)::text AS days
         FROM gsc_search_daily
        WHERE org_id = $1 AND property_id = $2 AND dimension_set = $3 AND day BETWEEN $4 AND $5${searchSql}
        GROUP BY dim_value) agg
     ${cursorSql}
     ORDER BY ${metric} ${input.order === "desc" ? "DESC" : "ASC"}, key ASC
     LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > input.limit;
  const data = (more ? rows.slice(0, input.limit) : rows).map((r) => ({
    key: r.key, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: r.ctr, position: r.position, daysWithRows: Number(r.days),
  }));
  const last = data[data.length - 1];
  const sortValue = (r: (typeof data)[number]) => Number(r[input.sort] ?? 0);
  const { rows: cov } = await query<{ days: string; truncated: string }>(
    `SELECT COUNT(*)::text AS days, COUNT(*) FILTER (WHERE outcome = 'truncated')::text AS truncated FROM gsc_coverage
      WHERE org_id = $1 AND property_id = $2 AND dimension_set = $3 AND day BETWEEN $4 AND $5`,
    [input.orgId, input.propertyId, input.dimension, input.from, input.to],
  );
  return {
    rows: data,
    nextCursor: more && last ? encodeCursor({ v: sortValue(last), k: last.key, s: input.sort, o: input.order }) : null,
    coverage: { days: daysBetween(input.from, input.to) + 1, daysFetched: Number(cov[0].days), daysTruncated: Number(cov[0].truncated) },
  };
}
