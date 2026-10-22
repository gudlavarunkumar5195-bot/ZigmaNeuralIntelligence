-- 037: Content intelligence (additive only).
--
-- content_pages: persistent content inventory per website and normalized URL,
--   upserted from every crawl (crawl_pages keeps only the last crawls). Holds
--   bounded content features (headings, word count, hashes, top terms, a
--   capped text excerpt) and crawl state kept apart from content quality.
-- content_audit_runs: one analysis per crawl (idempotent), leased jobs.
-- content_findings (+ events): content rules with a stable fingerprint and a
--   lifecycle; the same unchanged issue is updated, never duplicated.
-- content_topics (+ members): deterministic clusters of pages and Search
--   Console queries; manual names and assignments are preserved.
-- content_opportunities (+ events): evidence-backed recommendations with a
--   transparent priority and a lifecycle; baseline metrics at completion.
-- content_briefs (+ revisions): editable briefs; every save is a revision.

CREATE TABLE IF NOT EXISTS content_pages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL,
  website_id           UUID        NOT NULL,
  url                  TEXT        NOT NULL CHECK (char_length(url) <= 2048),
  url_key              TEXT        NOT NULL CHECK (char_length(url_key) = 64),
  crawl_state          TEXT        NOT NULL CHECK (crawl_state IN ('ok', 'not_html', 'http_error', 'fetch_failed', 'blocked_by_robots', 'redirected', 'not_reached')),
  http_status          INTEGER,
  canonical_url        TEXT        CHECK (char_length(canonical_url) <= 2048),
  indexable            BOOLEAN,
  indexability_reasons TEXT[]      NOT NULL DEFAULT '{}',
  in_sitemap           BOOLEAN     NOT NULL DEFAULT FALSE,
  inlinks              INTEGER,
  title                TEXT        CHECK (char_length(title) <= 1000),
  meta_description     TEXT        CHECK (char_length(meta_description) <= 2000),
  h1s                  TEXT[]      NOT NULL DEFAULT '{}',
  headings             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  word_count           INTEGER     CHECK (word_count >= 0),
  language             TEXT        CHECK (char_length(language) <= 20),
  internal_links       INTEGER,
  external_links       INTEGER,
  images_total         INTEGER,
  images_missing_alt   INTEGER,
  structured_data      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  modified_at          TIMESTAMPTZ,
  modified_source      TEXT        CHECK (char_length(modified_source) <= 60),
  content_hash         TEXT        CHECK (char_length(content_hash) = 64),
  simhash              TEXT        CHECK (simhash ~ '^[0-9a-f]{16}$'),
  top_terms            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  text_excerpt         TEXT        CHECK (char_length(text_excerpt) <= 20000),
  crawl_error          TEXT        CHECK (char_length(crawl_error) <= 500),
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_crawled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_changed_at   TIMESTAMPTZ,
  last_scan_id         UUID,
  CONSTRAINT content_pages_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_pages_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT content_pages_url_unique UNIQUE (website_id, url_key)
);
CREATE INDEX IF NOT EXISTS idx_content_pages_list ON content_pages (org_id, website_id, url);
CREATE INDEX IF NOT EXISTS idx_content_pages_hash ON content_pages (website_id, content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_audit_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  website_id       UUID        NOT NULL,
  scan_id          UUID,
  trigger          TEXT        NOT NULL CHECK (trigger IN ('crawl', 'manual')),
  status           TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  rules_version    TEXT        NOT NULL,
  pages_analyzed   INTEGER     NOT NULL DEFAULT 0,
  findings_open    INTEGER     NOT NULL DEFAULT 0,
  findings_new     INTEGER     NOT NULL DEFAULT 0,
  findings_resolved INTEGER    NOT NULL DEFAULT 0,
  opportunities    INTEGER     NOT NULL DEFAULT 0,
  claims           INTEGER     NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_until      TIMESTAMPTZ,
  error            TEXT        CHECK (char_length(error) <= 500),
  requested_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT content_audit_runs_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_audit_runs_id_org_unique UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_runs_active ON content_audit_runs (website_id) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_runs_crawl ON content_audit_runs (website_id, scan_id) WHERE trigger = 'crawl';
CREATE INDEX IF NOT EXISTS idx_content_runs_queue ON content_audit_runs (status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS content_findings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL,
  website_id        UUID        NOT NULL,
  page_id           UUID,
  fingerprint       TEXT        NOT NULL CHECK (char_length(fingerprint) = 64),
  rule_id           TEXT        NOT NULL CHECK (rule_id ~ '^[a-z0-9_]{1,64}$'),
  rule_version      TEXT        NOT NULL,
  category          TEXT        NOT NULL CHECK (category IN ('metadata', 'headings', 'content', 'duplication', 'links', 'structured_data', 'freshness', 'images')),
  severity          TEXT        NOT NULL CHECK (severity IN ('high', 'medium', 'low', 'info')),
  heuristic         BOOLEAN     NOT NULL DEFAULT FALSE,
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  explanation       TEXT        NOT NULL CHECK (char_length(explanation) <= 1000),
  recommendation    TEXT        NOT NULL CHECK (char_length(recommendation) <= 1000),
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'ignored')),
  ignore_reason     TEXT        CHECK (char_length(ignore_reason) <= 500),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  last_run_id       UUID,
  updated_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT content_findings_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_findings_page_fk FOREIGN KEY (page_id, org_id) REFERENCES content_pages (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_findings_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT content_findings_fingerprint_unique UNIQUE (website_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_content_findings_list ON content_findings (org_id, website_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_content_findings_page ON content_findings (page_id);

CREATE TABLE IF NOT EXISTS content_finding_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  finding_id  UUID        NOT NULL,
  event       TEXT        NOT NULL CHECK (event IN ('detected', 'resolved', 'reopened', 'status_changed')),
  from_status TEXT,
  to_status   TEXT,
  run_id      UUID,
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT        CHECK (char_length(note) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), -- ordered within one transaction
  CONSTRAINT content_finding_events_finding_fk FOREIGN KEY (finding_id, org_id) REFERENCES content_findings (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_finding_events ON content_finding_events (finding_id, created_at);

CREATE TABLE IF NOT EXISTS content_topics (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  website_id  UUID        NOT NULL,
  topic_key   TEXT        NOT NULL CHECK (char_length(topic_key) BETWEEN 1 AND 120),
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  name_locked BOOLEAN     NOT NULL DEFAULT FALSE,
  source      TEXT        NOT NULL CHECK (source IN ('auto', 'manual')),
  terms       TEXT[]      NOT NULL DEFAULT '{}',
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_topics_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_topics_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT content_topics_key_unique UNIQUE (website_id, topic_key)
);

CREATE TABLE IF NOT EXISTS content_topic_members (
  org_id      UUID        NOT NULL,
  topic_id    UUID        NOT NULL,
  member_type TEXT        NOT NULL CHECK (member_type IN ('page', 'query')),
  member_key  TEXT        NOT NULL CHECK (char_length(member_key) BETWEEN 1 AND 300),
  assignment  TEXT        NOT NULL CHECK (assignment IN ('auto', 'manual')),
  excluded    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (topic_id, member_type, member_key),
  CONSTRAINT content_topic_members_topic_fk FOREIGN KEY (topic_id, org_id) REFERENCES content_topics (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_topic_members_key ON content_topic_members (org_id, member_type, member_key);

CREATE TABLE IF NOT EXISTS content_opportunities (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL,
  website_id        UUID        NOT NULL,
  fingerprint       TEXT        NOT NULL CHECK (char_length(fingerprint) = 64),
  kind              TEXT        NOT NULL CHECK (kind IN ('low_ctr_snippet', 'missing_description', 'under_covered_topic', 'competitor_topic_gap', 'consolidate_overlap', 'internal_links', 'refresh_stale', 'declining_page')),
  page_id           UUID,
  topic_id          UUID,
  title             TEXT        NOT NULL CHECK (char_length(title) <= 300),
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  problem           TEXT        NOT NULL CHECK (char_length(problem) <= 1000),
  action            TEXT        NOT NULL CHECK (char_length(action) <= 1000),
  priority          INTEGER     NOT NULL CHECK (priority BETWEEN 0 AND 100),
  priority_factors  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence        TEXT        NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  confidence_basis  TEXT        NOT NULL CHECK (char_length(confidence_basis) <= 300),
  missing_data      TEXT[]      NOT NULL DEFAULT '{}',
  effort            TEXT        NOT NULL CHECK (effort IN ('small', 'medium', 'large')),
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed', 'obsolete')),
  owner_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  baseline          JSONB,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT content_opportunities_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_opportunities_page_fk FOREIGN KEY (page_id, org_id) REFERENCES content_pages (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_opportunities_topic_fk FOREIGN KEY (topic_id, org_id) REFERENCES content_topics (id, org_id),
  CONSTRAINT content_opportunities_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT content_opportunities_fingerprint_unique UNIQUE (website_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_content_opportunities_list ON content_opportunities (org_id, website_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS content_opportunity_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL,
  opportunity_id UUID        NOT NULL,
  event          TEXT        NOT NULL CHECK (event IN ('detected', 'status_changed', 'feedback', 'assigned', 'obsolete')),
  from_status    TEXT,
  to_status      TEXT,
  feedback       TEXT        CHECK (feedback IN ('useful', 'not_useful')),
  note           TEXT        CHECK (char_length(note) <= 1000),
  actor_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), -- ordered within one transaction
  CONSTRAINT content_opportunity_events_fk FOREIGN KEY (opportunity_id, org_id) REFERENCES content_opportunities (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_opportunity_events ON content_opportunity_events (opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS content_briefs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  website_id       UUID        NOT NULL,
  page_id          UUID,
  topic_id         UUID,
  opportunity_id   UUID,
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status           TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved')),
  current_revision INTEGER     NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  approved_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_briefs_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT content_briefs_page_fk FOREIGN KEY (page_id, org_id) REFERENCES content_pages (id, org_id),
  CONSTRAINT content_briefs_topic_fk FOREIGN KEY (topic_id, org_id) REFERENCES content_topics (id, org_id),
  CONSTRAINT content_briefs_opportunity_fk FOREIGN KEY (opportunity_id, org_id) REFERENCES content_opportunities (id, org_id),
  CONSTRAINT content_briefs_id_org_unique UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_content_briefs_list ON content_briefs (org_id, website_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS content_brief_revisions (
  org_id     UUID        NOT NULL,
  brief_id   UUID        NOT NULL,
  revision   INTEGER     NOT NULL CHECK (revision >= 1),
  body       JSONB       NOT NULL,
  source     TEXT        NOT NULL CHECK (source IN ('deterministic', 'ai_suggestion', 'edit')),
  ai_model   TEXT        CHECK (char_length(ai_model) <= 200),
  note       TEXT        CHECK (char_length(note) <= 500),
  created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brief_id, revision),
  CONSTRAINT content_brief_revisions_fk FOREIGN KEY (brief_id, org_id) REFERENCES content_briefs (id, org_id) ON DELETE CASCADE
);

ALTER TABLE content_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_finding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_topic_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_opportunity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_brief_revisions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON content_pages, content_audit_runs, content_findings, content_finding_events, content_topics, content_topic_members,
      content_opportunities, content_opportunity_events, content_briefs, content_brief_revisions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON content_pages, content_audit_runs, content_findings, content_finding_events, content_topics, content_topic_members,
      content_opportunities, content_opportunity_events, content_briefs, content_brief_revisions FROM anon;
  END IF;
END $$;
