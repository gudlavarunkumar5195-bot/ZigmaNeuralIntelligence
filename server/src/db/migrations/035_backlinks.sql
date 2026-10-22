-- 035: Backlink intelligence (additive only).
--
-- backlink_datasets: one snapshot of backlinks for a subject (the website
--   itself or a competitor domain), from one source (an authorized CSV import
--   today; licensed providers later). Snapshots of the same subject form its
--   history. Coverage is declared, never assumed complete.
-- backlink_links: the links of a snapshot, deduplicated by a stable key.
-- backlink_link_checks: latest live verification per link (our own fetch).
-- backlink_changes: changes between consecutive snapshots, deduplicated.
-- backlink_verification_jobs: bounded, leased verification work; at most one
--   active job per dataset.

CREATE TABLE IF NOT EXISTS backlink_datasets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id        UUID        NOT NULL,
  subject_kind      TEXT        NOT NULL CHECK (subject_kind IN ('own', 'competitor')),
  subject_domain    TEXT        NOT NULL CHECK (subject_domain ~ '^[a-z0-9.-]{1,253}$'),
  source            TEXT        NOT NULL CHECK (source IN ('csv_import')),
  source_label      TEXT        NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 80),
  coverage          TEXT        NOT NULL CHECK (coverage IN ('complete', 'partial', 'unknown')),
  exported_at       DATE,
  retrieved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_from     DATE,
  observed_to       DATE,
  filename          TEXT        CHECK (char_length(filename) <= 255),
  content_sha256    TEXT        NOT NULL CHECK (char_length(content_sha256) = 64),
  rows_total        INTEGER     NOT NULL CHECK (rows_total >= 0),
  rows_accepted     INTEGER     NOT NULL CHECK (rows_accepted >= 0),
  rows_rejected     INTEGER     NOT NULL CHECK (rows_rejected >= 0),
  rows_duplicate    INTEGER     NOT NULL CHECK (rows_duplicate >= 0),
  rows_skipped      INTEGER     NOT NULL CHECK (rows_skipped >= 0),
  rejected_samples  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  column_mapping    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  referring_domains INTEGER     NOT NULL DEFAULT 0,
  created_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT backlink_datasets_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT backlink_datasets_id_org_unique UNIQUE (id, org_id),
  -- Re-importing the same file for the same subject is idempotent.
  CONSTRAINT backlink_datasets_content_unique UNIQUE (org_id, website_id, subject_domain, content_sha256)
);
CREATE INDEX IF NOT EXISTS idx_backlink_datasets_series ON backlink_datasets (org_id, website_id, subject_domain, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS backlink_links (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL,
  dataset_id     UUID        NOT NULL,
  link_key       TEXT        NOT NULL CHECK (char_length(link_key) = 64),
  source_url     TEXT        NOT NULL CHECK (char_length(source_url) <= 2048),
  source_domain  TEXT        NOT NULL CHECK (char_length(source_domain) <= 253),
  target_url     TEXT        CHECK (char_length(target_url) <= 2048),
  target_domain  TEXT        CHECK (char_length(target_domain) <= 253),
  anchor         TEXT        CHECK (char_length(anchor) <= 500),
  link_type      TEXT        CHECK (link_type IN ('follow', 'nofollow', 'sponsored', 'ugc')),
  first_seen     DATE,
  last_seen      DATE,
  provider_lost  BOOLEAN,
  source_row     INTEGER     NOT NULL,
  CONSTRAINT backlink_links_dataset_fk FOREIGN KEY (dataset_id, org_id) REFERENCES backlink_datasets (id, org_id) ON DELETE CASCADE,
  CONSTRAINT backlink_links_key_unique UNIQUE (dataset_id, link_key)
);
CREATE INDEX IF NOT EXISTS idx_backlink_links_domain ON backlink_links (dataset_id, source_domain);
CREATE INDEX IF NOT EXISTS idx_backlink_links_org_key ON backlink_links (org_id, link_key);

CREATE TABLE IF NOT EXISTS backlink_link_checks (
  org_id              UUID        NOT NULL,
  website_id          UUID        NOT NULL,
  link_key            TEXT        NOT NULL CHECK (char_length(link_key) = 64),
  checked_at          TIMESTAMPTZ NOT NULL,
  outcome             TEXT        NOT NULL CHECK (outcome IN ('link_found', 'link_missing', 'page_unreachable', 'blocked_by_robots', 'not_html', 'unsafe_url', 'error')),
  http_status         INTEGER,
  observed_link_type  TEXT        CHECK (observed_link_type IN ('follow', 'nofollow', 'sponsored', 'ugc')),
  observed_anchor     TEXT        CHECK (char_length(observed_anchor) <= 500),
  consecutive_missing INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_missing >= 0),
  last_found_at       TIMESTAMPTZ,
  PRIMARY KEY (org_id, website_id, link_key),
  CONSTRAINT backlink_link_checks_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backlink_changes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  website_id       UUID        NOT NULL,
  subject_domain   TEXT        NOT NULL,
  change_type      TEXT        NOT NULL CHECK (change_type IN ('new', 'lost', 'potentially_lost', 'anchor_changed', 'target_changed', 'attributes_changed')),
  link_key         TEXT        NOT NULL CHECK (char_length(link_key) = 64),
  source_url       TEXT        NOT NULL,
  target_url       TEXT,
  from_dataset_id  UUID,
  to_dataset_id    UUID        NOT NULL,
  evidence         TEXT        NOT NULL CHECK (char_length(evidence) <= 300),
  details          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT backlink_changes_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT backlink_changes_to_dataset_fk FOREIGN KEY (to_dataset_id, org_id) REFERENCES backlink_datasets (id, org_id) ON DELETE CASCADE,
  -- One event per link, change type and snapshot: re-running detection never duplicates alerts.
  CONSTRAINT backlink_changes_unique UNIQUE (to_dataset_id, link_key, change_type)
);
CREATE INDEX IF NOT EXISTS idx_backlink_changes_feed ON backlink_changes (org_id, website_id, detected_at DESC, id);

CREATE TABLE IF NOT EXISTS backlink_verification_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL,
  website_id    UUID        NOT NULL,
  dataset_id    UUID        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  links_total   INTEGER     NOT NULL CHECK (links_total >= 0),
  links_checked INTEGER     NOT NULL DEFAULT 0 CHECK (links_checked >= 0),
  claims        INTEGER     NOT NULL DEFAULT 0 CHECK (claims >= 0),
  lease_owner   TEXT,
  lease_until   TIMESTAMPTZ,
  error         TEXT        CHECK (char_length(error) <= 500),
  requested_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  CONSTRAINT backlink_verification_jobs_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE,
  CONSTRAINT backlink_verification_jobs_dataset_fk FOREIGN KEY (dataset_id, org_id) REFERENCES backlink_datasets (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_backlink_verification_active ON backlink_verification_jobs (dataset_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_backlink_verification_queue ON backlink_verification_jobs (status, created_at) WHERE status IN ('queued', 'running');

ALTER TABLE backlink_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_link_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_verification_jobs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON backlink_datasets, backlink_links, backlink_link_checks, backlink_changes, backlink_verification_jobs FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON backlink_datasets, backlink_links, backlink_link_checks, backlink_changes, backlink_verification_jobs FROM anon;
  END IF;
END $$;
