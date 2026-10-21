-- Durable transactional outbox for ClickHouse analytics events.
--
-- Rows are written in the same transaction as the business change they
-- describe and dispatched to ClickHouse by a background worker that claims
-- them with FOR UPDATE SKIP LOCKED. PostgreSQL remains the source of truth;
-- ClickHouse only ever receives committed facts. Purely additive.

CREATE TABLE IF NOT EXISTS analytics_outbox (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_table    TEXT        NOT NULL CHECK (target_table IN (
                    'scan_events', 'scan_findings', 'ai_executions', 'ai_usage',
                    'monitoring_events', 'application_events')),
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  event_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'DEAD')),
  attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at   TIMESTAMPTZ,
  last_error      TEXT,
  CONSTRAINT analytics_outbox_event_id_unique UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_outbox_due
  ON analytics_outbox (next_attempt_at, id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_org
  ON analytics_outbox (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_dispatched
  ON analytics_outbox (dispatched_at) WHERE status = 'DISPATCHED';

-- Same posture as every other table: deny direct Data API access; the
-- Fastify API is the only database client.
ALTER TABLE analytics_outbox ENABLE ROW LEVEL SECURITY;
