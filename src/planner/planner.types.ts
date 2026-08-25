import { JsonObject } from '../common/json';

export interface ExecutionPlanStep {
  id: string;
  tool?: string;
  operation?: string;
  arguments?: JsonObject;
  repeatFor?: string;
  condition?: string;
}

export interface PlannerOutput {
  objective: string;
  steps: ExecutionPlanStep[];
  completionCriteria: string[];
}

export interface ExecutionPlanRecord {
  id: string;
  agent_id: string;
  version: number;
  active: boolean;
  agent_definition_hash: string;
  planner_summary: string | null;
  selected_server_ids: string[];
  selected_tool_names: string[];
  execution_graph: PlannerOutput;
  parameter_templates: JsonObject;
  success_count: number;
  failure_count: number;
}
