-- Phase 3: Google Search Console integration. Purely additive.
--
-- PostgreSQL holds the integration (encrypted refresh token), the property
-- linked to each website, sync jobs with per-unit checkpoints, per-day
-- coverage, and the daily search-performance observations themselves.
-- ClickHouse is not verified in production yet, so it is not a dependency;
-- gsc_search_daily is shaped so it can be copied there later.
--
-- Tenancy: every table carries org_id, and composite foreign keys keep a
-- row's website, integration, property and job inside the same organization.
-- Deleting an integration or a website link cascades to its jobs, coverage
-- and observations (the documented disconnect behaviour).

CREATE TABLE IF NOT EXISTS oauth_states (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google_search_console')),
  -- sha256 of the state parameter and of the browser-binding cookie nonce:
  -- neither raw value is stored.
  state_hash        TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash      TEXT NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  code_verifier_enc TEXT NOT NULL,
  return_path       TEXT NOT NULL CHECK (return_path IN ('/settings/integrations', '/search/performance')),
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS integrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('google_search_console')),
  external_account_id TEXT NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 255),
  account_email       TEXT CHECK (account_email IS NULL OR length(account_email) <= 320),
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  refresh_token_enc   TEXT,
  key_id              TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'error')),
  status_reason       TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  connected_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrations_account_unique UNIQUE (org_id, provider, external_account_id),
  CONSTRAINT integrations_id_org_unique UNIQUE (id, org_id),
  -- An active integration always has a credential.
  CONSTRAINT integrations_active_has_token CHECK (status <> 'active' OR (refresh_token_enc IS NOT NULL AND key_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gsc_properties (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id           UUID NOT NULL,
  integration_id       UUID NOT NULL,
  site_url             TEXT NOT NULL CHECK (length(site_url) BETWEEN 1 AND 2048),
  property_type        TEXT NOT NULL CHECK (property_type IN ('domain', 'url_prefix')),
  permission_level     TEXT NOT NULL,
  search_type          TEXT NOT NULL DEFAULT 'web' CHECK (search_type IN ('web')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'access_lost')),
  status_reason        TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  sync_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  next_sync_at         TIMESTAMPTZ,
  last_sync_success_at TIMESTAMPTZ,
  last_synced_through  DATE,
  first_incomplete_date DATE,
  linked_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gsc_properties_one_per_website UNIQUE (website_id),
  CONSTRAINT gsc_properties_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT gsc_properties_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT gsc_properties_integration_org_fk FOREIGN KEY (integration_id, org_id) REFERENCES integrations (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gsc_properties_org ON gsc_properties (org_id, integration_id);
CREATE INDEX IF NOT EXISTS idx_gsc_properties_due ON gsc_properties (next_sync_at) WHERE sync_enabled AND status = 'active';

CREATE TABLE IF NOT EXISTS gsc_sync_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id      UUID NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('initial', 'incremental', 'manual')),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  date_from        DATE NOT NULL,
  date_to          DATE NOT NULL,
  units_total      INTEGER NOT NULL DEFAULT 0 CHECK (units_total >= 0),
  units_done       INTEGER NOT NULL DEFAULT 0 CHECK (units_done >= 0),
  units_failed     INTEGER NOT NULL DEFAULT 0 CHECK (units_failed >= 0),
  rows_written     BIGINT NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  claims           INTEGER NOT NULL DEFAULT 0 CHECK (claims >= 0),
  quota_pauses     INTEGER NOT NULL DEFAULT 0 CHECK (quota_pauses >= 0),
  run_after        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner      UUID,
  lease_until      TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  error_code       TEXT,
  error            TEXT CHECK (error IS NULL OR length(error) <= 1000),
  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CHECK (date_from <= date_to),
  CONSTRAINT gsc_sync_jobs_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT gsc_sync_jobs_property_org_fk FOREIGN KEY (property_id, org_id) REFERENCES gsc_properties (id, org_id) ON DELETE CASCADE
);
-- At most one queued or running sync per property (duplicate submissions and
-- the scheduler converge on the same job).
CREATE UNIQUE INDEX IF NOT EXISTS gsc_sync_jobs_one_active ON gsc_sync_jobs (property_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_gsc_sync_jobs_claim ON gsc_sync_jobs (run_after) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_gsc_sync_jobs_property ON gsc_sync_jobs (org_id, property_id, created_at DESC);

-- Checkpoint: one row per (dimension set, PT date) the job must fetch.
CREATE TABLE IF NOT EXISTS gsc_sync_units (
  job_id        UUID NOT NULL,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dimension_set TEXT NOT NULL CHECK (dimension_set IN ('total', 'query', 'page', 'country', 'device', 'searchAppearance')),
  day           DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  row_count     INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('complete', 'truncated', 'kept_previous')),
  error_code    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, dimension_set, day),
  CONSTRAINT gsc_sync_units_job_org_fk FOREIGN KEY (job_id, org_id) REFERENCES gsc_sync_jobs (id, org_id) ON DELETE CASCADE
);

-- What we know about each (property, dimension set, day): a day with a
-- complete fetch and no row is a real zero; a day without coverage is
-- unknown and must be shown as missing, never as zero.
CREATE TABLE IF NOT EXISTS gsc_coverage (
  property_id   UUID NOT NULL,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dimension_set TEXT NOT NULL CHECK (dimension_set IN ('total', 'query', 'page', 'country', 'device', 'searchAppearance')),
  day           DATE NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('complete', 'truncated', 'kept_previous')),
  row_count     INTEGER NOT NULL CHECK (row_count >= 0),
  data_state    TEXT NOT NULL CHECK (data_state IN ('final', 'fresh')),
  job_id        UUID,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (property_id, dimension_set, day),
  CONSTRAINT gsc_coverage_property_org_fk FOREIGN KEY (property_id, org_id) REFERENCES gsc_properties (id, org_id) ON DELETE CASCADE
);

-- Daily observations: one dimension per set besides the date ('total' has
-- none, dim_value ''). Replayed fetches replace a (property, set, day) as a
-- whole, inside one transaction, only after the fetch completed.
CREATE TABLE IF NOT EXISTS gsc_search_daily (
  property_id   UUID NOT NULL,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dimension_set TEXT NOT NULL CHECK (dimension_set IN ('total', 'query', 'page', 'country', 'device', 'searchAppearance')),
  day           DATE NOT NULL,
  dim_value     TEXT NOT NULL DEFAULT '' CHECK (length(dim_value) <= 4096),
  clicks        BIGINT NOT NULL CHECK (clicks >= 0),
  impressions   BIGINT NOT NULL CHECK (impressions >= 0),
  ctr           DOUBLE PRECISION NOT NULL CHECK (ctr >= 0),
  position      DOUBLE PRECISION NOT NULL CHECK (position >= 0),
  data_state    TEXT NOT NULL CHECK (data_state IN ('final', 'fresh')),
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (property_id, dimension_set, day, dim_value),
  CONSTRAINT gsc_search_daily_property_org_fk FOREIGN KEY (property_id, org_id) REFERENCES gsc_properties (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gsc_search_daily_value ON gsc_search_daily (property_id, dimension_set, dim_value, day);

-- Same posture as every other table: no direct Data API access.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_sync_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_search_daily ENABLE ROW LEVEL SECURITY;
