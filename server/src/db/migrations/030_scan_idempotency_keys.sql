-- P0-7: idempotent scan submission (Idempotency-Key header on POST /scans).
--
-- A client retrying the same request with the same key gets the scan the
-- first request produced (created, or the already-active scan it was
-- deduplicated to), even after that scan finished. Reusing a key for a
-- different request is rejected by the API.
--
-- Keys are scoped per organization. The row is created in the same
-- transaction as the scan (under the per-organization admission lock), and
-- removed with its scan.
CREATE TABLE IF NOT EXISTS scan_idempotency_keys (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_fingerprint TEXT NOT NULL,
  scan_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, idempotency_key),
  -- The key and its scan always belong to the same organization.
  CONSTRAINT scan_idempotency_keys_scan_org_fk FOREIGN KEY (scan_id, org_id) REFERENCES scans (id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_idempotency_keys_scan ON scan_idempotency_keys (scan_id);

-- Same posture as 027/029: RLS on, no policies, so a Data API role sees
-- nothing; the API's own owner connection filters by org_id.
ALTER TABLE scan_idempotency_keys ENABLE ROW LEVEL SECURITY;
