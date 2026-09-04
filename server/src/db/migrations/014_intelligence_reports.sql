-- Separate deterministic scan completion from intelligence/report completion.
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS intelligence_status VARCHAR(30) NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS intelligence_error TEXT;

ALTER TABLE scans
  ADD CONSTRAINT scans_intelligence_status_check
  CHECK (intelligence_status IN ('NOT_STARTED','QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED'));

CREATE TABLE IF NOT EXISTS reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id          UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id             UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  report_version      INTEGER NOT NULL DEFAULT 1,
  status              VARCHAR(20) NOT NULL DEFAULT 'GENERATING'
                      CHECK (status IN ('GENERATING','READY','FAILED')),
  deterministic_score INTEGER CHECK (deterministic_score BETWEEN 0 AND 100),
  summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scan_id, report_version)
);

CREATE INDEX IF NOT EXISTS idx_reports_org_scan ON reports(org_id, scan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_website ON reports(org_id, website_id, created_at DESC);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
