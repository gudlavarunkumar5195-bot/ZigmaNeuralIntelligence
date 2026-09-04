-- Phase 7: evidence deletion must not leave orphaned cross-domain lineage.

ALTER TABLE cross_domain_finding_evidence
  DROP CONSTRAINT IF EXISTS cross_domain_finding_evidence_evidence_id_org_id_fkey,
  ADD CONSTRAINT cross_domain_finding_evidence_evidence_id_org_id_fkey
    FOREIGN KEY (evidence_id, org_id) REFERENCES evidence(id, org_id) ON DELETE CASCADE;
