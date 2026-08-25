CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE agent_trigger_mode AS ENUM ('MANUAL', 'SCHEDULED', 'BOTH');
CREATE TYPE agent_schedule_type AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE');
CREATE TYPE agent_status AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');
CREATE TYPE agent_run_status AS ENUM (
  'QUEUED', 'PLANNING', 'EXECUTING', 'GENERATING', 'COMPLETED', 'FAILED', 'CANCELLED'
);
CREATE TYPE agent_trigger_source AS ENUM ('MANUAL', 'SCHEDULED', 'API');
CREATE TYPE agent_step_type AS ENUM (
  'PLAN', 'TOOL_CALL', 'EVALUATION', 'REPLAN', 'FINAL_RESPONSE'
);
CREATE TYPE agent_step_status AS ENUM ('STARTED', 'COMPLETED', 'FAILED');
CREATE TYPE mcp_transport_type AS ENUM ('STDIO', 'SSE', 'STREAMABLE_HTTP');
CREATE TYPE llm_provider_type AS ENUM ('ANTHROPIC', 'OPENAI');

CREATE TABLE llm_provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  provider llm_provider_type NOT NULL,
  name VARCHAR(150) NOT NULL,
  api_key_secret_ref TEXT NOT NULL,
  api_key_hint VARCHAR(20),
  base_url TEXT,
  organization_id VARCHAR(200),
  project_id VARCHAR(200),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_tested_at TIMESTAMPTZ,
  last_test_succeeded BOOLEAN,
  last_test_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_llm_connection_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT uq_llm_connection_identity UNIQUE (id, tenant_id, provider)
);

CREATE INDEX idx_llm_connections_tenant_provider
  ON llm_provider_connections (tenant_id, provider);

CREATE TABLE mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  transport mcp_transport_type NOT NULL DEFAULT 'STREAMABLE_HTTP',
  endpoint TEXT NOT NULL,
  auth_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mcp_servers_tenant_name
    UNIQUE NULLS NOT DISTINCT (tenant_id, name)
);

CREATE TABLE mcp_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  domain VARCHAR(150),
  entity_type VARCHAR(150),
  operation_name VARCHAR(150),
  input_schema JSONB NOT NULL,
  output_schema JSONB,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  related_tool_names TEXT[] NOT NULL DEFAULT '{}',
  example_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mcp_tools_server_name UNIQUE (server_id, name)
);

CREATE INDEX idx_mcp_tools_server_id ON mcp_tools (server_id);
CREATE INDEX idx_mcp_tools_domain_entity ON mcp_tools (domain, entity_type);
CREATE INDEX idx_mcp_tools_keywords ON mcp_tools USING GIN (keywords);
CREATE INDEX idx_mcp_tools_capabilities ON mcp_tools USING GIN (capabilities);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  created_by UUID NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  trigger_mode agent_trigger_mode NOT NULL DEFAULT 'MANUAL',
  status agent_status NOT NULL DEFAULT 'ACTIVE',
  llm_connection_id UUID NOT NULL,
  llm_provider llm_provider_type NOT NULL,
  llm_model VARCHAR(150) NOT NULL,
  max_iterations INTEGER NOT NULL DEFAULT 8,
  max_tool_calls INTEGER NOT NULL DEFAULT 20,
  execution_timeout_seconds INTEGER NOT NULL DEFAULT 300,
  default_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_schema JSONB,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agents_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT fk_agents_llm_connection
    FOREIGN KEY (llm_connection_id, tenant_id, llm_provider)
    REFERENCES llm_provider_connections (id, tenant_id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT chk_agents_max_iterations CHECK (max_iterations BETWEEN 1 AND 50),
  CONSTRAINT chk_agents_max_tool_calls CHECK (max_tool_calls BETWEEN 1 AND 100),
  CONSTRAINT chk_agents_timeout CHECK (execution_timeout_seconds BETWEEN 10 AND 3600)
);

CREATE INDEX idx_agents_tenant_status ON agents (tenant_id, status);
CREATE INDEX idx_agents_created_by ON agents (created_by);

