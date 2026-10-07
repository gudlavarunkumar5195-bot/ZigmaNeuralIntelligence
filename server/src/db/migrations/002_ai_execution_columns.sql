-- Phase 3A: extend agent_executions with AI execution tracking columns

ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS correlation_id     UUID,
  ADD COLUMN IF NOT EXISTS execution_id       UUID,
  ADD COLUMN IF NOT EXISTS provider           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS prompt_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS finish_reason      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS instruction_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_agent_exec_correlation ON agent_executions(correlation_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_execution   ON agent_executions(execution_id);
