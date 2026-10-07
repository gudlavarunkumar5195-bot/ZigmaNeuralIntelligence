-- F-001: memberships/organizations must not be writable by Supabase client roles.
-- 022 created memberships_org_membership as FOR ALL with
-- WITH CHECK (user_id = self OR member-of-org): any authenticated user could
-- insert themselves as owner of ANY org, and any member could update/delete
-- memberships. Membership changes happen only through the application's
-- direct PostgreSQL connection (privileged role), never through PostgREST.
-- Historical migrations are untouched; this migration supersedes the policy.
DROP POLICY IF EXISTS memberships_org_membership ON memberships;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE POLICY memberships_select_own_orgs ON memberships FOR SELECT TO authenticated
      USING (user_id = public.zn_current_user_id() OR public.zn_user_is_org_member(org_id));
    REVOKE INSERT, UPDATE, DELETE ON memberships FROM authenticated;
    REVOKE INSERT, UPDATE, DELETE ON organizations FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE INSERT, UPDATE, DELETE ON memberships FROM anon;
    REVOKE INSERT, UPDATE, DELETE ON organizations FROM anon;
  END IF;
END $$;
