-- Phase 9A: membership-backed RLS and tenant-safe relationship constraints.

CREATE OR REPLACE FUNCTION public.zn_current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub', current_setting('request.jwt.claim.sub', true)) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    THEN COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub', current_setting('request.jwt.claim.sub', true))::uuid
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.zn_user_is_org_member(target_org UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = public.zn_current_user_id() AND org_id = target_org
  )
$$;

DO $$
DECLARE candidate_table TEXT;
BEGIN
  FOREACH candidate_table IN ARRAY ARRAY[
    'audit_log','agent_executions','agent_stage_claims','adaptation_decisions','claims','cross_domain_findings',
    'cross_domain_finding_sources','cross_domain_finding_evidence','evidence_requests',
    'finding_evidence','instruction_compositions','instruction_plans','instructions',
    'model_preferences','monitoring_configs','monitoring_runs','monitoring_baselines',
    'monitoring_changes','notification_deliveries','quality_assessments','quality_policies',
    'regeneration_runs','reports','remediation_proposals','remediation_proposal_findings',
    'routing_candidates','routing_decisions','routing_feedback','routing_policies',
    'scan_scores','scans','websites','alert_rules','alerts'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema='public' AND c.table_name=candidate_table AND c.column_name='org_id') THEN
      EXECUTE format('DROP POLICY IF EXISTS %I_org_membership ON %I', candidate_table, candidate_table);
      EXECUTE format('CREATE POLICY %I_org_membership ON %I FOR ALL TO authenticated USING (public.zn_user_is_org_member(org_id)) WITH CHECK (public.zn_user_is_org_member(org_id))', candidate_table, candidate_table);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS memberships_org_membership ON memberships;
CREATE POLICY memberships_org_membership ON memberships FOR ALL TO authenticated
  USING (user_id = public.zn_current_user_id() OR public.zn_user_is_org_member(org_id))
  WITH CHECK (user_id = public.zn_current_user_id() OR public.zn_user_is_org_member(org_id));

DROP POLICY IF EXISTS organizations_membership ON organizations;
CREATE POLICY organizations_membership ON organizations FOR SELECT TO authenticated
  USING (public.zn_user_is_org_member(id));

DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users FOR SELECT TO authenticated
  USING (id = public.zn_current_user_id());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='websites_id_org_unique') THEN
    ALTER TABLE websites ADD CONSTRAINT websites_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scans_id_org_unique') THEN
    ALTER TABLE scans ADD CONSTRAINT scans_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='findings_id_org_unique') THEN
    ALTER TABLE findings ADD CONSTRAINT findings_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='evidence_id_org_unique') THEN
    ALTER TABLE evidence ADD CONSTRAINT evidence_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_configs_id_org_unique') THEN
    ALTER TABLE monitoring_configs ADD CONSTRAINT monitoring_configs_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_changes_id_org_unique') THEN
    ALTER TABLE monitoring_changes ADD CONSTRAINT monitoring_changes_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_id_org_unique') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reports_id_org_unique') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_stage_claims_id_org_unique') THEN
    ALTER TABLE agent_stage_claims ADD CONSTRAINT agent_stage_claims_id_org_unique UNIQUE (scan_id, stage_name, org_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scans_website_org_fk') THEN
    ALTER TABLE scans ADD CONSTRAINT scans_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='findings_scan_org_fk') THEN
    ALTER TABLE findings ADD CONSTRAINT findings_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='findings_website_org_fk') THEN
    ALTER TABLE findings ADD CONSTRAINT findings_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='evidence_finding_org_fk') THEN
    ALTER TABLE evidence ADD CONSTRAINT evidence_finding_org_fk FOREIGN KEY (finding_id, org_id) REFERENCES findings(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_website_org_fk') THEN
    ALTER TABLE monitoring_configs ADD CONSTRAINT monitoring_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_runs_config_org_fk') THEN
    ALTER TABLE monitoring_runs ADD CONSTRAINT monitoring_runs_config_org_fk FOREIGN KEY (monitoring_id, org_id) REFERENCES monitoring_configs(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_changes_config_org_fk') THEN
    ALTER TABLE monitoring_changes ADD CONSTRAINT monitoring_changes_config_org_fk FOREIGN KEY (monitoring_id, org_id) REFERENCES monitoring_configs(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_config_org_fk') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_config_org_fk FOREIGN KEY (monitoring_id, org_id) REFERENCES monitoring_configs(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scan_scores_scan_org_fk') THEN
    ALTER TABLE scan_scores ADD CONSTRAINT scan_scores_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_executions_scan_org_fk') THEN
    ALTER TABLE agent_executions ADD CONSTRAINT agent_executions_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_stage_claims_scan_org_fk') THEN
    ALTER TABLE agent_stage_claims ADD CONSTRAINT agent_stage_claims_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reports_scan_org_fk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reports_website_org_fk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_runs_website_org_fk') THEN
    ALTER TABLE monitoring_runs ADD CONSTRAINT monitoring_runs_website_org_fk FOREIGN KEY (website_id, org_id) REFERENCES websites(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_runs_scan_org_fk') THEN
    ALTER TABLE monitoring_runs ADD CONSTRAINT monitoring_runs_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_baselines_config_org_fk') THEN
    ALTER TABLE monitoring_baselines ADD CONSTRAINT monitoring_baselines_config_org_fk FOREIGN KEY (monitoring_id, org_id) REFERENCES monitoring_configs(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_baselines_scan_org_fk') THEN
    ALTER TABLE monitoring_baselines ADD CONSTRAINT monitoring_baselines_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitoring_changes_scan_org_fk') THEN
    ALTER TABLE monitoring_changes ADD CONSTRAINT monitoring_changes_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_change_org_fk') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_change_org_fk FOREIGN KEY (change_id, org_id) REFERENCES monitoring_changes(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='notification_alert_org_fk') THEN
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_alert_org_fk FOREIGN KEY (alert_id, org_id) REFERENCES alerts(id, org_id);
  END IF;
END $$;

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_log FROM authenticated;
DROP POLICY IF EXISTS audit_log_org_membership ON audit_log;
CREATE POLICY audit_log_select ON audit_log FOR SELECT TO authenticated
  USING (public.zn_user_is_org_member(org_id));
CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO authenticated
  WITH CHECK (public.zn_user_is_org_member(org_id) AND (user_id IS NULL OR user_id = public.zn_current_user_id()));
