-- Phase 3D: Specialist Agent Framework
--
-- Global tables: agent definitions, versions, capabilities, tools, dependencies
-- Tenant-specific: executions + findings are already org_id scoped

-- ─── Core agent registry (global) ─────────────────────────────────────────────

CREATE TABLE specialist_agents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type      VARCHAR(100) NOT NULL UNIQUE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  risk_level      VARCHAR(20)  NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status          VARCHAR(50)  NOT NULL DEFAULT 'ACTIVE'
                               CHECK (status IN ('ACTIVE','DISABLED','DEPRECATED','REQUIRES_REVIEW')),
  current_version VARCHAR(20)  NOT NULL DEFAULT '1',
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Agent version history ─────────────────────────────────────────────────────

CREATE TABLE specialist_agent_versions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  version             VARCHAR(20) NOT NULL,
  status              VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (status IN ('ACTIVE','DEPRECATED','ARCHIVED')),
  instruction_profile JSONB,
  input_schema        JSONB,
  output_schema       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, version)
);

-- ─── Agent capabilities ────────────────────────────────────────────────────────

CREATE TABLE specialist_agent_capabilities (
  agent_id    UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  capability  VARCHAR(100) NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

-- ─── Agent tool permissions ────────────────────────────────────────────────────

CREATE TABLE specialist_agent_tools (
  agent_id         UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  tool_name        VARCHAR(100) NOT NULL,
  permission_level VARCHAR(20)  NOT NULL
                                CHECK (permission_level IN ('READ','ANALYZE','GENERATE','PROPOSE','EXECUTE')),
  description      TEXT,
  PRIMARY KEY (agent_id, tool_name)
);

-- ─── Agent dependencies ────────────────────────────────────────────────────────

CREATE TABLE specialist_agent_dependencies (
  agent_id         UUID        NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  depends_on_type  VARCHAR(100) NOT NULL,
  dependency_type  VARCHAR(20)  NOT NULL DEFAULT 'REQUIRED'
                               CHECK (dependency_type IN ('REQUIRED','OPTIONAL')),
  PRIMARY KEY (agent_id, depends_on_type)
);

-- ─── Extend agent_executions for Phase 3D ─────────────────────────────────────

ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS specialist_agent_id UUID REFERENCES specialist_agents(id),
  ADD COLUMN IF NOT EXISTS agent_version        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS routing_id           UUID,
  ADD COLUMN IF NOT EXISTS failure_type         VARCHAR(50);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_specialist_agents_type     ON specialist_agents(agent_type);
CREATE INDEX IF NOT EXISTS idx_specialist_agents_status   ON specialist_agents(status, enabled);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent       ON specialist_agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_specialist      ON agent_executions(specialist_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_exec_routing         ON agent_executions(routing_id);

-- ─── Seed initial agent definitions ───────────────────────────────────────────

INSERT INTO specialist_agents (agent_type, name, description, risk_level, status, current_version) VALUES
  ('DISCOVERY',           'Discovery Agent',           'Discovers and inventories website resources, domains, URLs, and technical signals.',          'LOW',    'ACTIVE', '1'),
  ('SEO_ANALYSIS',        'SEO Agent',                 'Analyzes search-engine optimization: metadata, headings, structured data, crawlability.',      'MEDIUM', 'ACTIVE', '1'),
  ('AEO_ANALYSIS',        'AEO Agent',                 'Analyzes answer-engine readiness: question-answer structure, semantic clarity, entities.',     'MEDIUM', 'ACTIVE', '1'),
  ('GEO_ANALYSIS',        'GEO Agent',                 'Analyzes generative-engine visibility: entity signals, citation-readiness, credibility.',      'MEDIUM', 'ACTIVE', '1'),
  ('SECURITY_ANALYSIS',   'Security Agent',            'Interprets authorized security scanner output, classifies findings, recommends remediation.',  'HIGH',   'ACTIVE', '1'),
  ('PERFORMANCE_ANALYSIS','Performance Agent',         'Analyzes performance evidence: metrics, bottlenecks, loading behavior, optimization.',         'MEDIUM', 'ACTIVE', '1'),
  ('ACCESSIBILITY_ANALYSIS','Accessibility Agent',     'Analyzes accessibility evidence: WCAG findings, semantic issues, keyboard and ARIA concerns.', 'MEDIUM', 'ACTIVE', '1'),
  ('QA_ANALYSIS',         'QA Agent',                  'Validates application behavior: functional tests, broken workflows, regression findings.',      'MEDIUM', 'ACTIVE', '1'),
  ('SSL_ANALYSIS',        'SSL / Infrastructure Agent','Interprets TLS, certificate, DNS, and HTTP infrastructure evidence.',                          'HIGH',   'ACTIVE', '1'),
  ('REMEDIATION',         'Remediation Agent',         'Generates proposed technical fixes, code changes, and configuration recommendations.',         'HIGH',   'ACTIVE', '1'),
  ('REPORT_SYNTHESIS',    'Report Synthesis Agent',    'Combines verified findings into a prioritized final report with implementation roadmap.',      'MEDIUM', 'ACTIVE', '1')
ON CONFLICT (agent_type) DO NOTHING;
