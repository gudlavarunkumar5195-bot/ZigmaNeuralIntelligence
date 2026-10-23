-- 041: Autonomous model router v2 (additive only; Phase 11).
--
-- Free-tier aware OpenRouter routing: full pricing classification, provider
-- quotas and cooldowns, token reservations, task runs, evaluation records that
-- feed model selection, prompt-injection/security events, tool approvals and
-- bounded multi-agent runs. Hard limits live in application code; these
-- tables only record state and decisions. No raw prompts or model outputs
-- are stored here.

-- ─── Catalog: full pricing classification and limits ──────────────────────────
-- pricing_class: FREE (every price is zero, no expiry), TRIAL (zero today but
-- the catalog announces an expiration date), PAID (any price above zero),
-- UNKNOWN (missing, unparseable, negative/dynamic, or time-varying prices).
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS pricing_class         VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN'
                                                 CHECK (pricing_class IN ('FREE','TRIAL','PAID','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS pricing               JSONB,
  ADD COLUMN IF NOT EXISTS pricing_checked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_completion_tokens INTEGER CHECK (max_completion_tokens IS NULL OR max_completion_tokens > 0),
  ADD COLUMN IF NOT EXISTS reasoning_mandatory   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS supports_json_schema  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_router             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tokenizer             VARCHAR(60),
  ADD COLUMN IF NOT EXISTS benchmark_intelligence NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS benchmark_coding       NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS benchmark_agentic      NUMERIC(6,2);
CREATE INDEX IF NOT EXISTS idx_models_pricing_class ON models (pricing_class) WHERE enabled;

-- ─── Router settings (global, versioned) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_router_settings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version     INTEGER     NOT NULL CHECK (version > 0),
  settings    JSONB       NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_router_settings_one_active ON ai_router_settings (is_active) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS ai_router_settings_version ON ai_router_settings (version);

-- ─── Provider health: per-model cooldown after rate limits and outages ────────
CREATE TABLE IF NOT EXISTS ai_model_health (
  openrouter_id         VARCHAR(255) PRIMARY KEY,
  cooldown_until        TIMESTAMPTZ,
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_category VARCHAR(40),
  last_failure_at       TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Account-wide provider quotas (OpenRouter free and trial requests per UTC day) ─
CREATE TABLE IF NOT EXISTS ai_provider_quota_days (
  provider        VARCHAR(40) NOT NULL,
  pool            VARCHAR(10) NOT NULL CHECK (pool IN ('FREE','TRIAL')),
  day             DATE        NOT NULL,
  requests        INTEGER     NOT NULL DEFAULT 0 CHECK (requests >= 0),
  -- Daily allowance the provider itself reported (OpenRouter /key free_model_daily_requests), when synced.
  provider_limit  INTEGER     CHECK (provider_limit >= 0),
  provider_used   INTEGER     CHECK (provider_used >= 0),
  provider_synced_at TIMESTAMPTZ,
  exhausted_until TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, pool, day)
);

-- ─── Task runs: one bounded AI task (single call or multi-agent) ──────────────
CREATE TABLE IF NOT EXISTS ai_task_runs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_type          VARCHAR(60) NOT NULL,
  feature            VARCHAR(60) NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
                     CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','REJECTED')),
  feasibility        VARCHAR(30) NOT NULL
                     CHECK (feasibility IN ('FEASIBLE','FEASIBLE_WITH_REDUCTION','SPLIT_REQUIRED','INSUFFICIENT_BUDGET','NO_ELIGIBLE_MODEL','BLOCKED_BY_POLICY')),
  feasibility_detail JSONB       NOT NULL DEFAULT '{}'::jsonb,
  limits             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  tokens_reserved    BIGINT      NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  tokens_used        BIGINT      NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  calls_used         INTEGER     NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  agents_used        INTEGER     NOT NULL DEFAULT 0 CHECK (agents_used >= 0),
  selected_model     VARCHAR(255),
  error_code         VARCHAR(60),
  correlation_id     UUID,
  created_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  scan_id            UUID,
  research_run_id    UUID,
  aiv_brand_id       UUID,
  cancel_requested   BOOLEAN     NOT NULL DEFAULT FALSE,
  deadline_at        TIMESTAMPTZ,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  CONSTRAINT ai_task_runs_id_org_unique UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_task_runs_org_time ON ai_task_runs (org_id, started_at DESC);

-- ─── Token reservations: reserved before a call, settled from provider usage ──
CREATE TABLE IF NOT EXISTS ai_token_reservations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_run_id       UUID,
  execution_id      UUID,
  model             VARCHAR(255) NOT NULL,
  estimated_input   INTEGER     NOT NULL CHECK (estimated_input >= 0),
  estimated_output  INTEGER     NOT NULL CHECK (estimated_output >= 0),
  reserved_tokens   INTEGER     NOT NULL CHECK (reserved_tokens >= 0),
  actual_input      INTEGER     CHECK (actual_input >= 0),
  actual_output     INTEGER     CHECK (actual_output >= 0),
  cached_tokens     INTEGER     CHECK (cached_tokens >= 0),
  reasoning_tokens  INTEGER     CHECK (reasoning_tokens >= 0),
  usage_source      VARCHAR(10) CHECK (usage_source IN ('PROVIDER','ESTIMATED')),
  cost_usd          NUMERIC(14,8),
  status            VARCHAR(10) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','SETTLED','RELEASED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at        TIMESTAMPTZ,
  CONSTRAINT ai_token_reservations_task_fk FOREIGN KEY (task_run_id, org_id) REFERENCES ai_task_runs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_token_reservations_org_time ON ai_token_reservations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_token_reservations_task ON ai_token_reservations (task_run_id) WHERE task_run_id IS NOT NULL;

-- ─── Model attempts: richer accounting on the existing attempt rows ───────────
ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS failure_category        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS task_run_id             UUID,
  ADD COLUMN IF NOT EXISTS estimated_input_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS estimated_output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS usage_estimated         BOOLEAN,
  ADD COLUMN IF NOT EXISTS cached_tokens           INTEGER,
  ADD COLUMN IF NOT EXISTS reasoning_tokens        INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd                NUMERIC(14,8),
  ADD COLUMN IF NOT EXISTS pricing_class           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS fallback_reason         VARCHAR(200);
-- Account-wide per-minute pacing counts recent attempts across all organizations.
CREATE INDEX IF NOT EXISTS idx_agent_executions_attempt_time ON agent_executions (started_at) WHERE execution_kind = 'MODEL_ATTEMPT';
CREATE INDEX IF NOT EXISTS idx_agent_executions_model_time ON agent_executions (model_id, started_at DESC) WHERE execution_kind = 'MODEL_ATTEMPT';

ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS task_run_id UUID;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS feature VARCHAR(60);
ALTER TABLE routing_candidates ADD COLUMN IF NOT EXISTS score_components JSONB;

-- ─── Evaluation records: the only input to learned model quality ──────────────
CREATE TABLE IF NOT EXISTS ai_model_evaluations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_run_id        UUID,
  execution_id       UUID,
  model              VARCHAR(255) NOT NULL,
  task_type          VARCHAR(60) NOT NULL,
  outcome            VARCHAR(10) NOT NULL CHECK (outcome IN ('PASS','PARTIAL','FAIL')),
  quality_score      SMALLINT    NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  method             VARCHAR(20) NOT NULL CHECK (method IN ('DETERMINISTIC','EVALUATOR_MODEL','USER_FEEDBACK')),
  confidence         VARCHAR(10) NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  validators         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  security_violation BOOLEAN     NOT NULL DEFAULT FALSE,
  latency_ms         INTEGER,
  total_tokens       INTEGER,
  catalog_refresh_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_model_evaluations_task_fk FOREIGN KEY (task_run_id, org_id) REFERENCES ai_task_runs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_model_evaluations_model ON ai_model_evaluations (model, task_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_model_evaluations_org ON ai_model_evaluations (org_id, created_at DESC);

-- Explicit user feedback on one task result (one vote per user per task).
CREATE TABLE IF NOT EXISTS ai_feedback (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  task_run_id UUID        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      SMALLINT    NOT NULL CHECK (rating IN (-1, 1)),
  reason      VARCHAR(30) CHECK (reason IN ('incorrect','incomplete','off_topic','unsafe','format','helpful','accurate','other')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_feedback_task_fk FOREIGN KEY (task_run_id, org_id) REFERENCES ai_task_runs (id, org_id) ON DELETE CASCADE,
  CONSTRAINT ai_feedback_one_per_user UNIQUE (task_run_id, user_id)
);

-- ─── Security decisions (injection signals, blocked tools, policy refusals) ──
CREATE TABLE IF NOT EXISTS ai_security_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  task_run_id UUID,
  kind        VARCHAR(40) NOT NULL,
  severity    VARCHAR(10) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  source      VARCHAR(20),
  categories  TEXT[]      NOT NULL DEFAULT '{}',
  model       VARCHAR(255),
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_security_events_org_time ON ai_security_events (org_id, created_at DESC);

-- ─── Tool approvals: bound to one tool and one exact argument set ─────────────
CREATE TABLE IF NOT EXISTS ai_tool_approvals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_run_id  UUID,
  tool_id      VARCHAR(80) NOT NULL,
  args_hash    CHAR(64)    NOT NULL,
  args_preview JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk         VARCHAR(10) NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status       VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','USED')),
  requested_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  decided_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_tool_approvals_org ON ai_tool_approvals (org_id, status, created_at DESC);

-- ─── Multi-agent runs (one row per spawned agent) ─────────────────────────────
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL,
  task_run_id  UUID        NOT NULL,
  parent_id    UUID,
  role         VARCHAR(30) NOT NULL,
  depth        SMALLINT    NOT NULL CHECK (depth >= 0),
  status       VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','REJECTED')),
  model        VARCHAR(255),
  calls        INTEGER     NOT NULL DEFAULT 0,
  tokens       INTEGER     NOT NULL DEFAULT 0,
  error_code   VARCHAR(60),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ai_agent_runs_task_fk FOREIGN KEY (task_run_id, org_id) REFERENCES ai_task_runs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_task ON ai_agent_runs (task_run_id, started_at);
