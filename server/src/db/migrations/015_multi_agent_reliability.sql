-- Phase 6.5: reliable multi-agent execution and evidence traceability.

CREATE TABLE IF NOT EXISTS finding_evidence (
  finding_id UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (finding_id, evidence_id),
  UNIQUE (org_id, finding_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_finding_evidence_evidence ON finding_evidence(evidence_id);
CREATE INDEX IF NOT EXISTS idx_finding_evidence_org ON finding_evidence(org_id);

ALTER TABLE findings ADD CONSTRAINT findings_id_org_unique UNIQUE (id, org_id);
ALTER TABLE evidence ADD CONSTRAINT evidence_id_org_unique UNIQUE (id, org_id);
ALTER TABLE finding_evidence
  ADD CONSTRAINT finding_evidence_finding_org_fk FOREIGN KEY (finding_id, org_id) REFERENCES findings(id, org_id),
  ADD CONSTRAINT finding_evidence_evidence_org_fk FOREIGN KEY (evidence_id, org_id) REFERENCES evidence(id, org_id);

INSERT INTO finding_evidence (finding_id, evidence_id, org_id)
SELECT e.finding_id, e.id, e.org_id
FROM evidence e
WHERE e.finding_id IS NOT NULL AND e.org_id IS NOT NULL
ON CONFLICT (finding_id, evidence_id) DO NOTHING;

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS execution_owner UUID,
  ADD COLUMN IF NOT EXISTS execution_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scans_execution_lease ON scans(status, execution_lease_until);

CREATE TABLE IF NOT EXISTS agent_stage_claims (
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stage_name VARCHAR(100) NOT NULL,
  owner_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  attempt_number INTEGER NOT NULL DEFAULT 1,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
  completed_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (scan_id, stage_name),
  UNIQUE (org_id, scan_id, stage_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_stage_claims_lease ON agent_stage_claims(status, lease_until);
ALTER TABLE agent_stage_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS synthesis_artifact JSONB,
  ADD COLUMN IF NOT EXISTS synthesis_execution_id UUID,
  ADD COLUMN IF NOT EXISTS synthesis_quality_status VARCHAR(30);

ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS execution_kind VARCHAR(30) NOT NULL DEFAULT 'MODEL_ATTEMPT',
  ADD COLUMN IF NOT EXISTS logical_execution_id UUID,
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(100),
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_agent_exec_logical ON agent_executions(org_id, scan_id, agent_type, logical_execution_id);

ALTER TABLE finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
