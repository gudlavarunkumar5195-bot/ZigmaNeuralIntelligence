-- 036: Rank tracking and SERP intelligence (additive only).
--
-- rank_projects: what is tracked for a website and under which search
--   configuration (engine, country, language, device, location). Keywords that
--   differ in configuration live in different projects, so they are never merged.
-- rank_keywords / rank_competitors: tracked keywords (soft-removed, history kept)
--   and competitor domains of a project.
-- rank_observations: one genuine observation per keyword, subject domain,
--   day and source. Status distinguishes a ranked position from "not in the
--   results down to depth N", "no data" and "collection failed"; a position is
--   only stored when one was observed.
-- rank_imports: authorized ranking-report imports (idempotent by content hash).
-- rank_collection_jobs / rank_provider_usage: provider collection (leased,
--   resumable, one active job per project) and per-day usage for quotas.
-- rank_alert_rules / rank_alert_events: evidence-based alerts, one event per
--   rule and triggering observation.

CREATE TABLE IF NOT EXISTS rank_projects (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id    UUID        NOT NULL,
  name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  search_engine TEXT        NOT NULL CHECK (search_engine IN ('google', 'bing')),
  country       TEXT        CHECK (country ~ '^[a-z]{2}$'),
  language      TEXT        CHECK (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  device        TEXT        CHECK (device IN ('desktop', 'mobile')),
  location      TEXT        CHECK (char_length(location) BETWEEN 1 AND 200),
  timezone      TEXT        NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  frequency     TEXT        NOT NULL DEFAULT 'manual' CHECK (frequency IN ('manual', 'daily', 'weekly')),
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rank_projects_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_projects_id_org_unique UNIQUE (id, org_id)
);
-- One non-archived project per website and search configuration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rank_projects_config ON rank_projects
  (org_id, website_id, search_engine, COALESCE(country, ''), COALESCE(language, ''), COALESCE(device, ''), COALESCE(location, ''))
  WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS rank_keywords (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL,
  project_id    UUID        NOT NULL,
  keyword       TEXT        NOT NULL CHECK (char_length(keyword) BETWEEN 1 AND 200),
  keyword_key   TEXT        NOT NULL CHECK (char_length(keyword_key) BETWEEN 1 AND 200),
  group_name    TEXT        CHECK (char_length(group_name) BETWEEN 1 AND 80),
  landing_page  TEXT        CHECK (char_length(landing_page) <= 2048),
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  source        TEXT        NOT NULL CHECK (source IN ('manual', 'csv', 'observation_import')),
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rank_keywords_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_keywords_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT rank_keywords_key_unique UNIQUE (project_id, keyword_key)
);
CREATE INDEX IF NOT EXISTS idx_rank_keywords_list ON rank_keywords (project_id, status, keyword_key);

CREATE TABLE IF NOT EXISTS rank_competitors (
  org_id      UUID        NOT NULL,
  project_id  UUID        NOT NULL,
  domain      TEXT        NOT NULL CHECK (domain ~ '^[a-z0-9.-]{1,253}$'),
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, domain),
  CONSTRAINT rank_competitors_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rank_imports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  project_id       UUID        NOT NULL,
  source_label     TEXT        NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 80),
  filename         TEXT        CHECK (char_length(filename) <= 255),
  content_sha256   TEXT        NOT NULL CHECK (char_length(content_sha256) = 64),
  rows_total       INTEGER     NOT NULL CHECK (rows_total >= 0),
  rows_accepted    INTEGER     NOT NULL CHECK (rows_accepted >= 0),
  rows_rejected    INTEGER     NOT NULL CHECK (rows_rejected >= 0),
  rows_duplicate   INTEGER     NOT NULL CHECK (rows_duplicate >= 0),
  rows_skipped     INTEGER     NOT NULL CHECK (rows_skipped >= 0),
  keywords_created INTEGER     NOT NULL DEFAULT 0 CHECK (keywords_created >= 0),
  rejected_samples JSONB       NOT NULL DEFAULT '[]'::jsonb,
  column_mapping   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rank_imports_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_imports_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT rank_imports_content_unique UNIQUE (project_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS rank_observations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  project_id      UUID        NOT NULL,
  keyword_id      UUID        NOT NULL,
  subject_domain  TEXT        NOT NULL CHECK (subject_domain ~ '^[a-z0-9.-]{1,253}$'),
  observed_date   DATE        NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('ranked', 'not_in_results', 'no_data', 'failed')),
  position        INTEGER     CHECK (position BETWEEN 1 AND 1000),
  result_depth    INTEGER     CHECK (result_depth BETWEEN 1 AND 1000),
  ranking_url     TEXT        CHECK (char_length(ranking_url) <= 2048),
  result_type     TEXT        CHECK (char_length(result_type) <= 40),
  search_engine   TEXT        NOT NULL,
  country         TEXT,
  language        TEXT,
  device          TEXT,
  serp_features   TEXT[]      NOT NULL DEFAULT '{}',
  owned_features  TEXT[]      NOT NULL DEFAULT '{}',
  source          TEXT        NOT NULL CHECK (source ~ '^[a-z0-9_]{1,40}$'),
  source_label    TEXT        NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 80),
  import_id       UUID,
  job_id          UUID,
  error_code      TEXT        CHECK (char_length(error_code) <= 60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rank_observations_keyword_fk FOREIGN KEY (keyword_id, org_id) REFERENCES rank_keywords (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_observations_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE,
  -- A position exists exactly when the result was observed ranked.
  CONSTRAINT rank_observations_position_status CHECK ((status = 'ranked') = (position IS NOT NULL)),
  CONSTRAINT rank_observations_owned_subset CHECK (owned_features <@ serp_features),
  CONSTRAINT rank_observations_unique UNIQUE (keyword_id, subject_domain, observed_date, source)
);
CREATE INDEX IF NOT EXISTS idx_rank_observations_history ON rank_observations (keyword_id, subject_domain, observed_date DESC);
CREATE INDEX IF NOT EXISTS idx_rank_observations_project_date ON rank_observations (org_id, project_id, observed_date DESC);

CREATE TABLE IF NOT EXISTS rank_collection_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  project_id       UUID        NOT NULL,
  provider         TEXT        NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  trigger          TEXT        NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status           TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  observed_date    DATE        NOT NULL,
  keywords_total   INTEGER     NOT NULL CHECK (keywords_total >= 0),
  keywords_done    INTEGER     NOT NULL DEFAULT 0 CHECK (keywords_done >= 0),
  keywords_failed  INTEGER     NOT NULL DEFAULT 0 CHECK (keywords_failed >= 0),
  claims           INTEGER     NOT NULL DEFAULT 0 CHECK (claims >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner      TEXT,
  lease_until      TIMESTAMPTZ,
  error            TEXT        CHECK (char_length(error) <= 500),
  requested_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT rank_collection_jobs_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rank_jobs_active ON rank_collection_jobs (project_id) WHERE status IN ('queued', 'running');
-- At most one scheduled run per project and day, even across restarts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rank_jobs_scheduled_day ON rank_collection_jobs (project_id, observed_date) WHERE trigger = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_rank_jobs_queue ON rank_collection_jobs (status, next_attempt_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS rank_provider_usage (
  org_id    UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider  TEXT    NOT NULL,
  day       DATE    NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  failures  INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (org_id, provider, day)
);

CREATE TABLE IF NOT EXISTS rank_alert_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  project_id  UUID        NOT NULL,
  rule_type   TEXT        NOT NULL CHECK (rule_type IN ('threshold_cross', 'position_change', 'url_change', 'became_unavailable', 'competitor_overtake', 'collection_failures')),
  params      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  keyword_id  UUID,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  notify      TEXT        NOT NULL DEFAULT 'in_app' CHECK (notify IN ('in_app', 'none')),
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rank_alert_rules_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_alert_rules_id_org_unique UNIQUE (id, org_id)
);

CREATE TABLE IF NOT EXISTS rank_alert_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  project_id      UUID        NOT NULL,
  rule_id         UUID        NOT NULL,
  keyword_id      UUID        NOT NULL,
  event_key       TEXT        NOT NULL CHECK (char_length(event_key) <= 200),
  observation_id  UUID,
  message         TEXT        NOT NULL CHECK (char_length(message) <= 500),
  evidence        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT rank_alert_events_rule_fk FOREIGN KEY (rule_id, org_id) REFERENCES rank_alert_rules (id, org_id) ON DELETE CASCADE,
  CONSTRAINT rank_alert_events_project_fk FOREIGN KEY (project_id, org_id) REFERENCES rank_projects (id, org_id) ON DELETE CASCADE,
  -- One event per rule and triggering evidence: re-evaluation never duplicates notifications.
  CONSTRAINT rank_alert_events_unique UNIQUE (rule_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_rank_alert_events_feed ON rank_alert_events (org_id, project_id, created_at DESC, id);

ALTER TABLE rank_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_collection_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_alert_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON rank_projects, rank_keywords, rank_competitors, rank_imports, rank_observations, rank_collection_jobs, rank_provider_usage, rank_alert_rules, rank_alert_events FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON rank_projects, rank_keywords, rank_competitors, rank_imports, rank_observations, rank_collection_jobs, rank_provider_usage, rank_alert_rules, rank_alert_events FROM anon;
  END IF;
END $$;
