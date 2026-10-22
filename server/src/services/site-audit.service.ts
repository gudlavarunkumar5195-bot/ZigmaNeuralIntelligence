import { upsertContentInventory } from "./content.service.js";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { issueFingerprint, ruleInfo, type CrawlIssue, type CrawlPage, type CrawlResult, type SeoCategory } from "../scanner/crawl.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";

/**
 * Persistence for the technical crawl and the persistent issue lifecycle.
 *
 * Issue lifecycle (per website, keyed by fingerprint = rule + URL [+ key]):
 *   new observation            -> OPEN     (event DETECTED)
 *   OPEN, observed again       -> OPEN     (last_seen updated)
 *   OPEN, scope re-checked and
 *         not observed         -> FIXED    (event FIXED)
 *   FIXED, observed again      -> OPEN     (event REOPENED, times_reopened+1)
 *   IGNORED                    -> stays IGNORED whatever the crawl sees
 *                                 (last_seen still updated); a user can reopen
 * Every scan that observes an issue is recorded in site_issue_scans.
 *
 * "Scope re-checked" means this crawl actually re-audited what the issue is
 * about (for content rules: the page was fetched and parsed as HTML; for
 * status rules: the URL was requested), or the crawl was complete (not
 * truncated, not cancelled) and no longer reaches the URL at all. A failed,
 * cancelled, truncated-before-the-page or robots-blocked re-check fixes
 * nothing: absence of evidence is not a fix.
 */

const MAX_ISSUES_PER_SCAN = 2_000;
const KEEP_CRAWLS_PER_WEBSITE = 2;
const SITE_LEVEL_RULES = new Set(["robots_txt_unreachable", "robots_txt_missing", "sitemap_missing", "sitemap_invalid", "sitemap_unavailable", "start_url_blocked_by_robots"]);
const LINK_RULES = new Set(["broken_internal_link", "internal_link_to_redirect"]);
const DUPLICATE_RULES = new Set(["title_duplicate", "meta_description_duplicate"]);
/** Rules about a page's HTML: only a re-fetched, parsed 200 page can show they are gone. */
const CONTENT_RULES = new Set([
  "title_missing", "meta_description_missing", "h1_missing", "h1_multiple", "img_alt_missing",
  "canonical_missing", "canonical_multiple", "canonical_invalid", "canonical_cross_domain", "canonical_target_not_ok",
  "page_noindex", "page_nofollow",
]);

export type IssueStatus = "OPEN" | "FIXED" | "IGNORED";
export const ISSUE_CATEGORIES: SeoCategory[] = ["crawlability", "status_codes", "links", "redirects", "content", "canonicalization", "indexability", "sitemaps", "images"];
export const PAGE_STATUS_FILTERS = ["2xx", "3xx", "4xx", "5xx", "error", "blocked"] as const;
export const PAGE_OUTCOMES = ["ok", "redirect", "redirect_out_of_scope", "redirect_loop", "http_error", "fetch_error", "too_large", "non_html", "blocked_by_robots"] as const;

/**
 * Inventory bucket of a crawled URL: failures are judged by the FINAL
 * response (a redirect that ends in a 404 is a 4xx); a redirect that lands
 * on a working page is a 3xx; robots-blocked URLs were never requested.
 */
function statusBucket(p: Pick<CrawlPage, "status" | "finalStatus" | "redirectChain" | "outcome">): string {
  if (p.outcome === "blocked_by_robots") return "blocked";
  if (p.finalStatus === 0) return "error";
  if (p.finalStatus >= 400) return `${Math.floor(p.finalStatus / 100)}xx`;
  if (p.redirectChain.length > 0) return "3xx";
  return `${Math.floor(p.status / 100)}xx`;
}

