-- ============================================================================
-- DEPRECATED - DO NOT USE.
-- This file was a snapshot that stops at migration 011. It lacks every RLS
-- policy and tenant constraint added by migrations 012-026, so bootstrapping
-- a database from it silently loses tenant isolation.
-- Use the migration runner instead:  pnpm --dir server migrate
-- ============================================================================
DO $$ BEGIN RAISE EXCEPTION 'DEPRECATED: use the migration runner (pnpm --dir server migrate)'; END $$;
