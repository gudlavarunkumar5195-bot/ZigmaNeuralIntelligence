-- ZigmaNeural — combined Supabase setup (all 11 migrations)
-- Run this once in the Supabase SQL editor (Database > SQL Editor > New query)
-- Idempotent: safe to re-run; migrations that are already applied are skipped.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(50) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- Migration 001
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001') THEN
-- ZigmaNeural initial schema
-- Run via: pnpm migrate

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  full_name      VARCHAR(255),
  email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ─── Organizations ────────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Memberships (RBAC) ───────────────────────────────────────────────────────

CREATE TABLE memberships (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, org_id)
);

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_org  ON memberships(org_id);

-- ─── Refresh Tokens ───────────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user  ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token_hash);

-- ─── Websites ─────────────────────────────────────────────────────────────────

CREATE TABLE websites (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url                  VARCHAR(2048) NOT NULL,
  domain               VARCHAR(253)  NOT NULL,
  verified             BOOLEAN      NOT NULL DEFAULT FALSE,
  verification_method  VARCHAR(50),
  verification_token   VARCHAR(255),
  active               BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by           UUID         REFERENCES users(id),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, url)
);

CREATE INDEX idx_websites_org ON websites(org_id);

-- ─── Scans ────────────────────────────────────────────────────────────────────