export async function persistCrawl(
  tx: Queryable,
  input: { scanId: string; orgId: string; websiteId: string; result: CrawlResult; issues: CrawlIssue[]; completed: boolean },
): Promise<{ detected: number; reopened: number; fixed: number }> {
  const { scanId, orgId, websiteId, result } = input;
  const issues = input.issues;
  const statusCounts: Record<string, number> = {};
  for (const p of result.pages) statusCounts[statusBucket(p)] = (statusCounts[statusBucket(p)] ?? 0) + 1;
  const issueCounts: Record<string, number> = {};
  for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] ?? 0) + 1;
  const s = result.summary;

  await tx.query(
    `INSERT INTO crawl_summaries
       (scan_id, org_id, website_id, start_url, pages_crawled, pages_discovered, max_pages, truncated, truncated_reason,
        robots_status, start_blocked_by_robots, sitemap_status, sitemap_files, sitemap_url_count, status_counts, issue_counts, duration_ms,
        max_depth, pages_blocked_by_robots, reconcilable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20)
     ON CONFLICT (scan_id) DO UPDATE SET
       pages_crawled = EXCLUDED.pages_crawled, pages_discovered = EXCLUDED.pages_discovered, truncated = EXCLUDED.truncated,
       truncated_reason = EXCLUDED.truncated_reason, robots_status = EXCLUDED.robots_status,
       start_blocked_by_robots = EXCLUDED.start_blocked_by_robots, sitemap_status = EXCLUDED.sitemap_status,
       sitemap_files = EXCLUDED.sitemap_files, sitemap_url_count = EXCLUDED.sitemap_url_count,
       status_counts = EXCLUDED.status_counts, issue_counts = EXCLUDED.issue_counts, duration_ms = EXCLUDED.duration_ms,
       max_depth = EXCLUDED.max_depth, pages_blocked_by_robots = EXCLUDED.pages_blocked_by_robots, reconcilable = EXCLUDED.reconcilable`,
    [
      scanId, orgId, websiteId, s.startUrl, s.pagesCrawled, s.pagesDiscovered, s.maxPages, s.truncated, s.truncatedReason,
      s.robotsStatus, s.startBlockedByRobots, s.sitemapStatus, JSON.stringify(s.sitemapFiles), s.sitemapUrlCount,
      JSON.stringify(statusCounts), JSON.stringify(issueCounts), Math.max(0, Math.round(s.durationMs)),
      s.maxDepth ?? null, s.pagesBlockedByRobots ?? 0, s.reconcilable,
    ],
  );

  if (result.pages.length > 0) {
    // Only what the inventory and the rules need is retained: no page bodies.
    const rows = result.pages.map((p) => ({
      url: p.url, final_url: p.finalUrl, status_code: p.status, final_status_code: p.finalStatus,
      redirect_chain: p.redirectChain, depth: p.depth, discovered_from: p.discoveredFrom, content_type: p.contentType?.slice(0, 200) ?? null,
      title: p.title?.slice(0, 1000) ?? null, meta_description: p.metaDescription?.slice(0, 2000) ?? null,
      canonicals: p.canonicals.slice(0, 10), robots_meta: p.robotsMeta?.slice(0, 500) ?? null, h1_count: p.h1Count,
      internal_links_out: p.internalLinks.length, inlinks: result.inlinks[p.url]?.count ?? 0, indexable: p.indexable,
      in_sitemap: p.inSitemap, fetch_error: p.fetchError?.slice(0, 500) ?? null, response_ms: Math.max(0, Math.round(p.responseMs)),
      outcome: p.outcome, redirect_target: p.redirectTarget?.slice(0, 2000) ?? null, x_robots_tag: p.xRobotsTag?.slice(0, 500) ?? null,
      images_total: p.imagesTotal, images_missing_alt: p.imagesMissingAlt, images_missing_alt_sample: p.imagesMissingAltSample.slice(0, 5),
      indexability_reasons: p.indexabilityReasons,
    }));
    await tx.query(
      `INSERT INTO crawl_pages
         (scan_id, org_id, website_id, url, final_url, status_code, final_status_code, redirect_chain, depth, discovered_from,
          content_type, title, meta_description, canonicals, robots_meta, h1_count, internal_links_out, inlinks, indexable,
          in_sitemap, fetch_error, response_ms, outcome, redirect_target, x_robots_tag, images_total, images_missing_alt,
          images_missing_alt_sample, indexability_reasons)
       SELECT $1, $2, $3, x.url, x.final_url, x.status_code, x.final_status_code, COALESCE(x.redirect_chain, '[]'::jsonb), x.depth,
              x.discovered_from, x.content_type, x.title, x.meta_description, COALESCE(x.canonicals, '[]'::jsonb), x.robots_meta,
              x.h1_count, x.internal_links_out, x.inlinks, x.indexable, x.in_sitemap, x.fetch_error, x.response_ms,
              x.outcome, x.redirect_target, x.x_robots_tag, x.images_total, x.images_missing_alt,
              COALESCE(x.images_missing_alt_sample, '[]'::jsonb), COALESCE(x.indexability_reasons, '{}')
         FROM jsonb_to_recordset($4::jsonb) AS x(
           url text, final_url text, status_code int, final_status_code int, redirect_chain jsonb, depth int,
           discovered_from text, content_type text, title text, meta_description text, canonicals jsonb, robots_meta text,
           h1_count int, internal_links_out int, inlinks int, indexable boolean, in_sitemap boolean, fetch_error text,
           response_ms int, outcome text, redirect_target text, x_robots_tag text, images_total int, images_missing_alt int,
           images_missing_alt_sample jsonb, indexability_reasons text[])
       ON CONFLICT (scan_id, url) DO NOTHING`,
      [scanId, orgId, websiteId, JSON.stringify(rows)],
    );
  }

  // Keep page-level rows only for the most recent crawls of this website.
  await tx.query(
    `DELETE FROM crawl_pages
      WHERE org_id = $1 AND website_id = $2
        AND scan_id NOT IN (
          SELECT scan_id FROM crawl_summaries
           WHERE org_id = $1 AND website_id = $2
           ORDER BY created_at DESC, scan_id DESC LIMIT $3)`,
    [orgId, websiteId, KEEP_CRAWLS_PER_WEBSITE],
  );

  // Persistent content inventory (and, for a completed crawl, one content analysis), in the same transaction.
  await upsertContentInventory(tx, { scanId, orgId, websiteId, result, completed: input.completed });

  if (!input.completed) return { detected: 0, reopened: 0, fixed: 0 };
  return reconcileIssues(tx, { scanId, orgId, websiteId, result, issues });
}

