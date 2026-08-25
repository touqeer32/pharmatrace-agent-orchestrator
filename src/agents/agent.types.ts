import { JsonObject } from '../common/json';
import { LlmProvider } from '../llm/llm.types';

export interface AgentRecord {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  description: string;
  expected_output: string;
  trigger_mode: 'MANUAL' | 'SCHEDULED' | 'BOTH';
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED';
  llm_connection_id: string;
  llm_provider: LlmProvider;
  llm_model: string;
  max_iterations: number;
  max_tool_calls: number;
  execution_timeout_seconds: number;
  default_input: JsonObject;
  output_schema: JsonObject | null;
  configuration: JsonObject;
  last_run_at: Date | null;
}
