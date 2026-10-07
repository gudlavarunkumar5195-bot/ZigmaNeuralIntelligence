-- F-017: drop the obsolete migration-021 JWT-claim policies.
-- 021 created <table>_org_isolation (org_id = request.jwt.claim.org_id) on the
-- monitoring/alert tables. 022 added membership-based <table>_org_membership
-- policies on the same tables. Permissive policies are OR-ed, so the legacy
-- claim-based policy could grant access that the membership check denies.
-- Historical migrations are left untouched; this migration removes them.
DROP POLICY IF EXISTS monitoring_configs_org_isolation ON monitoring_configs;
DROP POLICY IF EXISTS monitoring_runs_org_isolation ON monitoring_runs;
DROP POLICY IF EXISTS monitoring_baselines_org_isolation ON monitoring_baselines;
DROP POLICY IF EXISTS monitoring_changes_org_isolation ON monitoring_changes;
DROP POLICY IF EXISTS alert_rules_org_isolation ON alert_rules;
DROP POLICY IF EXISTS alerts_org_isolation ON alerts;
DROP POLICY IF EXISTS notification_deliveries_org_isolation ON notification_deliveries;
