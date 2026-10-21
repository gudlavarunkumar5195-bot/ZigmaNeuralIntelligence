import { query, withTransaction, type Queryable } from "../db/client.js";
import { issueFingerprint, type CrawlIssue, type CrawlResult } from "../scanner/crawl.js";

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
 * "Scope re-checked" means this crawl actually fetched what the issue is
 * about, or the crawl was complete (not truncated) and no longer reaches the
 * URL at all. An issue on a page a truncated crawl did not reach (budget) is
 * left alone: absence of evidence is not a fix.
 */

const MAX_ISSUES_PER_SCAN = 2_000;
const KEEP_CRAWLS_PER_WEBSITE = 2;
const SITE_LEVEL_RULES = new Set(["robots_txt_unreachable", "robots_txt_missing", "sitemap_missing", "sitemap_invalid", "sitemap_unavailable", "start_url_blocked_by_robots"]);
const LINK_RULES = new Set(["broken_internal_link", "internal_link_to_redirect"]);
const DUPLICATE_RULES = new Set(["title_duplicate", "meta_description_duplicate"]);

export type IssueStatus = "OPEN" | "FIXED" | "IGNORED";

function statusBucket(status: number): string {
  if (status === 0) return "error";
  return `${Math.floor(status / 100)}xx`;
}

