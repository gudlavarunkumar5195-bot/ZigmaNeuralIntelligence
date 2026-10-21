import type { CrawlOutcome, SeoCategory, TruncatedReason } from "../../../services/api";

export const CATEGORY_LABEL: Record<SeoCategory, string> = {
  crawlability: "Crawlability",
  status_codes: "Status codes",
  links: "Internal links",
  redirects: "Redirects",
  content: "Content",
  canonicalization: "Canonicals",
  indexability: "Indexability",
  sitemaps: "Sitemaps",
  images: "Images",
};

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export const OUTCOME_LABEL: Record<CrawlOutcome, string> = {
  ok: "Audited",
  redirect: "Redirect",
  redirect_out_of_scope: "Redirects off-site (not followed)",
  redirect_loop: "Redirect loop",
  http_error: "HTTP error",
  fetch_error: "Fetch failed",
  too_large: "Too large to audit",
  non_html: "Not HTML",
  blocked_by_robots: "Blocked by robots.txt",
};

/** Why a page is not eligible for indexing (measured signals only). */
export const INDEXABILITY_REASON: Record<string, string> = {
  status_not_200: "not a 200 response",
  noindex_meta: "noindex meta tag",
  noindex_header: "noindex X-Robots-Tag header",
  canonicalized_elsewhere: "canonical points elsewhere",
  redirect: "redirects",
  ...Object.fromEntries(Object.entries(OUTCOME_LABEL).map(([k, v]) => [k, v.toLowerCase()])),
};

export const TRUNCATION_LABEL: Record<TruncatedReason, string> = {
  page_limit: "the page limit",
  time_limit: "the time limit",
  depth_limit: "the link-depth limit",
  discovery_limit: "the URL discovery limit (too many URLs or query-string variants)",
  cancelled: "cancellation",
};

export const EVENT_LABEL: Record<string, string> = {
  DETECTED: "Detected",
  FIXED: "Fixed (no longer observed)",
  REOPENED: "Reopened (observed again)",
  IGNORED: "Ignored",
  UNIGNORED: "Reopened by a user",
};

export const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
