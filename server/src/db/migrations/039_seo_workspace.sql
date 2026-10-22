-- 039: Unified SEO workspace (additive only).
--
-- Metrics stay in their modules; nothing here copies source data.
-- seo_insights (+ events): cross-module patterns found by deterministic rules,
--   with references to the source records that support them.
-- seo_action_states (+ events): workflow state (status, owner, due date, note)
--   for an action computed from a source record. The action itself is always
--   derived from its source (site issue, content opportunity, insight, ...);
--   only the user's workflow decisions are stored, keyed by a stable source
--   reference, so refreshing the dashboard never creates duplicates.

CREATE TABLE IF NOT EXISTS seo_insights (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL,
  website_id        UUID        NOT NULL,
  rule_id           TEXT        NOT NULL CHECK (rule_id ~ '^[a-z0-9_]{1,60}$'),
  rule_version      TEXT        NOT NULL CHECK (char_length(rule_version) <= 20),
  fingerprint       TEXT        NOT NULL CHECK (char_length(fingerprint) = 64),
  entity_type       TEXT        NOT NULL CHECK (entity_type IN ('website', 'page', 'keyword', 'competitor', 'source', 'topic')),
  entity_value      TEXT        NOT NULL CHECK (char_length(entity_value) BETWEEN 1 AND 2048),
  title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  explanation       TEXT        NOT NULL CHECK (char_length(explanation) <= 2000),
  action            TEXT        NOT NULL CHECK (char_length(action) <= 2000),
  evidence          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  modules           TEXT[]      NOT NULL CHECK (cardinality(modules) BETWEEN 1 AND 8),
  observed_from     DATE,
  observed_to       DATE,
  limitations       TEXT[]      NOT NULL DEFAULT '{}',
  priority          INTEGER     NOT NULL CHECK (priority BETWEEN 0 AND 100),
  priority_factors  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence        TEXT        NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed', 'obsolete')),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seo_insights_website_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT seo_insights_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT seo_insights_fingerprint_unique UNIQUE (website_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_seo_insights_list ON seo_insights (org_id, website_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS seo_insight_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  insight_id  UUID        NOT NULL,
  event       TEXT        NOT NULL CHECK (event IN ('detected', 'redetected', 'status_changed', 'feedback', 'obsolete')),
  from_status TEXT,
  to_status   TEXT,
  note        TEXT        CHECK (char_length(note) <= 1000),
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT seo_insight_events_fk FOREIGN KEY (insight_id, org_id) REFERENCES seo_insights (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seo_insight_events ON seo_insight_events (insight_id, created_at);

-- Bookkeeping for the last insight evaluation per website (freshness shown in the UI).
CREATE TABLE IF NOT EXISTS seo_insight_runs (
  org_id        UUID        NOT NULL,
  website_id    UUID        NOT NULL,
  evaluated_at  TIMESTAMPTZ NOT NULL,
  window_from   DATE        NOT NULL,
  window_to     DATE        NOT NULL,
  detected      INTEGER     NOT NULL CHECK (detected >= 0),
  skipped_rules JSONB       NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (website_id),
  CONSTRAINT seo_insight_runs_website_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS seo_action_states (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  website_id  UUID        NOT NULL,
  source      TEXT        NOT NULL CHECK (source IN ('site_issue', 'content_opportunity', 'content_finding', 'insight', 'aiv_opportunity', 'rank_alert', 'backlink_opportunity', 'integration')),
  source_ref  TEXT        NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 300),
  status      TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'dismissed')),
  owner_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  due_date    DATE,
  note        TEXT        CHECK (char_length(note) <= 1000),
  updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seo_action_states_website_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT seo_action_states_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT seo_action_states_ref_unique UNIQUE (website_id, source, source_ref)
);

CREATE TABLE IF NOT EXISTS seo_action_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  state_id    UUID        NOT NULL,
  event       TEXT        NOT NULL CHECK (event IN ('status_changed', 'assigned', 'due_date_changed', 'note')),
  from_value  TEXT        CHECK (char_length(from_value) <= 200),
  to_value    TEXT        CHECK (char_length(to_value) <= 200),
  note        TEXT        CHECK (char_length(note) <= 1000),
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT seo_action_events_fk FOREIGN KEY (state_id, org_id) REFERENCES seo_action_states (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seo_action_events ON seo_action_events (state_id, created_at);

ALTER TABLE seo_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_insight_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_insight_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_action_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_action_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON seo_insights, seo_insight_events, seo_insight_runs, seo_action_states, seo_action_events FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON seo_insights, seo_insight_events, seo_insight_runs, seo_action_states, seo_action_events FROM anon;
  END IF;
END $$;
