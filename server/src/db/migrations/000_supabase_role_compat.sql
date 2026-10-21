-- Neon / plain PostgreSQL compatibility for Supabase-era policies.
--
-- Migrations 021 and 022 create RLS policies `TO authenticated` and revoke
-- privileges from it. Those roles exist on Supabase but NOT on a fresh Neon
-- or vanilla PostgreSQL database, so a fresh deploy aborted at 021 with
-- `role "authenticated" does not exist`.
--
-- Applied migrations are never edited (the runner enforces checksums), so
-- this migration sorts first (version 000) and creates the two roles only when
-- they are missing:
--   * fresh databases: runs before 021/022, which then apply cleanly;
--   * existing databases (021-026 already applied): runs once, finds the
--     roles present and does nothing.
--
-- The roles are NOLOGIN and receive no grants here. The application connects
-- with its own DATABASE_URL role; these roles only give the existing policies
-- something to name. They are inert unless a Data API (PostgREST) is pointed
-- at the database.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION
        WHEN duplicate_object THEN
          -- Created concurrently by another database in the same cluster.
          NULL;
        WHEN insufficient_privilege THEN
          RAISE EXCEPTION 'Role "%" is missing and the migration user lacks CREATEROLE. Ask a database administrator to run: CREATE ROLE % NOLOGIN;', role_name, role_name;
      END;
    END IF;
  END LOOP;
END
$$;
