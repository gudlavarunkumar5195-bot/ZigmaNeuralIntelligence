import { query } from "../../db/client.js";
import { normalizeKeyword } from "../keywords.js";
import { ResearchError, type CompetitorRef, type KeywordResearchProvider, type ProviderContext, type ProviderResult } from "./types.js";

/**
 * First-party keyword research from the organization's own Google Search
 * Console data (synced in Phase 3). Real, authorized and free, but limited to
 * what Google reports for sites the organization connected:
 *
 * - metrics: the site's clicks, impressions, CTR and average position. No
 *   search volume, keyword difficulty, CPC or competition (not in the data);
 * - ideas / related: queries the site already appears for that contain the
 *   seed's words; never invented variations;
 * - organic keywords and gaps: only for websites of this organization with a
 *   linked Search Console property. Other domains need a licensed provider;
 * - no targeting by query x country/device (not stored together), no SERP.
 *
 * Every result is a sample: Google returns top rows and omits rare and
 * anonymized queries.
 */

const WINDOW_DAYS = 28;

interface PropertyRef {
  id: string;
  site_url: string;
  latest: string | null;
}

async function propertyFor(orgId: string, websiteId: string): Promise<PropertyRef | null> {
  const { rows } = await query<PropertyRef>(
    `SELECT p.id, p.site_url,
            (SELECT to_char(MAX(day),'YYYY-MM-DD') FROM gsc_coverage c WHERE c.property_id = p.id AND c.org_id = p.org_id AND c.dimension_set = 'query') AS latest
       FROM gsc_properties p JOIN integrations i ON i.id = p.integration_id AND i.org_id = p.org_id
      WHERE p.org_id = $1 AND p.website_id = $2`,
    [orgId, websiteId],
  );
  return rows[0] ?? null;
}

