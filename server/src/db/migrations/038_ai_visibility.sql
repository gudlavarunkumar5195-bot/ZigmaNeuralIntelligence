-- 038: AI search visibility intelligence (additive only).
--
-- aiv_brands: monitored entities. A target brand belongs to the organization;
--   competitors are brands with kind 'competitor' under one target. Matching
--   terms (name, aliases, products, official domains, exclusions) are versioned
--   by config_version so derived mentions can be reprocessed traceably.
-- aiv_queries (+ versions): the question library of a target brand. Editing the
--   text creates a new immutable version; observations keep the version used.
-- aiv_runs / aiv_run_items: provider collection (leased, resumable, one active
--   run per brand, idempotent by key and by weekly schedule slot).
-- aiv_imports: manually observed answers imported by a user (idempotent by
--   content hash); they are never presented as provider API results.
-- aiv_observations: one immutable AI answer with provenance (provider, model,
--   surface, collection method, query version, timestamps). Exclusion is a
--   traceable update recorded in aiv_events, never a rewrite.
-- aiv_mentions / aiv_citations / aiv_sources: derived from an observation:
--   which monitored brands the answer names, and which URLs it cites. Sources
--   are only verified when a user asks; a citation alone proves nothing.
-- aiv_opportunities (+ events): evidence-backed recommendations.
-- aiv_ai_summaries: model-written interpretation, stored apart from measurements.
-- aiv_provider_usage: per-day request counts for quotas.

