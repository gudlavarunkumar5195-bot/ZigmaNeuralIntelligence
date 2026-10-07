-- Scan idempotency and bounded retry metadata.
-- Nullable keys preserve existing rows while making new scanner writes unique.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS logical_key TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS logical_key TEXT;
ALTER TABLE scan_modules ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_modules ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 2;

CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_scan_logical_key
  ON findings (org_id, scan_id, logical_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_task_logical_key
  ON evidence (org_id, task_id, logical_key);

ALTER TABLE scan_modules
  ADD CONSTRAINT scan_modules_retry_count_nonnegative CHECK (retry_count >= 0),
  ADD CONSTRAINT scan_modules_max_retries_nonnegative CHECK (max_retries >= 0);