async function requireProperty(orgId: string, websiteId: string, who = "this website"): Promise<PropertyRef & { latest: string }> {
  const p = await propertyFor(orgId, websiteId);
  if (!p) throw new ResearchError(422, "DATA_SOURCE_UNAVAILABLE", `No Search Console property is linked to ${who}. Link one in Settings → Integrations.`);
  if (!p.latest) throw new ResearchError(422, "DATA_SOURCE_UNAVAILABLE", `Search Console has not synced any query data for ${who} yet. Run a sync first.`);
  return p as PropertyRef & { latest: string };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function queries(p: PropertyRef & { latest: string }, orgId: string, limit: number, opts: { words?: string[]; exact?: string[] } = {}): Promise<ProviderResult> {
  const params: unknown[] = [orgId, p.id, p.latest, WINDOW_DAYS - 1];
  const filters: string[] = [];
  if (opts.words?.length) {
    for (const w of opts.words) {
      params.push(`%${likeEscape(w)}%`);
      filters.push(`dim_value ILIKE $${params.length}`);
    }
  }
  if (opts.exact?.length) {
    params.push(opts.exact);
    filters.push(`lower(dim_value) = ANY($${params.length}::text[])`);
  }
  params.push(limit + 1);
  const { rows } = await query<{ q: string; clicks: number; impressions: number; position: number | null }>(
    `SELECT dim_value AS q, SUM(clicks)::float8 AS clicks, SUM(impressions)::float8 AS impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
       FROM gsc_search_daily
      WHERE org_id = $1 AND property_id = $2 AND dimension_set = 'query' AND day BETWEEN $3::date - $4::int AND $3::date
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
      GROUP BY dim_value
      ORDER BY SUM(impressions) DESC, dim_value
      LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((r) => ({
      keyword: r.q,
      metrics: {
        clicks: r.clicks,
        impressions: r.impressions,
        ...(r.impressions > 0 ? { ctr: r.clicks / r.impressions } : {}),
        ...(r.position !== null ? { position: r.position } : {}),
      },
    })),
    sample: true,
    partial: false,
    observedThrough: p.latest,
    notes: [
      `Last ${WINDOW_DAYS} days of Search Console data through ${p.latest} (Pacific Time), web search, all countries and devices.`,
      "Google omits rare and anonymized queries and returns top rows only." + (more ? ` Showing the top ${limit} by impressions.` : ""),
    ],
  };
}

function rejectTargeting(ctx: ProviderContext) {
  const t = ctx.targeting;
  if (t.country || t.language || t.device) {
    throw new ResearchError(422, "TARGETING_UNSUPPORTED", "Search Console query data is not broken down by country, language or device here; leave targeting empty.", { targeting: t });
  }
}

/** Significant words of a seed: at least 2 characters, max 5 words. */
function seedWords(seed: string): string[] {
  return [...new Set(normalizeKeyword(seed).split(" ").filter((w) => w.length >= 2))].slice(0, 5);
}

export const searchConsoleProvider: KeywordResearchProvider = {
  info: {
    id: "google_search_console",
    name: "Google Search Console (your own data)",
    kind: "first_party",
    capabilities: ["keyword_overview", "keyword_ideas", "related_keywords", "organic_keywords", "keyword_gap"],
    metrics: ["clicks", "impressions", "ctr", "position"],
    metricScope: "Clicks, impressions, CTR and average position of your own website in Google web search. Not market-wide search volume.",
    targeting: { countries: [], languages: [], devices: [], note: "All countries, languages and devices combined." },
    caching: { allowed: true, maxAgeMinutes: 60 },
    attribution: "Data from Google Search Console for properties your organization connected.",
    costNote: "Free (your own Search Console data, already synced).",
  },
  missingConfiguration() {
    return [];
  },

  async keywordOverview(ctx, keywords) {
    rejectTargeting(ctx);
    const p = await requireProperty(ctx.orgId, ctx.websiteId);
    const wanted = keywords.map(normalizeKeyword);
    const res = await queries(p, ctx.orgId, Math.min(ctx.limit, wanted.length), { exact: wanted });
    const found = new Set(res.rows.map((r) => normalizeKeyword(r.keyword)));
    const notFound = keywords.filter((k) => !found.has(normalizeKeyword(k)));
    if (notFound.length) res.notes.push(`${notFound.length} keyword(s) did not appear in your site's Search Console data for this period (no data, not zero).`);
    return { ...res, partial: notFound.length > 0 };
  },

  async keywordIdeas(ctx, seed) {
    rejectTargeting(ctx);
    const p = await requireProperty(ctx.orgId, ctx.websiteId);
    const words = seedWords(seed);
    const res = await queries(p, ctx.orgId, ctx.limit, { words });
    res.notes.unshift("Ideas are queries your site already appears for that contain every word of the seed. No new keywords are generated.");
    return res;
  },

  async relatedKeywords(ctx, keyword) {
    rejectTargeting(ctx);
    const p = await requireProperty(ctx.orgId, ctx.websiteId);
    const words = seedWords(keyword);
    // Related: share at least one significant word (any order), excluding the keyword itself.
    const all = await Promise.all(words.map((w) => queries(p, ctx.orgId, ctx.limit, { words: [w] })));
    const self = normalizeKeyword(keyword);
    const merged = new Map<string, ProviderResult["rows"][number]>();
    for (const r of all.flatMap((x) => x.rows)) {
      const k = normalizeKeyword(r.keyword);
      if (k !== self && !merged.has(k)) merged.set(k, r);
    }
    const rows = [...merged.values()].sort((a, b) => (b.metrics.impressions ?? 0) - (a.metrics.impressions ?? 0) || a.keyword.localeCompare(b.keyword)).slice(0, ctx.limit);
    return {
      rows,
      sample: true,
      partial: false,
      observedThrough: p.latest,
      notes: ["Related queries share at least one word with the keyword and come from your site's Search Console data.", ...(all[0]?.notes ?? [])],
    };
  },

  async organicKeywords(ctx, target: CompetitorRef | null) {
    rejectTargeting(ctx);
    const websiteId = target ? target.websiteId : ctx.websiteId;
    if (!websiteId) {
      throw new ResearchError(422, "COMPETITOR_DATA_UNAVAILABLE", `No data for ${target?.domain}: with Search Console, only websites of your organization that have a linked property can be compared. Other domains need a licensed keyword data provider.`, { domain: target?.domain });
    }
    const p = await requireProperty(ctx.orgId, websiteId, target ? target.domain : "this website");
    return queries(p, ctx.orgId, ctx.limit);
  },
};
