-- Phase 7: cross-domain intelligence and proposal-only remediation.

CREATE TABLE IF NOT EXISTS cross_domain_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  logical_key TEXT NOT NULL,
  title VARCHAR(500) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  domains TEXT[] NOT NULL CHECK (cardinality(domains) >= 2),
  source_finding_ids UUID[] NOT NULL CHECK (cardinality(source_finding_ids) >= 2),
  evidence_ids UUID[] NOT NULL CHECK (cardinality(evidence_ids) >= 1),
  business_impact TEXT NOT NULL,
  technical_impact TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  priority VARCHAR(20) NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  priority_score NUMERIC(8,3) NOT NULL CHECK (priority_score BETWEEN 0 AND 100),
  priority_reason JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISPUTED','RESOLVED','IGNORED')),
  execution_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, scan_id, logical_key)
);
CREATE INDEX IF NOT EXISTS idx_cross_domain_scan ON cross_domain_findings(org_id, scan_id, created_at DESC);
ALTER TABLE cross_domain_findings ADD CONSTRAINT cross_domain_findings_id_org_unique UNIQUE (id, org_id);

CREATE TABLE IF NOT EXISTS cross_domain_finding_sources (
  cross_domain_finding_id UUID NOT NULL REFERENCES cross_domain_findings(id) ON DELETE CASCADE,
  source_finding_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cross_domain_finding_id, source_finding_id),
  FOREIGN KEY (cross_domain_finding_id, org_id) REFERENCES cross_domain_findings(id, org_id),
  FOREIGN KEY (source_finding_id, org_id) REFERENCES findings(id, org_id)
);

CREATE TABLE IF NOT EXISTS cross_domain_finding_evidence (
  cross_domain_finding_id UUID NOT NULL REFERENCES cross_domain_findings(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cross_domain_finding_id, evidence_id),
  FOREIGN KEY (cross_domain_finding_id, org_id) REFERENCES cross_domain_findings(id, org_id),
  FOREIGN KEY (evidence_id, org_id) REFERENCES evidence(id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_cross_domain_sources_finding ON cross_domain_finding_sources(source_finding_id);
CREATE INDEX IF NOT EXISTS idx_cross_domain_evidence_evidence ON cross_domain_finding_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS remediation_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  logical_key TEXT NOT NULL,
  finding_ids UUID[] NOT NULL CHECK (cardinality(finding_ids) >= 1),
  title VARCHAR(500) NOT NULL,
  problem TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  implementation_steps JSONB NOT NULL,
  expected_benefit TEXT NOT NULL,
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  validation_plan JSONB NOT NULL,
  requires_human_approval BOOLEAN NOT NULL DEFAULT TRUE CHECK (requires_human_approval = TRUE),
  approval_status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED' CHECK (approval_status IN ('PROPOSED','APPROVED','REJECTED','EXPIRED')),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, scan_id, logical_key)
);
CREATE INDEX IF NOT EXISTS idx_remediation_scan ON remediation_proposals(org_id, scan_id, created_at DESC);
ALTER TABLE remediation_proposals ADD CONSTRAINT remediation_proposals_id_org_unique UNIQUE (id, org_id);

CREATE TABLE IF NOT EXISTS remediation_proposal_findings (
  proposal_id UUID NOT NULL REFERENCES remediation_proposals(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, finding_id),
  FOREIGN KEY (proposal_id, org_id) REFERENCES remediation_proposals(id, org_id),
  FOREIGN KEY (finding_id, org_id) REFERENCES findings(id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_remediation_findings_finding ON remediation_proposal_findings(finding_id);

ALTER TABLE cross_domain_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE remediation_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_domain_finding_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_domain_finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE remediation_proposal_findings ENABLE ROW LEVEL SECURITY;
