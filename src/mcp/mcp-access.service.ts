import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { McpToolRecord } from './mcp.types';

@Injectable()
export class McpAccessService {
  constructor(private readonly database: DatabaseService) {}

  async toolsForAgent(tenantId: string, agentId: string): Promise<McpToolRecord[]> {
    const result = await this.database.query<McpToolRecord>(
      `SELECT DISTINCT t.*
       FROM agents a
       JOIN agent_allowed_mcp_servers allowed_servers
         ON allowed_servers.agent_id = a.id
       JOIN mcp_servers s
         ON s.id = allowed_servers.mcp_server_id
       JOIN mcp_tools t
         ON t.server_id = s.id
       JOIN agent_allowed_mcp_tools allowed_tools
         ON allowed_tools.agent_id = a.id AND allowed_tools.mcp_tool_id = t.id
       WHERE a.id = $1
         AND a.tenant_id = $2
         AND (s.tenant_id = $2 OR s.tenant_id IS NULL)
         AND s.enabled = TRUE
         AND t.enabled = TRUE
       ORDER BY t.name`,
      [agentId, tenantId],
    );
    return result.rows;
  }

  async requireTool(tenantId: string, agentId: string, toolName: string): Promise<McpToolRecord> {
    const tools = await this.toolsForAgent(tenantId, agentId);
    const tool = tools.find((item) => item.name === toolName);

    if (!tool) {
      throw new ForbiddenException(`Agent is not authorized to use MCP tool ${toolName}`);
    }

    return tool;
  }
}
