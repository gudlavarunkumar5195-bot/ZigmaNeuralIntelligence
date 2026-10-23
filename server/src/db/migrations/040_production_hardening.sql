-- 040: Production hardening (additive only; Phase 10 audit).
--
-- 1. Indexes for hot, tenant-scoped queries that previously filtered or sorted
--    a whole organization's rows (evidence: docs/production-readiness/PERFORMANCE-BASELINE.md).
--    Not CONCURRENTLY: the runner wraps each migration in a transaction. On a
--    large production table, build the index CONCURRENTLY by hand first (same
--    name, IF NOT EXISTS makes this migration a no-op afterwards); see the
--    release runbook.
-- 2. audit_log becomes append-only for the application: UPDATE, DELETE and
--    TRUNCATE raise unless the session explicitly opts into maintenance with
--    SET zigma.audit_maintenance = 'on' (documented retention or test cleanup).
--    This guards against application bugs and accidental edits; a database
--    owner can still drop the trigger, so it is not a substitute for off-site
--    log shipping.

CREATE INDEX IF NOT EXISTS idx_agent_executions_org_created ON agent_executions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_org_created ON findings (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_time ON audit_log (action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scans_website_created ON scans (website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_org_created ON scans (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_website_time ON monitoring_snapshots (website_id, captured_at DESC);
-- Retention prunes gsc_search_daily by day across all properties; BRIN keeps that cheap on the largest table.
CREATE INDEX IF NOT EXISTS idx_gsc_search_daily_day_brin ON gsc_search_daily USING brin (day);

CREATE OR REPLACE FUNCTION zigma_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('zigma.audit_maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION zigma_audit_log_append_only();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION zigma_audit_log_append_only();
