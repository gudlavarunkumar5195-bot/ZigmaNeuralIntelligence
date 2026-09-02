-- Phase 3E: Versioned, validated instruction intelligence. Global profiles are
-- immutable by default; execution plans are tenant-scoped for auditability.

CREATE TABLE instruction_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type VARCHAR(100) NOT NULL,
  agent_version VARCHAR(20) NOT NULL,
  current_version VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_type, agent_version, current_version)
);

CREATE TABLE instruction_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_profile_id UUID NOT NULL REFERENCES instruction_profiles(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  instructions JSONB NOT NULL,
  required_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(instruction_profile_id, version)
);

CREATE TABLE instruction_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  task_id TEXT,
  agent_type VARCHAR(100) NOT NULL,
  agent_version VARCHAR(20) NOT NULL,
  profile_version VARCHAR(20) NOT NULL,
  status VARCHAR(40) NOT NULL,
  base_instruction_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  additional_instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_source VARCHAR(20) NOT NULL,
  composition_hash CHAR(64),
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_instruction_plans_org ON instruction_plans(org_id, created_at DESC);

CREATE TABLE instruction_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_plan_id UUID NOT NULL REFERENCES instruction_plans(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('APPROVED','REJECTED')),
  violations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE instruction_compositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_plan_id UUID NOT NULL REFERENCES instruction_plans(id) ON DELETE CASCADE,
  composition_hash CHAR(64) NOT NULL,
  ordered_sections JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
