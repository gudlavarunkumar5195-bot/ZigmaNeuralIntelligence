-- Phase 7: source finding deletion must not leave orphaned cross-domain lineage.

ALTER TABLE cross_domain_finding_sources
  DROP CONSTRAINT IF EXISTS cross_domain_finding_sources_source_finding_id_org_id_fkey,
  ADD CONSTRAINT cross_domain_finding_sources_source_finding_id_org_id_fkey
    FOREIGN KEY (source_finding_id, org_id) REFERENCES findings(id, org_id) ON DELETE CASCADE;
