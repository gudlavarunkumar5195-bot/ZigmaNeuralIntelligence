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
