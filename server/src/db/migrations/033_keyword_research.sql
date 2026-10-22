-- Phase 4: keyword research and competitor intelligence. Additive.
--
-- research_runs: one row per research request (overview, ideas, related,
--   organic, gap): parameters, provider and capability, status, provenance
--   (sample flag, observed-through date, notes). Runs are the historical
--   snapshots and the usage ledger for quotas.
-- research_results: the rows a run returned, one per normalized keyword,
--   with only the metrics the provider supplied (absent = not returned).
-- research_insights: optional AI prioritization of a run, grounded in its rows.
-- keyword_lists / keyword_list_items: saved research lists.
-- agent_executions: model calls may now be attributed to a research run
--   instead of a scan; every call still needs one of the two.

CREATE TABLE IF NOT EXISTS research_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id       UUID NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('overview', 'ideas', 'related', 'organic', 'gap')),
  provider         TEXT NOT NULL CHECK (length(provider) <= 64),
  capability       TEXT NOT NULL CHECK (length(capability) <= 64),
  params           JSONB NOT NULL CHECK (pg_column_size(params) <= 8192),
  params_hash      TEXT NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  result_count     INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  sample           BOOLEAN NOT NULL DEFAULT TRUE,
  observed_through DATE,
  notes            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (pg_column_size(notes) <= 8192),
  summary          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(summary) <= 32768),
  error_code       TEXT,
  error            TEXT CHECK (error IS NULL OR length(error) <= 500),
  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  CONSTRAINT research_runs_id_org_unique UNIQUE (id, org_id),
  CONSTRAINT research_runs_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_runs_history ON research_runs (org_id, website_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_cache ON research_runs (org_id, params_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_quota ON research_runs (org_id, created_at);

CREATE TABLE IF NOT EXISTS research_results (
  run_id              UUID NOT NULL,
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL CHECK (seq >= 0),
  keyword_key         TEXT NOT NULL CHECK (length(keyword_key) BETWEEN 1 AND 200),
  keyword             TEXT NOT NULL CHECK (length(keyword) BETWEEN 1 AND 400),
  metrics             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metrics) <= 2048),
  intent              TEXT CHECK (intent IS NULL OR intent IN ('informational', 'navigational', 'commercial', 'transactional')),
  intent_rule         TEXT CHECK (intent_rule IS NULL OR length(intent_rule) <= 100),
  gap_category        TEXT CHECK (gap_category IS NULL OR gap_category IN ('shared', 'missing', 'unique')),
  absence_from_sample BOOLEAN,
  competitors_present INTEGER CHECK (competitors_present IS NULL OR competitors_present >= 0),
  observations        JSONB CHECK (observations IS NULL OR pg_column_size(observations) <= 4096),
  PRIMARY KEY (run_id, keyword_key),
  CONSTRAINT research_results_seq_unique UNIQUE (run_id, seq),
  CONSTRAINT research_results_run_org_fk FOREIGN KEY (run_id, org_id) REFERENCES research_runs (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_insights (
  run_id     UUID PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  model      TEXT,
  summary    TEXT CHECK (summary IS NULL OR length(summary) <= 4000),
  items      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (pg_column_size(items) <= 65536),
  error      TEXT CHECK (error IS NULL OR length(error) <= 500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_insights_run_org_fk FOREIGN KEY (run_id, org_id) REFERENCES research_runs (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS keyword_lists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT keyword_lists_name_unique UNIQUE (org_id, name),
  CONSTRAINT keyword_lists_id_org_unique UNIQUE (id, org_id)
);

CREATE TABLE IF NOT EXISTS keyword_list_items (
  list_id       UUID NOT NULL,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  keyword_key   TEXT NOT NULL CHECK (length(keyword_key) BETWEEN 1 AND 200),
  keyword       TEXT NOT NULL CHECK (length(keyword) BETWEEN 1 AND 400),
  source_run_id UUID REFERENCES research_runs(id) ON DELETE SET NULL,
  added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, keyword_key),
  CONSTRAINT keyword_list_items_list_org_fk FOREIGN KEY (list_id, org_id) REFERENCES keyword_lists (id, org_id) ON DELETE CASCADE
);

-- AI attribution for research (the per-organization AI budget still counts every attempt).
ALTER TABLE agent_executions ALTER COLUMN scan_id DROP NOT NULL;
ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS research_run_id UUID;
ALTER TABLE agent_executions DROP CONSTRAINT IF EXISTS agent_executions_research_run_org_fk;
ALTER TABLE agent_executions ADD CONSTRAINT agent_executions_research_run_org_fk
  FOREIGN KEY (research_run_id, org_id) REFERENCES research_runs (id, org_id) ON DELETE CASCADE;
ALTER TABLE agent_executions DROP CONSTRAINT IF EXISTS agent_executions_attributed;
ALTER TABLE agent_executions ADD CONSTRAINT agent_executions_attributed CHECK (scan_id IS NOT NULL OR research_run_id IS NOT NULL);

ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_list_items ENABLE ROW LEVEL SECURITY;
