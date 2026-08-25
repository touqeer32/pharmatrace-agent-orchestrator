import { JsonObject } from '../common/json';

export interface McpServer {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  transport: 'STDIO' | 'SSE' | 'STREAMABLE_HTTP';
  endpoint: string;
  auth_config: JsonObject;
  metadata: JsonObject;
  enabled: boolean;
}

export interface McpToolRecord {
  id: string;
  server_id: string;
  name: string;
  description: string;
  domain: string | null;
  entity_type: string | null;
  operation_name: string | null;
  input_schema: JsonObject;
  output_schema: JsonObject | null;
  keywords: string[];
  capabilities: string[];
  related_tool_names: string[];
  metadata: JsonObject;
  enabled: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  operationName: string;
  entityType: string;
  inputSchema: JsonObject;
  keywords: string[];
  capabilities: string[];
  relatedToolNames: string[];
}
