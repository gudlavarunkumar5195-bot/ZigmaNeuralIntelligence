-- 034: Admin Control Center (additive only).
--
-- platform_credentials: platform-wide provider credentials managed by platform
--   administrators (e.g. the OpenRouter API key). Only the AES-256-GCM
--   ciphertext is stored; the key ring lives in INTEGRATION_ENCRYPTION_KEYS,
--   outside the database. A row exists only for a credential that passed
--   provider validation when it was saved.
-- password_reset_tokens: single-use reset tokens; only a SHA-256 hash is stored.
-- users.last_login_at: shown in Users & Access.
--
-- No existing table, column or row is dropped or rewritten.

CREATE TABLE platform_credentials (
  provider          TEXT        PRIMARY KEY CHECK (provider IN ('openrouter')),
  secret_enc        TEXT        NOT NULL,
  key_id            TEXT        NOT NULL,
  secret_suffix     TEXT        NOT NULL CHECK (char_length(secret_suffix) <= 4),
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  validated_at      TIMESTAMPTZ NOT NULL,
  last_check_at     TIMESTAMPTZ NOT NULL,
  last_check_status TEXT        NOT NULL CHECK (last_check_status IN ('valid','invalid','permission_denied','quota_exceeded','rate_limited','unavailable','timeout','error')),
  last_check_error  TEXT        CHECK (char_length(last_check_error) <= 500),
  details           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validation history for every integration (admin-managed or deployment-managed),
-- so "last validated" survives restarts. Never holds secret material.
CREATE TABLE platform_integration_checks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT        NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT        NOT NULL CHECK (status IN ('valid','invalid','permission_denied','quota_exceeded','rate_limited','unavailable','timeout','not_configured','error')),
  message     TEXT        CHECK (char_length(message) <= 500),
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  trigger     TEXT        NOT NULL CHECK (trigger IN ('save','test','scheduled')),
  checked_by  UUID        REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_platform_integration_checks ON platform_integration_checks (provider, checked_at DESC);

CREATE TABLE password_reset_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  requested_by UUID       REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens (user_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Server-only tables: RLS on with no policies, and no access for the
-- Supabase-compatible client roles (created by 000 when present).
ALTER TABLE platform_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integration_checks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON platform_credentials, platform_integration_checks, password_reset_tokens FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON platform_credentials, platform_integration_checks, password_reset_tokens FROM anon;
  END IF;
END $$;
REVOKE ALL ON platform_credentials, platform_integration_checks, password_reset_tokens FROM PUBLIC;