CREATE TABLE IF NOT EXISTS aiv_brands (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                  TEXT        NOT NULL CHECK (kind IN ('target', 'competitor')),
  parent_id             UUID,
  -- Optional link to one of the organization's websites (checked on write).
  website_id            UUID        REFERENCES websites(id) ON DELETE SET NULL,
  name                  TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  name_key              TEXT        NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 120),
  domains               TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(domains) <= 10),
  aliases               TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(aliases) <= 20),
  products              TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(products) <= 30),
  exclude_terms         TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(exclude_terms) <= 20),
  disambiguation        TEXT        CHECK (char_length(disambiguation) <= 1000),
  topics                TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 30),
  locations             TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(locations) <= 10),
  language              TEXT        CHECK (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  country               TEXT        CHECK (country ~ '^[a-z]{2}$'),
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  owner_id              UUID        REFERENCES users(id) ON DELETE SET NULL,
  schedule              TEXT        NOT NULL DEFAULT 'off' CHECK (schedule IN ('off', 'weekly')),
  schedule_provider     TEXT        CHECK (schedule_provider ~ '^[a-z0-9_]{1,40}$'),
  schedule_repeats      INTEGER     CHECK (schedule_repeats BETWEEN 1 AND 5),
  schedule_max_requests INTEGER     CHECK (schedule_max_requests BETWEEN 1 AND 1000),
  schedule_approved_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  schedule_approved_at  TIMESTAMPTZ,
  config_version        INTEGER     NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  created_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_brands_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_brands_parent_fk FOREIGN KEY (parent_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_brands_kind_parent CHECK ((kind = 'competitor') = (parent_id IS NOT NULL)),
  CONSTRAINT aiv_brands_schedule_target CHECK (kind = 'target' OR schedule = 'off'),
  CONSTRAINT aiv_brands_schedule_complete CHECK (schedule = 'off' OR (schedule_provider IS NOT NULL AND schedule_repeats IS NOT NULL AND schedule_max_requests IS NOT NULL AND schedule_approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_brands_target_name ON aiv_brands (org_id, name_key) WHERE kind = 'target' AND status <> 'archived';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_brands_competitor_name ON aiv_brands (parent_id, name_key) WHERE kind = 'competitor' AND status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_aiv_brands_org ON aiv_brands (org_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_aiv_brands_parent ON aiv_brands (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS aiv_queries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  brand_id         UUID        NOT NULL,
  text             TEXT        NOT NULL CHECK (char_length(text) BETWEEN 3 AND 500),
  text_key         TEXT        NOT NULL CHECK (char_length(text_key) BETWEEN 1 AND 500),
  topic            TEXT        CHECK (char_length(topic) BETWEEN 1 AND 80),
  language         TEXT        CHECK (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  country          TEXT        CHECK (country ~ '^[a-z]{2}$'),
  providers        TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(providers) <= 10),
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  version          INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  source           TEXT        NOT NULL CHECK (source IN ('manual', 'import')),
  last_run_at      TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_queries_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_queries_id_org_unique UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_queries_text ON aiv_queries (brand_id, text_key, COALESCE(language, ''), COALESCE(country, '')) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_aiv_queries_list ON aiv_queries (brand_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS aiv_query_versions (
  org_id      UUID        NOT NULL,
  query_id    UUID        NOT NULL,
  version     INTEGER     NOT NULL CHECK (version >= 1),
  text        TEXT        NOT NULL CHECK (char_length(text) BETWEEN 3 AND 500),
  topic       TEXT        CHECK (char_length(topic) BETWEEN 1 AND 80),
  language    TEXT,
  country     TEXT,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (query_id, version),
  CONSTRAINT aiv_query_versions_query_fk FOREIGN KEY (query_id, org_id) REFERENCES aiv_queries (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS aiv_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  brand_id         UUID        NOT NULL,
  provider         TEXT        NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  model            TEXT        CHECK (char_length(model) <= 200),
  trigger          TEXT        NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status           TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  repeats          INTEGER     NOT NULL CHECK (repeats BETWEEN 1 AND 5),
  items_total      INTEGER     NOT NULL CHECK (items_total >= 0),
  items_done       INTEGER     NOT NULL DEFAULT 0 CHECK (items_done >= 0),
  items_failed     INTEGER     NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  schedule_slot    TEXT        CHECK (char_length(schedule_slot) <= 20),
  idempotency_key  TEXT        CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  claims           INTEGER     NOT NULL DEFAULT 0 CHECK (claims >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner      TEXT,
  lease_until      TIMESTAMPTZ,
  error            TEXT        CHECK (char_length(error) <= 500),
  requested_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT aiv_runs_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_runs_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_runs_slot_scheduled CHECK ((trigger = 'scheduled') = (schedule_slot IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_runs_active ON aiv_runs (brand_id) WHERE status IN ('queued', 'running');
-- At most one scheduled run per brand and schedule slot (ISO week), even across restarts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_runs_slot ON aiv_runs (brand_id, schedule_slot) WHERE schedule_slot IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_aiv_runs_idempotency ON aiv_runs (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aiv_runs_queue ON aiv_runs (status, next_attempt_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_aiv_runs_brand ON aiv_runs (brand_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aiv_run_items (
  org_id          UUID        NOT NULL,
  run_id          UUID        NOT NULL,
  query_id        UUID        NOT NULL,
  query_version   INTEGER     NOT NULL CHECK (query_version >= 1),
  repeat_index    INTEGER     NOT NULL CHECK (repeat_index BETWEEN 1 AND 5),
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code      TEXT        CHECK (char_length(error_code) <= 60),
  observation_id  UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, query_id, repeat_index),
  CONSTRAINT aiv_run_items_run_fk FOREIGN KEY (run_id, org_id) REFERENCES aiv_runs (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_run_items_query_fk FOREIGN KEY (query_id, org_id) REFERENCES aiv_queries (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiv_run_items_pending ON aiv_run_items (run_id, status);

CREATE TABLE IF NOT EXISTS aiv_imports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  brand_id         UUID        NOT NULL,
  format           TEXT        NOT NULL CHECK (format IN ('csv', 'json')),
  source_label     TEXT        NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 80),
  filename         TEXT        CHECK (char_length(filename) <= 255),
  content_sha256   TEXT        NOT NULL CHECK (char_length(content_sha256) = 64),
  rows_total       INTEGER     NOT NULL CHECK (rows_total >= 0),
  rows_accepted    INTEGER     NOT NULL CHECK (rows_accepted >= 0),
  rows_rejected    INTEGER     NOT NULL CHECK (rows_rejected >= 0),
  rows_duplicate   INTEGER     NOT NULL CHECK (rows_duplicate >= 0),
  queries_created  INTEGER     NOT NULL DEFAULT 0 CHECK (queries_created >= 0),
  rejected_samples JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_imports_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_imports_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_imports_content_unique UNIQUE (brand_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS aiv_observations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL,
  brand_id             UUID        NOT NULL,
  query_id             UUID        NOT NULL,
  query_version        INTEGER     NOT NULL CHECK (query_version >= 1),
  query_text           TEXT        NOT NULL CHECK (char_length(query_text) BETWEEN 1 AND 500),
  provider             TEXT        NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  surface              TEXT        NOT NULL CHECK (surface ~ '^[a-z0-9_]{1,40}$'),
  model                TEXT        CHECK (char_length(model) <= 200),
  collection_method    TEXT        NOT NULL CHECK (collection_method IN ('provider_api', 'manual_import')),
  run_id               UUID,
  import_id            UUID,
  provider_request_id  TEXT        CHECK (char_length(provider_request_id) <= 200),
  observed_at          TIMESTAMPTZ NOT NULL,
  language             TEXT        CHECK (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  country              TEXT        CHECK (country ~ '^[a-z]{2}$'),
  web_grounded         BOOLEAN,
  answer_status        TEXT        NOT NULL CHECK (answer_status IN ('answered', 'truncated', 'empty', 'refused')),
  response_text        TEXT        CHECK (char_length(response_text) <= 100000),
  response_chars       INTEGER     NOT NULL CHECK (response_chars >= 0),
  response_sha256      TEXT        NOT NULL CHECK (char_length(response_sha256) = 64),
  response_retention   TEXT        NOT NULL CHECK (response_retention IN ('full', 'truncated', 'none')),
  usage                JSONB,
  prompt_version       TEXT        CHECK (char_length(prompt_version) <= 40),
  notes                TEXT        CHECK (char_length(notes) <= 1000),
  dedupe_key           TEXT        NOT NULL CHECK (char_length(dedupe_key) = 64),
  detector_version     INTEGER     NOT NULL CHECK (detector_version >= 1),
  excluded_at          TIMESTAMPTZ,
  excluded_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
  exclusion_reason     TEXT        CHECK (char_length(exclusion_reason) <= 500),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_observations_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_observations_query_fk FOREIGN KEY (query_id, org_id) REFERENCES aiv_queries (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_observations_run_fk FOREIGN KEY (run_id, org_id) REFERENCES aiv_runs (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_observations_import_fk FOREIGN KEY (import_id, org_id) REFERENCES aiv_imports (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_observations_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_observations_dedupe_unique UNIQUE (brand_id, dedupe_key),
  -- Provenance is exactly one of: a provider collection run, or a user import.
  CONSTRAINT aiv_observations_api_run CHECK ((collection_method = 'provider_api') = (run_id IS NOT NULL)),
  CONSTRAINT aiv_observations_import_src CHECK ((collection_method = 'manual_import') = (import_id IS NOT NULL)),
  CONSTRAINT aiv_observations_retention CHECK ((response_retention = 'none') = (response_text IS NULL)),
  CONSTRAINT aiv_observations_exclusion CHECK ((excluded_at IS NULL) = (exclusion_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_aiv_observations_feed ON aiv_observations (org_id, brand_id, observed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_aiv_observations_query ON aiv_observations (query_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiv_observations_stale ON aiv_observations (brand_id, detector_version);

CREATE TABLE IF NOT EXISTS aiv_mentions (
  org_id            UUID        NOT NULL,
  observation_id    UUID        NOT NULL,
  brand_id          UUID        NOT NULL,
  match_count       INTEGER     NOT NULL CHECK (match_count >= 1),
  first_offset      INTEGER     NOT NULL CHECK (first_offset >= 0),
  matched_terms     TEXT[]      NOT NULL CHECK (cardinality(matched_terms) BETWEEN 1 AND 20),
  matched_by        TEXT[]      NOT NULL CHECK (matched_by <@ ARRAY['name', 'alias', 'product', 'domain']::text[]),
  excerpt           TEXT        CHECK (char_length(excerpt) <= 400),
  detector_version  INTEGER     NOT NULL CHECK (detector_version >= 1),
  PRIMARY KEY (observation_id, brand_id),
  CONSTRAINT aiv_mentions_observation_fk FOREIGN KEY (observation_id, org_id) REFERENCES aiv_observations (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_mentions_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiv_mentions_brand ON aiv_mentions (brand_id, observation_id);

CREATE TABLE IF NOT EXISTS aiv_sources (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID        NOT NULL,
  brand_id                  UUID        NOT NULL,
  url_key                   TEXT        NOT NULL CHECK (char_length(url_key) = 64),
  normalized_url            TEXT        NOT NULL CHECK (char_length(normalized_url) <= 2048),
  host                      TEXT        NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  registrable_domain        TEXT        CHECK (registrable_domain ~ '^[a-z0-9.-]{1,253}$'),
  idn                       BOOLEAN     NOT NULL DEFAULT FALSE,
  title                     TEXT        CHECK (char_length(title) <= 300),
  first_observed_at         TIMESTAMPTZ NOT NULL,
  last_observed_at          TIMESTAMPTZ NOT NULL,
  verification_status       TEXT        NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'reachable_mentions_brand', 'reachable_no_mention', 'unreachable', 'blocked_by_robots', 'not_html', 'unsafe_url', 'error')),
  verification_http_status  INTEGER,
  verified_at               TIMESTAMPTZ,
  verified_by               UUID        REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT aiv_sources_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_sources_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_sources_url_unique UNIQUE (brand_id, url_key)
);
CREATE INDEX IF NOT EXISTS idx_aiv_sources_host ON aiv_sources (brand_id, host);

CREATE TABLE IF NOT EXISTS aiv_citations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  observation_id   UUID        NOT NULL,
  source_id        UUID        NOT NULL,
  position         INTEGER     CHECK (position BETWEEN 1 AND 1000),
  original_url     TEXT        NOT NULL CHECK (char_length(original_url) <= 2048),
  title            TEXT        CHECK (char_length(title) <= 300),
  kind             TEXT        NOT NULL CHECK (kind IN ('provider_annotation', 'provider_citation_list', 'inline_text_url', 'imported')),
  cited_brand_id   UUID,
  CONSTRAINT aiv_citations_observation_fk FOREIGN KEY (observation_id, org_id) REFERENCES aiv_observations (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_citations_source_fk FOREIGN KEY (source_id, org_id) REFERENCES aiv_sources (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_citations_brand_fk FOREIGN KEY (cited_brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_citations_unique UNIQUE (observation_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_aiv_citations_source ON aiv_citations (source_id);

CREATE TABLE IF NOT EXISTS aiv_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  brand_id        UUID        NOT NULL,
  observation_id  UUID,
  event           TEXT        NOT NULL CHECK (event IN ('observation_excluded', 'observation_included', 'mentions_reprocessed', 'schedule_changed')),
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aiv_events_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_events_observation_fk FOREIGN KEY (observation_id, org_id) REFERENCES aiv_observations (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiv_events_brand ON aiv_events (brand_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aiv_opportunities (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL,
  brand_id          UUID        NOT NULL,
  kind              TEXT        NOT NULL CHECK (kind IN ('frequently_cited_source', 'mentioned_not_cited', 'competitor_only_queries', 'insufficient_data', 'unreachable_cited_source')),
  fingerprint       TEXT        NOT NULL CHECK (char_length(fingerprint) = 64),
  title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  explanation       TEXT        NOT NULL CHECK (char_length(explanation) <= 2000),
  action            TEXT        NOT NULL CHECK (char_length(action) <= 2000),
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  limitations       TEXT[]      NOT NULL DEFAULT '{}',
  priority          INTEGER     NOT NULL CHECK (priority BETWEEN 0 AND 100),
  priority_factors  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence        TEXT        NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed', 'obsolete')),
  owner_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_opportunities_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE,
  CONSTRAINT aiv_opportunities_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT aiv_opportunities_fingerprint_unique UNIQUE (brand_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_aiv_opportunities_list ON aiv_opportunities (brand_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS aiv_opportunity_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  opportunity_id  UUID        NOT NULL,
  event           TEXT        NOT NULL CHECK (event IN ('detected', 'redetected', 'status_changed', 'feedback', 'assigned', 'obsolete')),
  from_status     TEXT,
  to_status       TEXT,
  note            TEXT        CHECK (char_length(note) <= 1000),
  actor_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aiv_opportunity_events_fk FOREIGN KEY (opportunity_id, org_id) REFERENCES aiv_opportunities (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiv_opportunity_events ON aiv_opportunity_events (opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS aiv_ai_summaries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  brand_id         UUID        NOT NULL,
  model            TEXT        NOT NULL CHECK (char_length(model) <= 200),
  input_sha256     TEXT        NOT NULL CHECK (char_length(input_sha256) = 64),
  body             JSONB       NOT NULL,
  observation_ids  UUID[]      NOT NULL DEFAULT '{}',
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aiv_ai_summaries_brand_fk FOREIGN KEY (brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiv_ai_summaries_brand ON aiv_ai_summaries (brand_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aiv_provider_usage (
  org_id    UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider  TEXT    NOT NULL,
  day       DATE    NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  failures  INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (org_id, provider, day)
);

-- AI attribution for visibility collection and analysis (the per-organization
-- AI budget still counts every attempt).
ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS aiv_brand_id UUID;
ALTER TABLE agent_executions DROP CONSTRAINT IF EXISTS agent_executions_aiv_brand_org_fk;
ALTER TABLE agent_executions ADD CONSTRAINT agent_executions_aiv_brand_org_fk
  FOREIGN KEY (aiv_brand_id, org_id) REFERENCES aiv_brands (id, org_id) ON DELETE CASCADE;
ALTER TABLE agent_executions DROP CONSTRAINT IF EXISTS agent_executions_attributed;
ALTER TABLE agent_executions ADD CONSTRAINT agent_executions_attributed CHECK (scan_id IS NOT NULL OR research_run_id IS NOT NULL OR aiv_brand_id IS NOT NULL);

ALTER TABLE aiv_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_query_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_opportunity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_ai_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiv_provider_usage ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON aiv_brands, aiv_queries, aiv_query_versions, aiv_runs, aiv_run_items, aiv_imports, aiv_observations, aiv_mentions,
      aiv_sources, aiv_citations, aiv_events, aiv_opportunities, aiv_opportunity_events, aiv_ai_summaries, aiv_provider_usage FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON aiv_brands, aiv_queries, aiv_query_versions, aiv_runs, aiv_run_items, aiv_imports, aiv_observations, aiv_mentions,
      aiv_sources, aiv_citations, aiv_events, aiv_opportunities, aiv_opportunity_events, aiv_ai_summaries, aiv_provider_usage FROM anon;
  END IF;
END $$;