/** Which issue scopes this crawl re-checked (so absence means fixed). */
export function observedScope(result: CrawlResult) {
  const requested = new Map(result.pages.filter((p) => p.outcome !== "blocked_by_robots").map((p) => [p.url, p]));
  const blocked = new Set(result.pages.filter((p) => p.outcome === "blocked_by_robots").map((p) => p.url));
  const checkedSitemaps = new Set(result.summary.sitemapFiles.map((f) => f.url));
  const complete = !result.summary.truncated;
  const reAudited = (url: string) => {
    const p = requested.get(url);
    return !!p && p.outcome === "ok" && p.finalStatus === 200;
  };
  return {
    covers(issue: { rule_id: string; url: string; details: Record<string, unknown> }): boolean {
      if (SITE_LEVEL_RULES.has(issue.rule_id)) return true;
      // robots.txt unreachable, start URL blocked or failing, crawl cancelled:
      // the crawl did not re-check the site's pages, so it fixes none of them.
      if (!result.summary.reconcilable) return false;
      // Disallowed now: we did not look, so we cannot say it is gone.
      if (blocked.has(issue.url)) return false;
      if (DUPLICATE_RULES.has(issue.rule_id)) {
        // Only a full (untruncated) crawl can say a duplicate group is gone.
        if (!complete) return false;
        const pages = Array.isArray(issue.details.pages) ? (issue.details.pages as string[]) : [issue.url];
        return pages.every((u) => requested.has(u));
      }
      if (CONTENT_RULES.has(issue.rule_id)) {
        if (requested.has(issue.url)) return reAudited(issue.url);
        return complete; // a complete crawl no longer reaches the page at all
      }
      if (requested.has(issue.url) || checkedSitemaps.has(issue.url)) return true;
      // A complete crawl that no longer reaches a URL means it is neither
      // linked nor listed in a sitemap any more: resolved.
      if (complete) return true;
      if (LINK_RULES.has(issue.rule_id)) {
        const sources = Array.isArray(issue.details.linkedFrom) ? (issue.details.linkedFrom as string[]) : [];
        return sources.length > 0 && sources.every((u) => reAudited(u));
      }
      return false;
    },
  };
}

