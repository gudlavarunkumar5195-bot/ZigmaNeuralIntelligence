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
