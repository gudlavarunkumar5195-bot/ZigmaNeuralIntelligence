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
