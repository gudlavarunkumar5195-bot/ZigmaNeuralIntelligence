-- Phase 8: tenant-safe monitoring, deterministic change detection, and alerts.

CREATE TABLE IF NOT EXISTS monitoring_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','FAILED','DISABLED')),
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  modules TEXT[] NOT NULL DEFAULT '{seo,security,ssl,performance}',
  alert_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, website_id)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_due ON monitoring_configs(enabled, status, next_run_at);

CREATE TABLE IF NOT EXISTS monitoring_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitoring_id UUID NOT NULL REFERENCES monitoring_configs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id UUID UNIQUE REFERENCES scans(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  owner_id UUID NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (monitoring_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_runs_org ON monitoring_runs(org_id, monitoring_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitoring_id UUID NOT NULL REFERENCES monitoring_configs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id UUID UNIQUE NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','INVALID','NON_COMPARABLE')),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (monitoring_id, scan_id)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_baselines_lookup ON monitoring_baselines(org_id, monitoring_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitoring_id UUID NOT NULL REFERENCES monitoring_configs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  baseline_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  signature TEXT NOT NULL,
  change_type VARCHAR(80) NOT NULL,
  domain VARCHAR(40) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  affected_urls TEXT[] NOT NULL DEFAULT '{}',
  before_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids UUID[] NOT NULL DEFAULT '{}',
  finding_ids UUID[] NOT NULL DEFAULT '{}',
  impact TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, monitoring_id, scan_id, signature)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_changes_lookup ON monitoring_changes(org_id, monitoring_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitoring_id UUID NOT NULL REFERENCES monitoring_configs(id) ON DELETE CASCADE,
  rule_type VARCHAR(60) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  threshold NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, monitoring_id, rule_type)
);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitoring_id UUID NOT NULL REFERENCES monitoring_configs(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  change_id UUID NOT NULL REFERENCES monitoring_changes(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  baseline_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  signature TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, monitoring_id, signature, status)
);
CREATE INDEX IF NOT EXISTS idx_alerts_org_status ON alerts(org_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  attempted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, channel)
);

ALTER TABLE monitoring_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