CREATE TABLE agent_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  schedule_type agent_schedule_type NOT NULL,
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  time_of_day TIME,
  day_of_week SMALLINT,
  day_of_month SMALLINT,
  scheduled_for TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  input_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_schedule_day_of_week CHECK (
    day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6
  ),
  CONSTRAINT chk_schedule_day_of_month CHECK (
    day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31
  ),
  CONSTRAINT chk_schedule_shape CHECK (
    (schedule_type = 'DAILY' AND time_of_day IS NOT NULL)
    OR (schedule_type = 'WEEKLY' AND time_of_day IS NOT NULL AND day_of_week IS NOT NULL)
    OR (schedule_type = 'MONTHLY' AND time_of_day IS NOT NULL AND day_of_month IS NOT NULL)
    OR (schedule_type = 'ONCE' AND scheduled_for IS NOT NULL)
  )
);

CREATE INDEX idx_agent_schedules_due
  ON agent_schedules (next_run_at) WHERE enabled = TRUE;
CREATE INDEX idx_agent_schedules_agent ON agent_schedules (agent_id);

CREATE TABLE agent_execution_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  agent_definition_hash VARCHAR(128) NOT NULL,
  planner_summary TEXT,
  selected_server_ids UUID[] NOT NULL DEFAULT '{}',
  selected_tool_names TEXT[] NOT NULL DEFAULT '{}',
  execution_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameter_templates JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agent_execution_plan_version UNIQUE (agent_id, version)
);

CREATE UNIQUE INDEX uq_agent_execution_plan_active
  ON agent_execution_plans (agent_id) WHERE active = TRUE;

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  schedule_id UUID REFERENCES agent_schedules (id) ON DELETE SET NULL,
  execution_plan_id UUID REFERENCES agent_execution_plans (id) ON DELETE SET NULL,
  trigger_source agent_trigger_source NOT NULL,
  triggered_by UUID,
  status agent_run_status NOT NULL DEFAULT 'QUEUED',
  user_query TEXT,
  input_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_output_snapshot TEXT NOT NULL,
  llm_provider_snapshot llm_provider_type NOT NULL,
  llm_model_snapshot VARCHAR(150) NOT NULL,
  reused_execution_plan BOOLEAN NOT NULL DEFAULT FALSE,
  force_replan BOOLEAN NOT NULL DEFAULT FALSE,
  planner_output JSONB,
  final_response TEXT,
  final_response_json JSONB,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  error_message TEXT,
  error_details JSONB,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_agent_created ON agent_runs (agent_id, created_at DESC);
CREATE INDEX idx_agent_runs_tenant_status ON agent_runs (tenant_id, status);
CREATE INDEX idx_agent_runs_schedule ON agent_runs (schedule_id);
CREATE INDEX idx_agent_runs_queued ON agent_runs (created_at) WHERE status = 'QUEUED';
CREATE UNIQUE INDEX uq_agent_runs_schedule_occurrence
  ON agent_runs (schedule_id, scheduled_at)
  WHERE schedule_id IS NOT NULL AND scheduled_at IS NOT NULL;

CREATE TABLE agent_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  iteration_number INTEGER NOT NULL DEFAULT 1,
  step_type agent_step_type NOT NULL,
  status agent_step_status NOT NULL DEFAULT 'STARTED',
  mcp_server_id UUID REFERENCES mcp_servers (id) ON DELETE SET NULL,
  mcp_tool_id UUID REFERENCES mcp_tools (id) ON DELETE SET NULL,
  tool_name VARCHAR(150),
  input_payload JSONB,
  output_payload JSONB,
  reasoning_summary TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_agent_run_step_number UNIQUE (run_id, step_number)
);

CREATE INDEX idx_agent_run_steps_run ON agent_run_steps (run_id, step_number);
CREATE INDEX idx_agent_run_steps_tool ON agent_run_steps (mcp_tool_id);

CREATE TABLE agent_allowed_mcp_servers (
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  mcp_server_id UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, mcp_server_id)
);

CREATE TABLE agent_allowed_mcp_tools (
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  mcp_tool_id UUID NOT NULL REFERENCES mcp_tools (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, mcp_tool_id)
);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touch_llm_provider_connections BEFORE UPDATE
  ON llm_provider_connections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_mcp_servers BEFORE UPDATE
  ON mcp_servers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_mcp_tools BEFORE UPDATE
  ON mcp_tools FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_agents BEFORE UPDATE
  ON agents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_agent_schedules BEFORE UPDATE
  ON agent_schedules FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_agent_execution_plans BEFORE UPDATE
  ON agent_execution_plans FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_agent_runs BEFORE UPDATE
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
