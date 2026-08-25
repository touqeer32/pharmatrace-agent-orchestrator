import { JsonObject } from '../common/json';
import { LlmProvider } from '../llm/llm.types';

export interface AgentRunRecord {
  id: string;
  agent_id: string;
  tenant_id: string;
  schedule_id: string | null;
  execution_plan_id: string | null;
  trigger_source: 'MANUAL' | 'SCHEDULED' | 'API';
  triggered_by: string | null;
  status:
    | 'QUEUED'
    | 'PLANNING'
    | 'EXECUTING'
    | 'GENERATING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  user_query: string | null;
  input_parameters: JsonObject;
  expected_output_snapshot: string;
  llm_provider_snapshot: LlmProvider;
  llm_model_snapshot: string;
  reused_execution_plan: boolean;
  force_replan: boolean;
  tool_call_count: number;
  iteration_count: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
