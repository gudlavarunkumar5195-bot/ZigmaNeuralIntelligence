ALTER TABLE websites
  ADD COLUMN IF NOT EXISTS verification_environment VARCHAR(20);