export async function persistCrawl(
  tx: Queryable,
  input: { scanId: string; orgId: string; websiteId: string; result: CrawlResult; issues: CrawlIssue[]; completed: boolean },
): Promise<{ detected: number; reopened: number; fixed: number }> {
  const { scanId, orgId, websiteId, result } = input;
  const issues = input.issues.slice(0, MAX_ISSUES_PER_SCAN);
  const statusCounts: Record<string, number> = {};
  for (const p of result.pages) statusCounts[statusBucket(p.status)] = (statusCounts[statusBucket(p.status)] ?? 0) + 1;
  const issueCounts: Record<string, number> = {};
  for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] ?? 0) + 1;
  const s = result.summary;

  await tx.query(
    `INSERT INTO crawl_summaries
       (scan_id, org_id, website_id, start_url, pages_crawled, pages_discovered, max_pages, truncated, truncated_reason,
        robots_status, start_blocked_by_robots, sitemap_status, sitemap_files, sitemap_url_count, status_counts, issue_counts, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,$17)
     ON CONFLICT (scan_id) DO UPDATE SET
       pages_crawled = EXCLUDED.pages_crawled, pages_discovered = EXCLUDED.pages_discovered, truncated = EXCLUDED.truncated,
       truncated_reason = EXCLUDED.truncated_reason, robots_status = EXCLUDED.robots_status,
       start_blocked_by_robots = EXCLUDED.start_blocked_by_robots, sitemap_status = EXCLUDED.sitemap_status,
       sitemap_files = EXCLUDED.sitemap_files, sitemap_url_count = EXCLUDED.sitemap_url_count,
       status_counts = EXCLUDED.status_counts, issue_counts = EXCLUDED.issue_counts, duration_ms = EXCLUDED.duration_ms`,
    [
      scanId, orgId, websiteId, s.startUrl, s.pagesCrawled, s.pagesDiscovered, s.maxPages, s.truncated, s.truncatedReason,
      s.robotsStatus, s.startBlockedByRobots, s.sitemapStatus, JSON.stringify(s.sitemapFiles), s.sitemapUrlCount,
      JSON.stringify(statusCounts), JSON.stringify(issueCounts), Math.max(0, Math.round(s.durationMs)),
    ],
  );

  if (result.pages.length > 0) {
    const rows = result.pages.map((p) => ({
      url: p.url, final_url: p.finalUrl, status_code: p.status, final_status_code: p.finalStatus,
      redirect_chain: p.redirectChain, depth: p.depth, discovered_from: p.discoveredFrom, content_type: p.contentType,
      title: p.title?.slice(0, 1000) ?? null, meta_description: p.metaDescription?.slice(0, 2000) ?? null,
      canonicals: p.canonicals.slice(0, 10), robots_meta: p.robotsMeta?.slice(0, 500) ?? null, h1_count: p.h1Count,
      internal_links_out: p.internalLinks.length, inlinks: result.inlinks[p.url]?.length ?? 0, indexable: p.indexable,
      in_sitemap: p.inSitemap, fetch_error: p.fetchError?.slice(0, 500) ?? null, response_ms: Math.max(0, Math.round(p.responseMs)),
    }));
    await tx.query(
      `INSERT INTO crawl_pages
         (scan_id, org_id, website_id, url, final_url, status_code, final_status_code, redirect_chain, depth, discovered_from,
          content_type, title, meta_description, canonicals, robots_meta, h1_count, internal_links_out, inlinks, indexable,
          in_sitemap, fetch_error, response_ms)
       SELECT $1, $2, $3, x.url, x.final_url, x.status_code, x.final_status_code, COALESCE(x.redirect_chain, '[]'::jsonb), x.depth,
              x.discovered_from, x.content_type, x.title, x.meta_description, COALESCE(x.canonicals, '[]'::jsonb), x.robots_meta,
              x.h1_count, x.internal_links_out, x.inlinks, x.indexable, x.in_sitemap, x.fetch_error, x.response_ms
         FROM jsonb_to_recordset($4::jsonb) AS x(
           url text, final_url text, status_code int, final_status_code int, redirect_chain jsonb, depth int,
           discovered_from text, content_type text, title text, meta_description text, canonicals jsonb, robots_meta text,
           h1_count int, internal_links_out int, inlinks int, indexable boolean, in_sitemap boolean, fetch_error text,
           response_ms int)
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

  if (!input.completed) return { detected: 0, reopened: 0, fixed: 0 };
  return reconcileIssues(tx, { scanId, orgId, websiteId, result, issues });
}

/** Which issue scopes this crawl re-checked (so absence means fixed). */
export function observedScope(result: CrawlResult) {
  const crawled = new Set(result.pages.map((p) => p.url));
  const checkedSitemaps = new Set(result.summary.sitemapFiles.map((f) => f.url));
  return {
    covers(issue: { rule_id: string; url: string; details: Record<string, unknown> }): boolean {
      if (SITE_LEVEL_RULES.has(issue.rule_id)) return true;
      if (DUPLICATE_RULES.has(issue.rule_id)) {
        // Only a full (untruncated) crawl can say a duplicate group is gone.
        if (result.summary.truncated) return false;
        const pages = Array.isArray(issue.details.pages) ? (issue.details.pages as string[]) : [issue.url];
        return pages.every((u) => crawled.has(u));
      }
      if (crawled.has(issue.url) || checkedSitemaps.has(issue.url)) return true;
      // A complete (untruncated) crawl that no longer reaches a URL means it is
      // neither linked nor listed in a sitemap any more: resolved.
      if (!result.summary.truncated) return true;
      if (LINK_RULES.has(issue.rule_id)) {
        const sources = Array.isArray(issue.details.linkedFrom) ? (issue.details.linkedFrom as string[]) : [];
        return sources.length > 0 && sources.every((u) => crawled.has(u));
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
  const seen = new Set<string>();

  for (const issue of input.issues) {
    const fingerprint = issueFingerprint(issue);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const { rows: existing } = await tx.query<{ id: string; status: IssueStatus }>(
      "SELECT id, status FROM site_issues WHERE website_id = $1 AND org_id = $2 AND fingerprint = $3 FOR UPDATE",
      [websiteId, orgId, fingerprint],
    );
    if (existing.length === 0) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO site_issues (org_id, website_id, fingerprint, rule_id, severity, url, title, details, first_seen_scan_id, last_seen_scan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9) RETURNING id`,
        [orgId, websiteId, fingerprint, issue.ruleId, issue.severity, issue.url, issue.title.slice(0, 500), JSON.stringify(issue.details), scanId],
      );
      await tx.query("INSERT INTO site_issue_events (org_id, issue_id, scan_id, event) VALUES ($1,$2,$3,'DETECTED')", [orgId, rows[0].id, scanId]);
      detected++;
      continue;
    }
    const prev = existing[0];
    const reopen = prev.status === "FIXED";
    await tx.query(
      `UPDATE site_issues
          SET severity = $3, title = $4, details = $5::jsonb, last_seen_scan_id = $6, last_seen_at = NOW(), updated_at = NOW(),
              status = CASE WHEN status = 'FIXED' THEN 'OPEN' ELSE status END,
              times_reopened = times_reopened + CASE WHEN status = 'FIXED' THEN 1 ELSE 0 END,
              fixed_at = CASE WHEN status = 'FIXED' THEN NULL ELSE fixed_at END,
              fixed_in_scan_id = CASE WHEN status = 'FIXED' THEN NULL ELSE fixed_in_scan_id END
        WHERE id = $1 AND org_id = $2`,
      [prev.id, orgId, issue.severity, issue.title.slice(0, 500), JSON.stringify(issue.details), scanId],
    );
    if (reopen) {
      await tx.query("INSERT INTO site_issue_events (org_id, issue_id, scan_id, event) VALUES ($1,$2,$3,'REOPENED')", [orgId, prev.id, scanId]);
      reopened++;
    }
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

