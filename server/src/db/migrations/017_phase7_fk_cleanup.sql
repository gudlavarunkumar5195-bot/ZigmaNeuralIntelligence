-- Phase 7: allow tenant-owned scan cleanup to cascade through proposal lineage.

ALTER TABLE remediation_proposal_findings
  DROP CONSTRAINT IF EXISTS remediation_proposal_findings_finding_id_org_id_fkey,
  ADD CONSTRAINT remediation_proposal_findings_finding_id_org_id_fkey
    FOREIGN KEY (finding_id, org_id) REFERENCES findings(id, org_id) ON DELETE CASCADE;