CREATE TABLE scans (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id   UUID        NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  org_id       UUID        NOT NULL REFERENCES organizations(id),
  triggered_by UUID        REFERENCES users(id),
  status       VARCHAR(50) NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  modules      TEXT[]      NOT NULL DEFAULT '{}',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scans_website ON scans(website_id);
CREATE INDEX idx_scans_org     ON scans(org_id);
CREATE INDEX idx_scans_status  ON scans(status);

-- ─── Scan Modules ─────────────────────────────────────────────────────────────

CREATE TABLE scan_modules (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id      UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  module_name  VARCHAR(100) NOT NULL,
  status       VARCHAR(50) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','running','completed','failed','skipped')),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms  INTEGER,
  error        TEXT,
  UNIQUE(scan_id, module_name)
);

CREATE INDEX idx_scan_modules_scan ON scan_modules(scan_id);

-- ─── Scan Events (SSE / progress stream) ─────────────────────────────────────

CREATE TABLE scan_events (
  id         BIGSERIAL   PRIMARY KEY,
  scan_id    UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scan_events_scan ON scan_events(scan_id, id);

-- ─── Findings ─────────────────────────────────────────────────────────────────

CREATE TABLE findings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id          UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  website_id       UUID        NOT NULL REFERENCES websites(id),
  org_id           UUID        NOT NULL REFERENCES organizations(id),
  module_name      VARCHAR(100) NOT NULL,
  category         VARCHAR(100) NOT NULL,
  severity         VARCHAR(50) NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title            VARCHAR(500) NOT NULL,
  description      TEXT        NOT NULL,
  recommendation   TEXT        NOT NULL DEFAULT '',
  affected_urls    TEXT[]      NOT NULL DEFAULT '{}',
  confidence       INTEGER     NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  provenance       VARCHAR(50) NOT NULL DEFAULT 'MEASURED'
                               CHECK (provenance IN ('MEASURED','INFERRED','OPPORTUNITY')),
  verified         BOOLEAN     NOT NULL DEFAULT FALSE,
  quality_score    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_findings_scan    ON findings(scan_id);
CREATE INDEX idx_findings_website ON findings(website_id);
CREATE INDEX idx_findings_org     ON findings(org_id);

-- ─── Evidence ─────────────────────────────────────────────────────────────────

CREATE TABLE evidence (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      UUID        NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  type            VARCHAR(100) NOT NULL,
  url             VARCHAR(2048),
  observed_value  TEXT,
  expected_value  TEXT,
  rule            VARCHAR(255),
  tool            VARCHAR(100),
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_evidence_finding ON evidence(finding_id);

-- ─── Scan Scores ──────────────────────────────────────────────────────────────

CREATE TABLE scan_scores (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id        UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  org_id         UUID        NOT NULL REFERENCES organizations(id),
  category       VARCHAR(100) NOT NULL,
  score          INTEGER     CHECK (score BETWEEN 0 AND 100),
  status         VARCHAR(50) NOT NULL DEFAULT 'not_measured'
                             CHECK (status IN ('scored','not_measured','failed','partial')),
  finding_count  INTEGER     NOT NULL DEFAULT 0,
  critical_count INTEGER     NOT NULL DEFAULT 0,
  UNIQUE(scan_id, category)
);

CREATE INDEX idx_scan_scores_scan ON scan_scores(scan_id);

-- ─── Agent Executions ─────────────────────────────────────────────────────────

CREATE TABLE agent_executions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  org_id          UUID        NOT NULL REFERENCES organizations(id),
  agent_type      VARCHAR(100) NOT NULL,
  model_id        VARCHAR(255),
  task            VARCHAR(500) NOT NULL,
  status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','running','completed','failed','unavailable')),
  attempt_number  INTEGER     NOT NULL DEFAULT 1,
  quality_score   INTEGER,
  quality_gate    VARCHAR(50),
  input_ref       TEXT,
  output_ref      TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  latency_ms      INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_exec_scan ON agent_executions(scan_id);

-- ─── Instructions ─────────────────────────────────────────────────────────────

CREATE TABLE instructions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  layer       VARCHAR(50) NOT NULL CHECK (layer IN ('layer1','layer2','layer3')),
  agent_type  VARCHAR(100),
  title       VARCHAR(500) NOT NULL,
  content     TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  version     INTEGER     NOT NULL DEFAULT 1,
  created_by  UUID        REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instructions_org ON instructions(org_id);

-- ─── Monitoring Snapshots ─────────────────────────────────────────────────────

CREATE TABLE monitoring_snapshots (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id        UUID        NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  org_id            UUID        NOT NULL REFERENCES organizations(id),
  scan_id           UUID        REFERENCES scans(id),
  overall_score     INTEGER,
  seo_score         INTEGER,
  security_score    INTEGER,
  performance_score INTEGER,
  accessibility_score INTEGER,
  ssl_score         INTEGER,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_monitoring_website ON monitoring_snapshots(website_id);
CREATE INDEX idx_monitoring_org     ON monitoring_snapshots(org_id);

-- ─── Audit Log (append-only) ──────────────────────────────────────────────────

CREATE TABLE audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id       UUID        REFERENCES users(id),
  org_id        UUID        REFERENCES organizations(id),
  request_id    VARCHAR(100),
  action        VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id   UUID,
  result        VARCHAR(50) NOT NULL CHECK (result IN ('success','failure','unauthorized')),
  metadata      JSONB
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_org        ON audit_log(org_id);
CREATE INDEX idx_audit_user       ON audit_log(user_id);

    INSERT INTO schema_migrations (version) VALUES ('001');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 002
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002') THEN
-- Phase 3A: extend agent_executions with AI execution tracking columns

ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS correlation_id     UUID,
  ADD COLUMN IF NOT EXISTS execution_id       UUID,
  ADD COLUMN IF NOT EXISTS provider           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS prompt_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS finish_reason      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS instruction_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_agent_exec_correlation ON agent_executions(correlation_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_execution   ON agent_executions(execution_id);

    INSERT INTO schema_migrations (version) VALUES ('002');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 003
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003') THEN
-- Phase 3B: ZigmaNeural Model Registry
--
-- Global tables (no org_id) store OpenRouter catalog and model intelligence.
-- Tenant-specific preferences carry org_id and respect existing tenancy controls.

-- ─── models — global catalog ──────────────────────────────────────────────────

CREATE TABLE models (
  id                         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  openrouter_id              VARCHAR(255) UNIQUE NOT NULL,
  display_name               VARCHAR(500) NOT NULL,
  provider                   VARCHAR(100) NOT NULL,
  description                TEXT,
  context_length             INTEGER,

  -- Pricing classification. FREE = prompt+completion price both zero at last check.
  -- CHANGED = was FREE, now PAID (or vice versa) — triggers policy review.
  free_status                VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN'
                             CHECK (free_status IN ('FREE','PAID','UNKNOWN','CHANGED')),

  -- Lifecycle status of this model in ZigmaNeural.
  -- DISCOVERED → must pass review before ELIGIBLE.
  status                     VARCHAR(30) NOT NULL DEFAULT 'DISCOVERED'
                             CHECK (status IN (
                               'DISCOVERED','AVAILABLE','ELIGIBLE',
                               'DISABLED','UNAVAILABLE','STALE',
                               'DEPRECATED','REQUIRES_REVIEW'
                             )),

  -- Eligibility is a deterministic gate separate from status.
  eligibility_status         VARCHAR(30) NOT NULL DEFAULT 'NOT_ELIGIBLE'
                             CHECK (eligibility_status IN (
                               'ELIGIBLE','NOT_ELIGIBLE','PENDING_REVIEW','DISABLED'
                             )),

  -- Capabilities (from provider metadata — not benchmark quality)
  supports_tool_calling      BOOLEAN NOT NULL DEFAULT FALSE,
  supports_structured_output BOOLEAN NOT NULL DEFAULT FALSE,
  supports_reasoning         BOOLEAN NOT NULL DEFAULT FALSE,
  supports_coding            BOOLEAN NOT NULL DEFAULT FALSE,
  supports_vision            BOOLEAN NOT NULL DEFAULT FALSE,
  input_modalities           TEXT[]  NOT NULL DEFAULT '{}',
  output_modalities          TEXT[]  NOT NULL DEFAULT '{}',

  enabled                    BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_catalog_refresh       TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_models_status        ON models(status);
CREATE INDEX idx_models_free_status   ON models(free_status);
CREATE INDEX idx_models_eligibility   ON models(eligibility_status);
CREATE INDEX idx_models_enabled       ON models(enabled);

-- ─── model_benchmarks — ZigmaNeural task scores ────────────────────────────────
--
-- NOT_BENCHMARKED until a real benchmark run populates this table.
-- Never fabricate scores.

CREATE TABLE model_benchmarks (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id            UUID    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  task_type           VARCHAR(100) NOT NULL,
  score               NUMERIC(5,2),
  sample_size         INTEGER,
  benchmark_version   VARCHAR(50),
  evaluation_status   VARCHAR(30) NOT NULL DEFAULT 'NOT_BENCHMARKED'
                      CHECK (evaluation_status IN (
                        'NOT_BENCHMARKED','IN_PROGRESS','BENCHMARKED','STALE'
                      )),
  evaluated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(model_id, task_type)
);

CREATE INDEX idx_benchmarks_model ON model_benchmarks(model_id);

-- ─── model_reliability — operational metrics ──────────────────────────────────
--
-- Populated incrementally from agent_executions.
-- Separate from benchmark quality — a model can be intelligent but unreliable.

CREATE TABLE model_reliability (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id               UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE UNIQUE,
  total_requests         INTEGER NOT NULL DEFAULT 0,
  successful_requests    INTEGER NOT NULL DEFAULT 0,
  failed_requests        INTEGER NOT NULL DEFAULT 0,
  timeout_requests       INTEGER NOT NULL DEFAULT 0,
  rate_limited_requests  INTEGER NOT NULL DEFAULT 0,
  malformed_responses    INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms         INTEGER,
  p95_latency_ms         INTEGER,
  last_updated           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── model_history — immutable audit trail ────────────────────────────────────

CREATE TABLE model_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  event_type  VARCHAR(100) NOT NULL,
  old_value   JSONB,
  new_value   JSONB,
  reason      TEXT,
  actor_id    UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_model_history_model ON model_history(model_id, created_at DESC);

-- ─── model_preferences — tenant-specific ──────────────────────────────────────

CREATE TABLE model_preferences (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_type             VARCHAR(100) NOT NULL,
  preferred_model_id    UUID REFERENCES models(id) ON DELETE SET NULL,
  fallback_model_ids    UUID[] NOT NULL DEFAULT '{}',
  free_only             BOOLEAN NOT NULL DEFAULT FALSE,
  min_reliability       NUMERIC(5,2) NOT NULL DEFAULT 0,
  min_benchmark_score   NUMERIC(5,2) NOT NULL DEFAULT 0,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, task_type)
);

CREATE INDEX idx_model_preferences_org ON model_preferences(org_id);

-- ─── catalog_refreshes — observability ────────────────────────────────────────

CREATE TABLE catalog_refreshes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','completed','failed')),
  models_found   INTEGER,
  models_new     INTEGER,
  models_updated INTEGER,
  models_stale   INTEGER,
  error          TEXT,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

    INSERT INTO schema_migrations (version) VALUES ('003');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 004
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004') THEN
-- Phase 3C: Routing engine tables
-- routing_policies: global and per-org configurable routing rules
-- routing_decisions: one record per routing resolution
-- routing_candidates: per-model scores in each decision
-- routing_feedback: future execution outcome feedback (Phase 3G)

CREATE TABLE IF NOT EXISTS routing_policies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID,                        -- NULL = global default policy
  version          INTEGER NOT NULL DEFAULT 1,
  free_only        BOOLEAN NOT NULL DEFAULT FALSE,
  min_reliability  NUMERIC(5,4) NOT NULL DEFAULT 0.0,  -- 0.0–1.0
  min_quality      NUMERIC(5,4) NOT NULL DEFAULT 0.0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  -- high/critical risk routing behaviour
  require_cross_model_verification BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_providers TEXT[],                     -- NULL = all allowed
  excluded_models   TEXT[],                     -- openrouter_ids
  -- scoring weights (must sum to 1.0 when all non-null)
  weight_benchmark      NUMERIC(4,3) DEFAULT 0.300,
  weight_reliability    NUMERIC(4,3) DEFAULT 0.200,
  weight_capability     NUMERIC(4,3) DEFAULT 0.150,
  weight_historical     NUMERIC(4,3) DEFAULT 0.150,
  weight_structured_out NUMERIC(4,3) DEFAULT 0.050,
  weight_latency        NUMERIC(4,3) DEFAULT 0.050,
  weight_context        NUMERIC(4,3) DEFAULT 0.050,
  weight_preference     NUMERIC(4,3) DEFAULT 0.050,
  -- metadata
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active global policy at a time
CREATE UNIQUE INDEX IF NOT EXISTS routing_policies_global_active
  ON routing_policies (is_active) WHERE org_id IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS routing_policies_org
  ON routing_policies (org_id) WHERE org_id IS NOT NULL;

-- ─── Routing decisions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routing_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id     UUID,
  task_id            UUID,
  agent_id           VARCHAR(100),
  org_id             UUID,
  -- task context (all system-trusted; never raw website content)
  task_type          VARCHAR(100) NOT NULL,
  complexity         VARCHAR(20)  NOT NULL,
  risk_level         VARCHAR(20)  NOT NULL,
  -- routing outcome
  selected_model_id  UUID,                       -- FK to models.id
  selected_openrouter_id VARCHAR(300),
  fallback_model_ids UUID[],
  fallback_openrouter_ids TEXT[],
  -- decision metadata
  decision_reason      TEXT,
  decision_confidence  SMALLINT,                  -- 0–100
  decision_source      VARCHAR(20) NOT NULL DEFAULT 'DETERMINISTIC',
                                                  -- DETERMINISTIC | OX_ALPHA | FALLBACK
  candidate_count      INTEGER NOT NULL DEFAULT 0,
  excluded_count       INTEGER NOT NULL DEFAULT 0,
  -- policy and registry state at decision time
  policy_id            UUID,
  policy_version       INTEGER,
  registry_snapshot_at TIMESTAMPTZ,
  -- performance
  decision_duration_ms INTEGER,
  -- final status
  status             VARCHAR(20) NOT NULL DEFAULT 'RESOLVED',
                                                  -- RESOLVED | NO_CANDIDATES | ERROR
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS routing_decisions_org ON routing_decisions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_decisions_task ON routing_decisions (task_type, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_decisions_model ON routing_decisions (selected_openrouter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_decisions_corr ON routing_decisions (correlation_id) WHERE correlation_id IS NOT NULL;

-- ─── Routing candidates ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routing_candidates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id     UUID NOT NULL REFERENCES routing_decisions(id) ON DELETE CASCADE,
  model_id        UUID,                           -- FK to models.id
  openrouter_id   VARCHAR(300) NOT NULL,
  display_name    VARCHAR(500),
  -- inclusion/exclusion
  included        BOOLEAN NOT NULL DEFAULT TRUE,
  exclusion_reason VARCHAR(100),
  -- composite score (0–100)
  composite_score NUMERIC(6,2),
  -- score components (null = insufficient data)
  score_benchmark      NUMERIC(6,2),
  score_reliability    NUMERIC(6,2),
  score_capability     NUMERIC(6,2),
  score_historical     NUMERIC(6,2),
  score_structured_out NUMERIC(6,2),
  score_latency        NUMERIC(6,2),
  score_context        NUMERIC(6,2),
  score_preference     NUMERIC(6,2),
  -- data quality flags (KNOWN | UNKNOWN | INSUFFICIENT)
  benchmark_data_status  VARCHAR(20) DEFAULT 'UNKNOWN',
  reliability_data_status VARCHAR(20) DEFAULT 'UNKNOWN',
  historical_data_status VARCHAR(20) DEFAULT 'UNKNOWN',
  -- selection outcome
  is_selected     BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_order  INTEGER,                        -- 1, 2, 3 or NULL
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS routing_candidates_decision ON routing_candidates (decision_id);
CREATE INDEX IF NOT EXISTS routing_candidates_model ON routing_candidates (model_id) WHERE model_id IS NOT NULL;

-- ─── Routing feedback ─────────────────────────────────────────────────────────
-- Phase 3G will populate this; schema established now.

CREATE TABLE IF NOT EXISTS routing_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id    UUID NOT NULL REFERENCES routing_decisions(id) ON DELETE CASCADE,
  execution_id   UUID,                            -- FK to agent_executions
  model_id       UUID,
  openrouter_id  VARCHAR(300),
  -- outcome
  execution_success  BOOLEAN,
  quality_score      NUMERIC(5,2),                -- 0–100, verified only
  verified           BOOLEAN DEFAULT FALSE,
  verification_source VARCHAR(50),
  latency_ms         INTEGER,
  retry_count        INTEGER DEFAULT 0,
  fallback_used      BOOLEAN DEFAULT FALSE,
  fallback_reason    VARCHAR(100),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS routing_feedback_decision ON routing_feedback (decision_id);

-- ─── Seed global default policy ───────────────────────────────────────────────

INSERT INTO routing_policies (
  org_id, version, free_only, min_reliability, min_quality, max_attempts,
  require_cross_model_verification, description, is_active
) VALUES (
  NULL, 1, FALSE, 0.0, 0.0, 5,
  FALSE, 'Default global routing policy', TRUE
) ON CONFLICT DO NOTHING;

    INSERT INTO schema_migrations (version) VALUES ('004');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 005
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005') THEN
-- Phase 3D: Specialist Agent Framework
--
-- Global tables: agent definitions, versions, capabilities, tools, dependencies
-- Tenant-specific: executions + findings are already org_id scoped

-- ─── Core agent registry (global) ─────────────────────────────────────────────

CREATE TABLE specialist_agents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type      VARCHAR(100) NOT NULL UNIQUE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  risk_level      VARCHAR(20)  NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status          VARCHAR(50)  NOT NULL DEFAULT 'ACTIVE'
                               CHECK (status IN ('ACTIVE','DISABLED','DEPRECATED','REQUIRES_REVIEW')),
  current_version VARCHAR(20)  NOT NULL DEFAULT '1',
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Agent version history ─────────────────────────────────────────────────────

CREATE TABLE specialist_agent_versions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  version             VARCHAR(20) NOT NULL,
  status              VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (status IN ('ACTIVE','DEPRECATED','ARCHIVED')),
  instruction_profile JSONB,
  input_schema        JSONB,
  output_schema       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, version)
);

-- ─── Agent capabilities ────────────────────────────────────────────────────────

CREATE TABLE specialist_agent_capabilities (
  agent_id    UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  capability  VARCHAR(100) NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

-- ─── Agent tool permissions ────────────────────────────────────────────────────

CREATE TABLE specialist_agent_tools (
  agent_id         UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  tool_name        VARCHAR(100) NOT NULL,
  permission_level VARCHAR(20)  NOT NULL
                                CHECK (permission_level IN ('READ','ANALYZE','GENERATE','PROPOSE','EXECUTE')),
  description      TEXT,
  PRIMARY KEY (agent_id, tool_name)
);

-- ─── Agent dependencies ────────────────────────────────────────────────────────

CREATE TABLE specialist_agent_dependencies (
  agent_id         UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  depends_on_type  VARCHAR(100) NOT NULL,
  dependency_type  VARCHAR(20)  NOT NULL DEFAULT 'REQUIRED'
                               CHECK (dependency_type IN ('REQUIRED','OPTIONAL')),
  PRIMARY KEY (agent_id, depends_on_type)
);

-- ─── Extend agent_executions for Phase 3D ─────────────────────────────────────

ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS specialist_agent_id UUID REFERENCES specialist_agents(id),
  ADD COLUMN IF NOT EXISTS agent_version        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS routing_id           UUID,
  ADD COLUMN IF NOT EXISTS failure_type         VARCHAR(50);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_specialist_agents_type     ON specialist_agents(agent_type);
CREATE INDEX IF NOT EXISTS idx_specialist_agents_status   ON specialist_agents(status, enabled);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent       ON specialist_agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_specialist      ON agent_executions(specialist_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_routing         ON agent_executions(routing_id);

-- ─── Seed initial agent definitions ───────────────────────────────────────────

INSERT INTO specialist_agents (agent_type, name, description, risk_level, status, current_version) VALUES
  ('DISCOVERY',           'Discovery Agent',           'Discovers and inventories website resources, domains, URLs, and technical signals.',          'LOW',    'ACTIVE', '1'),
  ('SEO_ANALYSIS',        'SEO Agent',                 'Analyzes search-engine optimization: metadata, headings, structured data, crawlability.',      'MEDIUM', 'ACTIVE', '1'),
  ('AEO_ANALYSIS',        'AEO Agent',                 'Analyzes answer-engine readiness: question-answer structure, semantic clarity, entities.',     'MEDIUM', 'ACTIVE', '1'),
  ('GEO_ANALYSIS',        'GEO Agent',                 'Analyzes generative-engine visibility: entity signals, citation-readiness, credibility.',      'MEDIUM', 'ACTIVE', '1'),
  ('SECURITY_ANALYSIS',   'Security Agent',            'Interprets authorized security scanner output, classifies findings, recommends remediation.',  'HIGH',   'ACTIVE', '1'),
  ('PERFORMANCE_ANALYSIS','Performance Agent',         'Analyzes performance evidence: metrics, bottlenecks, loading behavior, optimization.',         'MEDIUM', 'ACTIVE', '1'),
  ('ACCESSIBILITY_ANALYSIS','Accessibility Agent',     'Analyzes accessibility evidence: WCAG findings, semantic issues, keyboard and ARIA concerns.', 'MEDIUM', 'ACTIVE', '1'),
  ('QA_ANALYSIS',         'QA Agent',                  'Validates application behavior: functional tests, broken workflows, regression findings.',      'MEDIUM', 'ACTIVE', '1'),
  ('SSL_ANALYSIS',        'SSL / Infrastructure Agent','Interprets TLS, certificate, DNS, and HTTP infrastructure evidence.',                          'HIGH',   'ACTIVE', '1'),
  ('REMEDIATION',         'Remediation Agent',         'Generates proposed technical fixes, code changes, and configuration recommendations.',         'HIGH',   'ACTIVE', '1'),
  ('REPORT_SYNTHESIS',    'Report Synthesis Agent',    'Combines verified findings into a prioritized final report with implementation roadmap.',      'MEDIUM', 'ACTIVE', '1')
ON CONFLICT (agent_type) DO NOTHING;

    INSERT INTO schema_migrations (version) VALUES ('005');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 006
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '006') THEN
-- Phase 3E: Versioned, validated instruction intelligence. Global profiles are
-- immutable by default; execution plans are tenant-scoped for auditability.

CREATE TABLE instruction_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type VARCHAR(100) NOT NULL,
  agent_version VARCHAR(20) NOT NULL,
  current_version VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_type, agent_version, current_version)
);

CREATE TABLE instruction_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_profile_id UUID NOT NULL REFERENCES instruction_profiles(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  instructions JSONB NOT NULL,
  required_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(instruction_profile_id, version)
);

CREATE TABLE instruction_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  task_id TEXT,
  agent_type VARCHAR(100) NOT NULL,
  agent_version VARCHAR(20) NOT NULL,
  profile_version VARCHAR(20) NOT NULL,
  status VARCHAR(40) NOT NULL,
  base_instruction_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  additional_instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_source VARCHAR(20) NOT NULL,
  composition_hash CHAR(64),
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_instruction_plans_org ON instruction_plans(org_id, created_at DESC);

CREATE TABLE instruction_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_plan_id UUID NOT NULL REFERENCES instruction_plans(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('APPROVED','REJECTED')),
  violations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE instruction_compositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_plan_id UUID NOT NULL REFERENCES instruction_plans(id) ON DELETE CASCADE,
  composition_hash CHAR(64) NOT NULL,
  ordered_sections JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

    INSERT INTO schema_migrations (version) VALUES ('006');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 007
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '007') THEN
-- Phase 3F: evolve legacy finding-attached evidence into a provenance-first store.
ALTER TABLE evidence ALTER COLUMN finding_id DROP NOT NULL;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id), ADD COLUMN IF NOT EXISTS task_id TEXT, ADD COLUMN IF NOT EXISTS execution_id UUID, ADD COLUMN IF NOT EXISTS agent_id VARCHAR(100), ADD COLUMN IF NOT EXISTS agent_version VARCHAR(20), ADD COLUMN IF NOT EXISTS evidence_type VARCHAR(100), ADD COLUMN IF NOT EXISTS source_type VARCHAR(50), ADD COLUMN IF NOT EXISTS source_reference TEXT, ADD COLUMN IF NOT EXISTS resource_reference TEXT, ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS content_hash CHAR(64), ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', ADD COLUMN IF NOT EXISTS confidence INTEGER CHECK (confidence BETWEEN 0 AND 100), ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS evidence_kind VARCHAR(20) NOT NULL DEFAULT 'RAW_EVIDENCE', ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS freshness_policy VARCHAR(100), ADD COLUMN IF NOT EXISTS freshness_status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN', ADD COLUMN IF NOT EXISTS retention_class VARCHAR(50), ADD COLUMN IF NOT EXISTS storage_reference TEXT, ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_evidence_org_task ON evidence(org_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(content_hash);
CREATE TABLE evidence_relationships (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), parent_evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, child_evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, relationship_type VARCHAR(50) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(parent_evidence_id, child_evidence_id, relationship_type));
CREATE TABLE evidence_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id), task_id TEXT NOT NULL, agent_id VARCHAR(100) NOT NULL, evidence_type VARCHAR(100) NOT NULL, resource_reference TEXT, reason TEXT NOT NULL, priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE claims (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), finding_id UUID REFERENCES findings(id) ON DELETE CASCADE, org_id UUID NOT NULL REFERENCES organizations(id), claim_type VARCHAR(30) NOT NULL, statement TEXT NOT NULL, evidence_ids UUID[] NOT NULL DEFAULT '{}', confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100), status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    INSERT INTO schema_migrations (version) VALUES ('007');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 008
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '008') THEN
CREATE TABLE quality_policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID REFERENCES organizations(id), version VARCHAR(20) NOT NULL, policy JSONB NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE quality_assessments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id), task_id TEXT NOT NULL, execution_id UUID, agent_id VARCHAR(100) NOT NULL, agent_version VARCHAR(20) NOT NULL, routing_id UUID, instruction_plan_id UUID, status VARCHAR(30) NOT NULL, overall_score INTEGER NOT NULL CHECK (overall_score BETWEEN 0 AND 100), dimension_scores JSONB NOT NULL, blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb, warnings JSONB NOT NULL DEFAULT '[]'::jsonb, reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb, improvement_targets JSONB NOT NULL DEFAULT '[]'::jsonb, evidence_summary JSONB NOT NULL, requirement_summary JSONB NOT NULL, quality_confidence INTEGER NOT NULL CHECK (quality_confidence BETWEEN 0 AND 100), policy_version VARCHAR(20) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX idx_quality_assessments_org_task ON quality_assessments(org_id, task_id, created_at DESC);

    INSERT INTO schema_migrations (version) VALUES ('008');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 009
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '009') THEN
CREATE TABLE regeneration_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id), task_id TEXT NOT NULL, parent_execution_id UUID, current_execution_id UUID, iteration_number INTEGER NOT NULL DEFAULT 0, status VARCHAR(30) NOT NULL, reason TEXT NOT NULL, strategy VARCHAR(60) NOT NULL, best_execution_id UUID, best_quality_assessment_id UUID, best_score INTEGER, idempotency_key VARCHAR(255), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, UNIQUE(org_id, task_id, idempotency_key));
CREATE TABLE improvement_diagnoses (id UUID PRIMARY KEY, regeneration_run_id UUID REFERENCES regeneration_runs(id) ON DELETE CASCADE, quality_assessment_id UUID, root_causes JSONB NOT NULL, strategy VARCHAR(60) NOT NULL, reason_codes JSONB NOT NULL, confidence INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE regeneration_decisions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), regeneration_run_id UUID NOT NULL REFERENCES regeneration_runs(id) ON DELETE CASCADE, quality_assessment_id UUID, strategy VARCHAR(60) NOT NULL, reason_codes JSONB NOT NULL, decision_confidence INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE regeneration_reviews (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), regeneration_run_id UUID NOT NULL REFERENCES regeneration_runs(id) ON DELETE CASCADE, reviewer_id UUID NOT NULL REFERENCES users(id), decision VARCHAR(30) NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    INSERT INTO schema_migrations (version) VALUES ('009');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 010
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '010') THEN
CREATE TABLE adaptation_decisions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), regeneration_run_id UUID REFERENCES regeneration_runs(id) ON DELETE CASCADE, quality_assessment_id UUID NOT NULL, diagnosis_id UUID, strategy VARCHAR(60) NOT NULL, selected_models JSONB NOT NULL DEFAULT '[]'::jsonb, selected_agents JSONB NOT NULL DEFAULT '[]'::jsonb, instruction_changes JSONB NOT NULL DEFAULT '[]'::jsonb, evidence_requests JSONB NOT NULL DEFAULT '[]'::jsonb, parallel_tasks JSONB NOT NULL DEFAULT '[]'::jsonb, reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb, root_causes JSONB NOT NULL DEFAULT '[]'::jsonb, confidence INTEGER NOT NULL, quality_before INTEGER NOT NULL, expected_quality_after INTEGER, quality_after INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX idx_adaptation_assessment ON adaptation_decisions(quality_assessment_id, created_at DESC);

    INSERT INTO schema_migrations (version) VALUES ('010');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Migration 011
-- ═══════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '011') THEN
-- The browser never queries application tables directly. Deny Supabase Data API
-- access by default; all tenant access is enforced by the authenticated Fastify API.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_benchmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_reliability ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_refreshes ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialist_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialist_agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialist_agent_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialist_agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialist_agent_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruction_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruction_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruction_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruction_compositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE regeneration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvement_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE regeneration_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE regeneration_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptation_decisions ENABLE ROW LEVEL SECURITY;

    INSERT INTO schema_migrations (version) VALUES ('011');
  END IF;
END $$;