export async function getLatestCrawlSummary(orgId: string, websiteId: string) {
  const { rows } = await query(
    `SELECT cs.*, s.status AS scan_status, s.completed_at AS scan_completed_at
       FROM crawl_summaries cs JOIN scans s ON s.id = cs.scan_id AND s.org_id = cs.org_id
      WHERE cs.org_id = $1 AND cs.website_id = $2
      ORDER BY cs.created_at DESC, cs.scan_id DESC LIMIT 1`,
    [orgId, websiteId],
  );
  return rows[0] ?? null;
}

export const PAGE_STATUS_FILTERS = ["2xx", "3xx", "4xx", "5xx", "error"] as const;

export async function listCrawlPages(
  orgId: string,
  scanId: string,
  filters: { statusClass?: (typeof PAGE_STATUS_FILTERS)[number] },
  page: { pageSize: number; offset: number },
) {
  const conditions = ["org_id = $1", "scan_id = $2"];
  const params: unknown[] = [orgId, scanId];
  if (filters.statusClass === "error") conditions.push("status_code = 0");
  else if (filters.statusClass) {
    params.push(Number(filters.statusClass[0]) * 100);
    conditions.push(`status_code >= $${params.length} AND status_code < $${params.length} + 100`);
  }
  params.push(page.pageSize, page.offset);
  const { rows } = await query(
    `SELECT url, final_url, status_code, final_status_code, redirect_chain, depth, content_type, title, canonicals,
            robots_meta, h1_count, internal_links_out, inlinks, indexable, in_sitemap, fetch_error, response_ms
       FROM crawl_pages WHERE ${conditions.join(" AND ")}
      ORDER BY status_code DESC, url ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function listIssues(
  orgId: string,
  websiteId: string,
  filters: { status?: IssueStatus; ruleId?: string; severity?: string },
  page: { pageSize: number; offset: number },
) {
  const conditions = ["org_id = $1", "website_id = $2"];
  const params: unknown[] = [orgId, websiteId];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.ruleId) { params.push(filters.ruleId); conditions.push(`rule_id = $${params.length}`); }
  if (filters.severity) { params.push(filters.severity); conditions.push(`severity = $${params.length}`); }
  const where = conditions.join(" AND ");
  const countParams = [...params];
  params.push(page.pageSize, page.offset);
  const [{ rows }, { rows: totals }] = await Promise.all([
    query(
      `SELECT id, rule_id, severity, url, title, details, status, first_seen_at, last_seen_at, fixed_at, ignored_at,
              ignore_reason, times_reopened, first_seen_scan_id, last_seen_scan_id, fixed_in_scan_id
         FROM site_issues WHERE ${where}
        ORDER BY CASE status WHEN 'OPEN' THEN 0 WHEN 'IGNORED' THEN 1 ELSE 2 END,
                 CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                 last_seen_at DESC, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query<{ status: IssueStatus; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM site_issues WHERE org_id = $1 AND website_id = $2 GROUP BY status`,
      countParams.slice(0, 2),
    ),
  ]);
  const counts = { OPEN: 0, FIXED: 0, IGNORED: 0 } as Record<IssueStatus, number>;
  for (const t of totals) counts[t.status] = Number(t.n);
  return { issues: rows, counts };
}

export async function getIssueHistory(orgId: string, websiteId: string, issueId: string) {
  const { rows: issue } = await query("SELECT id FROM site_issues WHERE id = $1 AND org_id = $2 AND website_id = $3", [issueId, orgId, websiteId]);
  if (issue.length === 0) return null;
  const { rows } = await query(
    "SELECT event, scan_id, actor_id, note, created_at FROM site_issue_events WHERE org_id = $1 AND issue_id = $2 ORDER BY id",
    [orgId, issueId],
  );
  return rows;
}

export class IssueTransitionError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_ISSUE_TRANSITION";
}

/** OPEN or FIXED -> IGNORED (with a reason); IGNORED -> OPEN. Returns null when not found in this org/website. */
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
            WHERE id = $1 AND org_id = $2 RETURNING id, status, ignored_at, ignore_reason`
        : `UPDATE site_issues SET status = 'OPEN', ignored_at = NULL, ignored_by = NULL, ignore_reason = NULL, updated_at = NOW()
            WHERE id = $1 AND org_id = $2 RETURNING id, status, ignored_at, ignore_reason`,
      input.ignore ? [issue.id, input.orgId, input.actorId, input.reason ?? null] : [issue.id, input.orgId],
    );
    await tx.query(
      "INSERT INTO site_issue_events (org_id, issue_id, event, actor_id, note) VALUES ($1,$2,$3,$4,$5)",
      [input.orgId, issue.id, input.ignore ? "IGNORED" : "UNIGNORED", input.actorId, input.ignore ? input.reason ?? null : null],
    );
    return updated[0];
  });
}
