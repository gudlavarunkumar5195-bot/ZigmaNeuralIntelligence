-- Phase 8 completion: durable run recovery and tenant policies for Supabase clients.

ALTER TABLE monitoring_runs ADD COLUMN IF NOT EXISTS lease_owner UUID;
ALTER TABLE monitoring_runs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE monitoring_runs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitoring_runs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS lease_owner UUID;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE monitoring_runs DROP CONSTRAINT IF EXISTS monitoring_runs_status_check;
ALTER TABLE monitoring_runs ADD CONSTRAINT monitoring_runs_status_check CHECK (status IN ('PENDING','CLAIMED','RUNNING','COMPLETED','FAILED','CANCELLED'));

DROP INDEX IF EXISTS idx_monitoring_due;
CREATE INDEX IF NOT EXISTS idx_monitoring_due ON monitoring_configs(enabled, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_runs_lease ON monitoring_runs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_lease ON notification_deliveries(status, lease_until);

-- Browser access is scoped by the Supabase JWT org_id claim. The backend uses
-- its database role and continues to enforce organization scope in every query.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['monitoring_configs','monitoring_runs','monitoring_baselines','monitoring_changes','alert_rules','alerts','notification_deliveries'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation ON %I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_org_isolation ON %I FOR ALL TO authenticated USING (org_id = NULLIF(current_setting(''request.jwt.claim.org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''request.jwt.claim.org_id'', true), '''')::uuid)', table_name, table_name);
  END LOOP;
END $$;