async function reconcileIssues(
  tx: Queryable,
  input: { scanId: string; orgId: string; websiteId: string; result: CrawlResult; issues: CrawlIssue[] },
): Promise<{ detected: number; reopened: number; fixed: number }> {
  const { scanId, orgId, websiteId } = input;
  let detected = 0;
  let reopened = 0;
  // Every observed fingerprint counts as "seen" (so nothing observed is ever
  // marked fixed), but at most MAX_ISSUES_PER_SCAN are written per scan.
  const seen = new Set(input.issues.map((i) => issueFingerprint(i)));
  const written = new Set<string>();
  const observedIds: string[] = [];

  for (const issue of input.issues) {
    const fingerprint = issueFingerprint(issue);
    if (written.has(fingerprint)) continue;
    if (written.size >= MAX_ISSUES_PER_SCAN) break;
    written.add(fingerprint);
    const category = issue.category ?? ruleInfo(issue.ruleId).category;
    // Row lock: a concurrent ignore/reopen and this scan serialise on the issue.
    const { rows: existing } = await tx.query<{ id: string; status: IssueStatus }>(
      "SELECT id, status FROM site_issues WHERE website_id = $1 AND org_id = $2 AND fingerprint = $3 FOR UPDATE",
      [websiteId, orgId, fingerprint],
    );
    if (existing.length === 0) {
      // ON CONFLICT: a retried or concurrent commit for the same website never creates a second row.
      const { rows } = await tx.query<{ id: string; inserted: boolean }>(
        `INSERT INTO site_issues (org_id, website_id, fingerprint, rule_id, severity, category, url, title, details, first_seen_scan_id, last_seen_scan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
         ON CONFLICT (website_id, fingerprint) DO UPDATE SET last_seen_scan_id = EXCLUDED.last_seen_scan_id, last_seen_at = NOW(), updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [orgId, websiteId, fingerprint, issue.ruleId, issue.severity, category, issue.url, issue.title.slice(0, 500), JSON.stringify(issue.details), scanId],
      );
      observedIds.push(rows[0].id);
      if (rows[0].inserted) {
        await tx.query("INSERT INTO site_issue_events (org_id, issue_id, scan_id, event) VALUES ($1,$2,$3,'DETECTED')", [orgId, rows[0].id, scanId]);
        detected++;
      }
      continue;
    }
    const prev = existing[0];
    observedIds.push(prev.id);
    const reopen = prev.status === "FIXED";
    await tx.query(
      `UPDATE site_issues
          SET severity = $3, title = $4, details = $5::jsonb, category = $7, last_seen_scan_id = $6, last_seen_at = NOW(), updated_at = NOW(),
              status = CASE WHEN status = 'FIXED' THEN 'OPEN' ELSE status END,
              times_reopened = times_reopened + CASE WHEN status = 'FIXED' THEN 1 ELSE 0 END,
              fixed_at = CASE WHEN status = 'FIXED' THEN NULL ELSE fixed_at END,
              fixed_in_scan_id = CASE WHEN status = 'FIXED' THEN NULL ELSE fixed_in_scan_id END
        WHERE id = $1 AND org_id = $2`,
      [prev.id, orgId, issue.severity, issue.title.slice(0, 500), JSON.stringify(issue.details), scanId, category],
    );
    if (reopen) {
      await tx.query("INSERT INTO site_issue_events (org_id, issue_id, scan_id, event) VALUES ($1,$2,$3,'REOPENED')", [orgId, prev.id, scanId]);
      reopened++;
    }
  }

  if (observedIds.length > 0) {
    await tx.query(
      `INSERT INTO site_issue_scans (org_id, issue_id, scan_id)
       SELECT $1, unnest($3::uuid[]), $2 ON CONFLICT DO NOTHING`,
      [orgId, scanId, observedIds],
    );
  }

  // OPEN issues this crawl re-checked and did not observe are fixed.
  const scope = observedScope(input.result);
  const { rows: open } = await tx.query<{ id: string; fingerprint: string; rule_id: string; url: string; details: Record<string, unknown> }>(
    "SELECT id, fingerprint, rule_id, url, details FROM site_issues WHERE website_id = $1 AND org_id = $2 AND status = 'OPEN' FOR UPDATE",
    [websiteId, orgId],
  );
  const fixedIds = open.filter((i) => !seen.has(i.fingerprint) && scope.covers(i)).map((i) => i.id);
  if (fixedIds.length > 0) {
    await tx.query(
      "UPDATE site_issues SET status = 'FIXED', fixed_at = NOW(), fixed_in_scan_id = $3, updated_at = NOW() WHERE org_id = $1 AND website_id = $2 AND id = ANY($4::uuid[])",
      [orgId, websiteId, scanId, fixedIds],
    );
    await tx.query(
      "INSERT INTO site_issue_events (org_id, issue_id, scan_id, event) SELECT $1, unnest($3::uuid[]), $2, 'FIXED'",
      [orgId, scanId, fixedIds],
    );
  }
  return { detected, reopened, fixed: fixedIds.length };
}

// ─── Read APIs ────────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS = `cs.scan_id, cs.start_url, cs.pages_crawled, cs.pages_discovered, cs.pages_blocked_by_robots, cs.max_pages, cs.max_depth,
  cs.truncated, cs.truncated_reason, cs.robots_status, cs.start_blocked_by_robots, cs.sitemap_status, cs.sitemap_files,
  cs.sitemap_url_count, cs.status_counts, cs.issue_counts, cs.duration_ms, cs.reconcilable, cs.created_at,
  s.status AS scan_status, s.completed_at AS scan_completed_at`;

export async function getLatestCrawlSummary(orgId: string, websiteId: string) {
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS}
       FROM crawl_summaries cs JOIN scans s ON s.id = cs.scan_id AND s.org_id = cs.org_id
      WHERE cs.org_id = $1 AND cs.website_id = $2
      ORDER BY cs.created_at DESC, cs.scan_id DESC LIMIT 1`,
    [orgId, websiteId],
  );
  return rows[0] ?? null;
}

/**
 * Latest crawl, the one before it, what the latest crawl changed in the issue
 * list, and the most recent scan that includes the crawl module (which may
 * still be running or have failed before writing a summary).
 */
export async function getCrawlOverview(orgId: string, websiteId: string) {
  const [{ rows: summaries }, { rows: latestScan }] = await Promise.all([
    query(
      `SELECT ${SUMMARY_COLUMNS}
         FROM crawl_summaries cs JOIN scans s ON s.id = cs.scan_id AND s.org_id = cs.org_id
        WHERE cs.org_id = $1 AND cs.website_id = $2
        ORDER BY cs.created_at DESC, cs.scan_id DESC LIMIT 2`,
      [orgId, websiteId],
    ),
    query(
      `SELECT s.id, s.status, s.error, s.created_at, s.started_at, s.completed_at, s.crawl_options,
              m.status AS crawl_module_status, m.error AS crawl_module_error
         FROM scans s LEFT JOIN scan_modules m ON m.scan_id = s.id AND m.module_name = 'crawl'
        WHERE s.org_id = $1 AND s.website_id = $2 AND 'crawl' = ANY(s.modules)
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      [orgId, websiteId],
    ),
  ]);
  const latest = summaries[0] ?? null;
  let changes: { detected: number; fixed: number; reopened: number } | null = null;
  if (latest) {
    const { rows } = await query<{ event: string; n: string }>(
      `SELECT event, COUNT(*)::text AS n FROM site_issue_events
        WHERE org_id = $1 AND scan_id = $2 AND event IN ('DETECTED', 'FIXED', 'REOPENED') GROUP BY event`,
      [orgId, latest.scan_id],
    );
    const by = Object.fromEntries(rows.map((r) => [r.event, Number(r.n)]));
    changes = { detected: by.DETECTED ?? 0, fixed: by.FIXED ?? 0, reopened: by.REOPENED ?? 0 };
  }
  return { latest, previous: summaries[1] ?? null, changes, latestScan: latestScan[0] ?? null };
}

export interface CrawlPageFilters {
  statusClass?: (typeof PAGE_STATUS_FILTERS)[number];
  outcome?: (typeof PAGE_OUTCOMES)[number];
  indexable?: boolean;
  urlContains?: string;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Crawl inventory of one scan, keyset-paginated by URL. */
export async function listCrawlPages(orgId: string, scanId: string, filters: CrawlPageFilters, page: { limit: number; cursor?: string }) {
  const conditions = ["org_id = $1", "scan_id = $2"];
  const params: unknown[] = [orgId, scanId];
  // Same buckets as the summary counts (failures by final status).
  if (filters.statusClass === "blocked") conditions.push("outcome = 'blocked_by_robots'");
  else if (filters.statusClass === "error") conditions.push("final_status_code = 0 AND outcome IS DISTINCT FROM 'blocked_by_robots'");
  else if (filters.statusClass === "4xx" || filters.statusClass === "5xx") {
    params.push(Number(filters.statusClass[0]) * 100);
    conditions.push(`final_status_code >= $${params.length} AND final_status_code < $${params.length} + 100`);
  } else if (filters.statusClass === "3xx") {
    conditions.push("jsonb_array_length(redirect_chain) > 0 AND final_status_code BETWEEN 200 AND 399");
  } else if (filters.statusClass === "2xx") {
    conditions.push("jsonb_array_length(redirect_chain) = 0 AND final_status_code BETWEEN 200 AND 299");
  }
  if (filters.outcome) { params.push(filters.outcome); conditions.push(`outcome = $${params.length}`); }
  if (filters.indexable !== undefined) { params.push(filters.indexable); conditions.push(`indexable = $${params.length}`); }
  if (filters.urlContains) { params.push(`%${likeEscape(filters.urlContains)}%`); conditions.push(`url ILIKE $${params.length}`); }
  const after = page.cursor ? decodeCursor<{ u: string }>(page.cursor, (c) => typeof c.u === "string") : null;
  if (after) { params.push(after.u); conditions.push(`url > $${params.length}`); }
  params.push(page.limit + 1);
  const { rows } = await query<{ url: string }>(
    `SELECT url, final_url, status_code, final_status_code, redirect_chain, redirect_target, outcome, depth, discovered_from,
            content_type, title, meta_description, canonicals, robots_meta, x_robots_tag, h1_count, images_total, images_missing_alt,
            internal_links_out, inlinks, indexable, indexability_reasons, in_sitemap, fetch_error, response_ms
       FROM crawl_pages WHERE ${conditions.join(" AND ")}
      ORDER BY url ASC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > page.limit;
  const data = more ? rows.slice(0, page.limit) : rows;
  return { pages: data, nextCursor: more ? encodeCursor({ u: data[data.length - 1].url }) : null };
}

export interface IssueFilters {
  status?: IssueStatus;
  ruleId?: string;
  severity?: string;
  category?: SeoCategory;
  urlContains?: string;
}

const STATUS_RANK = "CASE status WHEN 'OPEN' THEN 0 WHEN 'IGNORED' THEN 1 ELSE 2 END";
const SEVERITY_RANK = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
const ISSUE_COLUMNS = `id, rule_id, category, severity, url, title, details, status, first_seen_at, last_seen_at, fixed_at, ignored_at,
  ignored_by, ignore_reason, times_reopened, first_seen_scan_id, last_seen_scan_id, fixed_in_scan_id`;

/**
 * Issues of one website, deterministic order (status, severity, URL, id) and
 * keyset pagination on that same tuple, so rows never repeat or vanish
 * between pages while scans update last_seen.
 */
export async function listIssues(orgId: string, websiteId: string, filters: IssueFilters, page: { limit: number; cursor?: string }) {
  const conditions = ["org_id = $1", "website_id = $2"];
  const params: unknown[] = [orgId, websiteId];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.ruleId) { params.push(filters.ruleId); conditions.push(`rule_id = $${params.length}`); }
  if (filters.severity) { params.push(filters.severity); conditions.push(`severity = $${params.length}`); }
  if (filters.category) { params.push(filters.category); conditions.push(`category = $${params.length}`); }
  if (filters.urlContains) { params.push(`%${likeEscape(filters.urlContains)}%`); conditions.push(`url ILIKE $${params.length}`); }
  const filterParams = [...params];
  const filterWhere = conditions.join(" AND ");
  const after = page.cursor
    ? decodeCursor<{ s: number; v: number; u: string; i: string }>(page.cursor, (c) =>
        Number.isInteger(c.s) && Number.isInteger(c.v) && typeof c.u === "string" && /^[0-9a-f-]{36}$/i.test(String(c.i)))
    : null;
  if (after) {
    params.push(after.s, after.v, after.u, after.i);
    const n = params.length;
    conditions.push(`(${STATUS_RANK}, ${SEVERITY_RANK}, url, id) > ($${n - 3}::int, $${n - 2}::int, $${n - 1}::text, $${n}::uuid)`);
  }
  params.push(page.limit + 1);
  const [{ rows }, { rows: totals }, { rows: matching }] = await Promise.all([
    query<{ id: string; url: string; status: IssueStatus; severity: string; status_rank: number; severity_rank: number }>(
      `SELECT ${ISSUE_COLUMNS}, ${STATUS_RANK} AS status_rank, ${SEVERITY_RANK} AS severity_rank
         FROM site_issues WHERE ${conditions.join(" AND ")}
        ORDER BY status_rank, severity_rank, url, id
        LIMIT $${params.length}`,
      params,
    ),
    query<{ status: IssueStatus; n: string }>(
      "SELECT status, COUNT(*)::text AS n FROM site_issues WHERE org_id = $1 AND website_id = $2 GROUP BY status",
      [orgId, websiteId],
    ),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM site_issues WHERE ${filterWhere}`, filterParams),
  ]);
  const counts = { OPEN: 0, FIXED: 0, IGNORED: 0 } as Record<IssueStatus, number>;
  for (const t of totals) counts[t.status] = Number(t.n);
  const more = rows.length > page.limit;
  const data = (more ? rows.slice(0, page.limit) : rows).map(({ status_rank: _s, severity_rank: _v, ...issue }) => issue);
  const last = more ? rows[page.limit - 1] : null;
  return {
    issues: data,
    counts,
    total: Number(matching[0]?.n ?? 0),
    nextCursor: last ? encodeCursor({ s: last.status_rank, v: last.severity_rank, u: last.url, i: last.id }) : null,
  };
}

/** One issue with its rule guidance, the scans that observed it and the latest crawl's evidence for its URL. */
export async function getIssue(orgId: string, websiteId: string, issueId: string) {
  const { rows } = await query<{ id: string; rule_id: string; url: string }>(
    `SELECT ${ISSUE_COLUMNS} FROM site_issues WHERE id = $1 AND org_id = $2 AND website_id = $3`,
    [issueId, orgId, websiteId],
  );
  const issue = rows[0];
  if (!issue) return null;
  const latest = await getLatestCrawlSummary(orgId, websiteId);
  const [{ rows: occurrences }, { rows: occurrenceCount }, { rows: pageRows }] = await Promise.all([
    query(
      `SELECT o.scan_id, o.observed_at, s.status AS scan_status
         FROM site_issue_scans o JOIN scans s ON s.id = o.scan_id AND s.org_id = o.org_id
        WHERE o.org_id = $1 AND o.issue_id = $2 ORDER BY o.observed_at DESC, o.scan_id DESC LIMIT 20`,
      [orgId, issueId],
    ),
    query<{ n: string }>("SELECT COUNT(*)::text AS n FROM site_issue_scans WHERE org_id = $1 AND issue_id = $2", [orgId, issueId]),
    latest
      ? query(
          `SELECT url, final_url, status_code, final_status_code, redirect_chain, redirect_target, outcome, depth, title,
                  meta_description, canonicals, robots_meta, x_robots_tag, h1_count, images_total, images_missing_alt,
                  images_missing_alt_sample, indexable, indexability_reasons, in_sitemap, fetch_error
             FROM crawl_pages WHERE org_id = $1 AND scan_id = $2 AND url = $3`,
          [orgId, latest.scan_id, issue.url],
        )
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);
  const rule = ruleInfo(issue.rule_id);
  return {
    ...issue,
    rule: { id: rule.ruleId, category: rule.category, title: rule.groupTitle, explanation: rule.explanation, remediation: rule.remediation, provenance: rule.provenance, source: rule.source },
    occurrences,
    occurrenceCount: Number(occurrenceCount[0]?.n ?? 0),
    latestCrawl: latest ? { scanId: latest.scan_id, crawledAt: latest.created_at, page: pageRows[0] ?? null } : null,
  };
}

export async function getIssueHistory(orgId: string, websiteId: string, issueId: string) {
  const { rows: issue } = await query("SELECT id FROM site_issues WHERE id = $1 AND org_id = $2 AND website_id = $3", [issueId, orgId, websiteId]);
  if (issue.length === 0) return null;
  // Actor names only for members of this organization.
  const { rows } = await query(
    `SELECT e.id, e.event, e.scan_id, e.actor_id, e.note, e.created_at,
            CASE WHEN m.user_id IS NOT NULL THEN u.full_name END AS actor_name
       FROM site_issue_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN memberships m ON m.user_id = e.actor_id AND m.org_id = e.org_id
      WHERE e.org_id = $1 AND e.issue_id = $2 ORDER BY e.id`,
    [orgId, issueId],
  );
  return rows;
}

export class IssueTransitionError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_ISSUE_TRANSITION";
}

/**
 * OPEN or FIXED -> IGNORED (with a reason); IGNORED -> OPEN. Row-locked, in
 * one transaction with its history event. Returns null when the issue is not
 * in this org/website.
 */
export async function setIssueIgnored(
  input: { orgId: string; websiteId: string; issueId: string; actorId: string; ignore: boolean; reason?: string },
) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: IssueStatus }>(
      "SELECT id, status FROM site_issues WHERE id = $1 AND org_id = $2 AND website_id = $3 FOR UPDATE",
      [input.issueId, input.orgId, input.websiteId],
    );
    const issue = rows[0];
    if (!issue) return null;
    if (input.ignore && issue.status === "IGNORED") throw new IssueTransitionError("Issue is already ignored");
    if (!input.ignore && issue.status !== "IGNORED") throw new IssueTransitionError("Only ignored issues can be reopened");
    const { rows: updated } = await tx.query(
      input.ignore
        ? `UPDATE site_issues SET status = 'IGNORED', ignored_at = NOW(), ignored_by = $3, ignore_reason = $4, updated_at = NOW()
            WHERE id = $1 AND org_id = $2 RETURNING ${ISSUE_COLUMNS}`
        : `UPDATE site_issues SET status = 'OPEN', ignored_at = NULL, ignored_by = NULL, ignore_reason = NULL, updated_at = NOW()
            WHERE id = $1 AND org_id = $2 RETURNING ${ISSUE_COLUMNS}`,
      input.ignore ? [issue.id, input.orgId, input.actorId, input.reason ?? null] : [issue.id, input.orgId],
    );
    await tx.query(
      "INSERT INTO site_issue_events (org_id, issue_id, event, actor_id, note) VALUES ($1,$2,$3,$4,$5)",
      [input.orgId, issue.id, input.ignore ? "IGNORED" : "UNIGNORED", input.actorId, input.ignore ? input.reason ?? null : null],
    );
    return updated[0];
  });
}
