-- Phase 2: complete technical SEO audit. Purely additive.
--
-- crawl_summaries: depth budget, robots-blocked count, whether the crawl could
--   reconcile issues, and the wider set of truncation reasons.
-- crawl_pages: per-URL crawl outcome, off-site redirect target, X-Robots-Tag,
--   image alt measurements and the reasons a page is not indexable.
-- site_issues: rule category (for filtering), backfilled for existing rows.
-- site_issue_scans: every scan in which an issue was observed.
-- scans: per-scan crawl options chosen by the user (validated and capped by
--   the API; they can only lower the server limits).

-- ─── crawl_summaries ─────────────────────────────────────────────────────────
ALTER TABLE crawl_summaries DROP CONSTRAINT IF EXISTS crawl_summaries_truncated_reason_check;
ALTER TABLE crawl_summaries ADD CONSTRAINT crawl_summaries_truncated_reason_check
  CHECK (truncated_reason IN ('page_limit', 'time_limit', 'depth_limit', 'discovery_limit', 'cancelled'));
ALTER TABLE crawl_summaries
  ADD COLUMN IF NOT EXISTS max_depth INTEGER CHECK (max_depth IS NULL OR max_depth >= 0),
  ADD COLUMN IF NOT EXISTS pages_blocked_by_robots INTEGER NOT NULL DEFAULT 0 CHECK (pages_blocked_by_robots >= 0),
  ADD COLUMN IF NOT EXISTS reconcilable BOOLEAN;

-- ─── crawl_pages ─────────────────────────────────────────────────────────────
ALTER TABLE crawl_pages
  ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'ok', 'redirect', 'redirect_out_of_scope', 'redirect_loop', 'http_error', 'fetch_error', 'too_large', 'non_html', 'blocked_by_robots')),
  ADD COLUMN IF NOT EXISTS redirect_target TEXT,
  ADD COLUMN IF NOT EXISTS x_robots_tag TEXT,
  ADD COLUMN IF NOT EXISTS images_total INTEGER CHECK (images_total IS NULL OR images_total >= 0),
  ADD COLUMN IF NOT EXISTS images_missing_alt INTEGER CHECK (images_missing_alt IS NULL OR images_missing_alt >= 0),
  ADD COLUMN IF NOT EXISTS images_missing_alt_sample JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS indexability_reasons TEXT[] NOT NULL DEFAULT '{}';

-- ─── site_issues.category ────────────────────────────────────────────────────
-- Must stay in step with SEO_RULES in server/src/scanner/crawl.ts (a test
-- checks every rule id here against the catalog).
ALTER TABLE site_issues ADD COLUMN IF NOT EXISTS category TEXT;
UPDATE site_issues SET category = CASE rule_id
    WHEN 'robots_txt_unreachable' THEN 'crawlability'
    WHEN 'robots_txt_missing' THEN 'crawlability'
    WHEN 'start_url_blocked_by_robots' THEN 'crawlability'
    WHEN 'sitemap_missing' THEN 'sitemaps'
    WHEN 'sitemap_invalid' THEN 'sitemaps'
    WHEN 'sitemap_unavailable' THEN 'sitemaps'
    WHEN 'sitemap_url_not_indexable' THEN 'sitemaps'
    WHEN 'sitemap_url_blocked_by_robots' THEN 'sitemaps'
    WHEN 'page_fetch_error' THEN 'status_codes'
    WHEN 'page_too_large' THEN 'status_codes'
    WHEN 'page_5xx' THEN 'status_codes'
    WHEN 'page_4xx' THEN 'status_codes'
    WHEN 'broken_internal_link' THEN 'links'
    WHEN 'internal_link_to_redirect' THEN 'links'
    WHEN 'redirect_loop' THEN 'redirects'
    WHEN 'redirect_chain' THEN 'redirects'
    WHEN 'redirect_off_site' THEN 'redirects'
    WHEN 'title_missing' THEN 'content'
    WHEN 'title_duplicate' THEN 'content'
    WHEN 'meta_description_missing' THEN 'content'
    WHEN 'meta_description_duplicate' THEN 'content'
    WHEN 'h1_missing' THEN 'content'
    WHEN 'h1_multiple' THEN 'content'
    WHEN 'canonical_missing' THEN 'canonicalization'
    WHEN 'canonical_multiple' THEN 'canonicalization'
    WHEN 'canonical_invalid' THEN 'canonicalization'
    WHEN 'canonical_cross_domain' THEN 'canonicalization'
    WHEN 'canonical_target_not_ok' THEN 'canonicalization'
    WHEN 'page_noindex' THEN 'indexability'
    WHEN 'page_nofollow' THEN 'indexability'
    WHEN 'img_alt_missing' THEN 'images'
    ELSE 'crawlability'
  END
 WHERE category IS NULL;
ALTER TABLE site_issues ALTER COLUMN category SET NOT NULL;
ALTER TABLE site_issues DROP CONSTRAINT IF EXISTS site_issues_category_check;
ALTER TABLE site_issues ADD CONSTRAINT site_issues_category_check CHECK (category IN (
  'crawlability', 'status_codes', 'links', 'redirects', 'content', 'canonicalization', 'indexability', 'sitemaps', 'images'));
CREATE INDEX IF NOT EXISTS idx_site_issues_category ON site_issues (org_id, website_id, category, status);

-- ─── site_issue_scans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_issue_scans (
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id    UUID NOT NULL,
  scan_id     UUID NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, scan_id),
  -- An occurrence links an issue and a scan of the SAME organization.
  CONSTRAINT site_issue_scans_issue_org_fk FOREIGN KEY (issue_id, org_id) REFERENCES site_issues (id, org_id) ON DELETE CASCADE,
  CONSTRAINT site_issue_scans_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_site_issue_scans_scan ON site_issue_scans (org_id, scan_id);

-- Backfill what is known for existing issues: the first and last scans that saw them.
INSERT INTO site_issue_scans (org_id, issue_id, scan_id, observed_at)
SELECT org_id, id, first_seen_scan_id, first_seen_at FROM site_issues WHERE first_seen_scan_id IS NOT NULL
UNION
SELECT org_id, id, last_seen_scan_id, last_seen_at FROM site_issues WHERE last_seen_scan_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ─── scans.crawl_options ─────────────────────────────────────────────────────
ALTER TABLE scans ADD COLUMN IF NOT EXISTS crawl_options JSONB;

-- Same posture as every other table: no direct Data API access.
ALTER TABLE site_issue_scans ENABLE ROW LEVEL SECURITY;
