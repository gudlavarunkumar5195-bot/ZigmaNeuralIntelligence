-- P0-7: at most one queued/running scan per website (database backstop).
--
-- The application already serialises scan creation per organization with an
-- advisory lock and returns the existing active scan on a double submit. This
-- partial unique index makes the invariant hold for every writer.
--
-- Safety: if an existing database already holds duplicate active scans (from
-- before this change), creating the index would fail and block the whole
-- release. In that case the index is skipped with a WARNING and the app-level
-- guard still applies; resolve the duplicates (let them finish or cancel
-- them) and add the index in a later migration. On a fresh or clean database
-- the index is always created.
--
-- Not CONCURRENTLY: the runner wraps each migration in a transaction. The
-- index covers only active rows, so the build is small and brief.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scans
     WHERE status IN ('queued', 'running')
     GROUP BY website_id HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'scans_one_active_per_website NOT created: duplicate active scans exist. Resolve them and add the index in a new migration.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS scans_one_active_per_website
      ON scans (website_id) WHERE status IN ('queued', 'running');
  END IF;
END
$$;
