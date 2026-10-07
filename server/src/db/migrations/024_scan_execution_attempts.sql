-- F-015: bounded crash recovery. Counts how many times a worker has claimed a
-- scan so the lease sweeper can requeue until attempts are exhausted, then fail.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scans DROP CONSTRAINT IF EXISTS scans_execution_attempts_nonnegative;
ALTER TABLE scans ADD CONSTRAINT scans_execution_attempts_nonnegative CHECK (execution_attempts >= 0);
