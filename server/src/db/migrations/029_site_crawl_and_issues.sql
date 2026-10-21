-- SEO slice 1: multi-page technical crawl + persistent issues.
--
-- crawl_summaries / crawl_pages: what one scan's crawl observed. PostgreSQL
--   keeps pages for the most recent crawls per website only (pruned by the
--   app); long-term page history belongs in ClickHouse.
-- site_issues: one row per (website, fingerprint) across scans, with an
--   OPEN / FIXED / IGNORED lifecycle that users act on.
-- site_issue_events: append-only history of each issue's transitions.
-- Purely additive.

CREATE TABLE IF NOT EXISTS crawl_summaries (
  scan_id          UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id       UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  start_url        TEXT NOT NULL,
  pages_crawled    INTEGER NOT NULL CHECK (pages_crawled >= 0),
  pages_discovered INTEGER NOT NULL CHECK (pages_discovered >= 0),
  max_pages        INTEGER NOT NULL CHECK (max_pages >= 0),
  truncated        BOOLEAN NOT NULL DEFAULT FALSE,
  truncated_reason TEXT CHECK (truncated_reason IN ('page_limit', 'time_limit')),
  robots_status    TEXT NOT NULL CHECK (robots_status IN ('parsed', 'missing', 'unreachable')),
  start_blocked_by_robots BOOLEAN NOT NULL DEFAULT FALSE,
  sitemap_status   TEXT NOT NULL CHECK (sitemap_status IN ('found', 'missing', 'invalid', 'unsupported')),
  sitemap_files    JSONB NOT NULL DEFAULT '[]'::jsonb,
  sitemap_url_count INTEGER NOT NULL DEFAULT 0 CHECK (sitemap_url_count >= 0),
  status_counts    JSONB NOT NULL DEFAULT '{}'::jsonb,
  issue_counts     JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms      INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crawl_summaries_site ON crawl_summaries (org_id, website_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crawl_pages (
  id              BIGSERIAL PRIMARY KEY,
  scan_id         UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id      UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  final_url       TEXT NOT NULL,
  status_code     INTEGER NOT NULL CHECK (status_code >= 0),
  final_status_code INTEGER NOT NULL CHECK (final_status_code >= 0),
  redirect_chain  JSONB NOT NULL DEFAULT '[]'::jsonb,
  depth           INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  discovered_from TEXT,
  content_type    TEXT,
  title           TEXT,
  meta_description TEXT,
  canonicals      JSONB NOT NULL DEFAULT '[]'::jsonb,
  robots_meta     TEXT,
  h1_count        INTEGER,
  internal_links_out INTEGER NOT NULL DEFAULT 0,
  inlinks         INTEGER NOT NULL DEFAULT 0,
  indexable       BOOLEAN NOT NULL DEFAULT FALSE,
  in_sitemap      BOOLEAN NOT NULL DEFAULT FALSE,
  fetch_error     TEXT,
  response_ms     INTEGER NOT NULL DEFAULT 0 CHECK (response_ms >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crawl_pages_scan_url_unique UNIQUE (scan_id, url)
);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_org_scan ON crawl_pages (org_id, scan_id, final_status_code);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_site ON crawl_pages (org_id, website_id);

CREATE TABLE IF NOT EXISTS site_issues (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id         UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  rule_id            TEXT NOT NULL,
  severity           TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  url                TEXT NOT NULL,
  title              TEXT NOT NULL,
  details            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FIXED', 'IGNORED')),
  first_seen_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  last_seen_scan_id  UUID REFERENCES scans(id) ON DELETE SET NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fixed_at           TIMESTAMPTZ,
  fixed_in_scan_id   UUID REFERENCES scans(id) ON DELETE SET NULL,
  ignored_at         TIMESTAMPTZ,
  ignored_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  ignore_reason      TEXT CHECK (ignore_reason IS NULL OR length(ignore_reason) <= 500),
  times_reopened     INTEGER NOT NULL DEFAULT 0 CHECK (times_reopened >= 0),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_issues_website_fingerprint_unique UNIQUE (website_id, fingerprint),
  CONSTRAINT site_issues_id_org_unique UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_site_issues_site_status ON site_issues (org_id, website_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_site_issues_rule ON site_issues (org_id, website_id, rule_id);

CREATE TABLE IF NOT EXISTS site_issue_events (
  id         BIGSERIAL PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id   UUID NOT NULL,
  scan_id    UUID REFERENCES scans(id) ON DELETE SET NULL,
  event      TEXT NOT NULL CHECK (event IN ('DETECTED', 'FIXED', 'REOPENED', 'IGNORED', 'UNIGNORED')),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Composite FK: an event can only reference an issue of the same org.
  CONSTRAINT site_issue_events_issue_org_fk FOREIGN KEY (issue_id, org_id)
    REFERENCES site_issues (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_site_issue_events_issue ON site_issue_events (org_id, issue_id, id);

-- Tenant-consistent references: a row's website and scan must belong to the
-- row's own organization (same pattern as migration 022).
ALTER TABLE crawl_summaries
  ADD CONSTRAINT crawl_summaries_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  ADD CONSTRAINT crawl_summaries_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans (id, org_id) ON DELETE CASCADE;
ALTER TABLE crawl_pages
  ADD CONSTRAINT crawl_pages_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  ADD CONSTRAINT crawl_pages_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans (id, org_id) ON DELETE CASCADE;
ALTER TABLE site_issues
  ADD CONSTRAINT site_issues_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE;

-- Same posture as every other table: no direct Data API access.
ALTER TABLE crawl_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawl_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_issue_events ENABLE ROW LEVEL SECURITY;
