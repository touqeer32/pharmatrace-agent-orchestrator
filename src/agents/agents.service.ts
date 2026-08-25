import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { asJson } from '../common/json';
import { TenantContext } from '../common/tenant-context';
import { DatabaseService } from '../database/database.service';
import { LlmConnectionService } from '../llm/llm-connection.service';
import { AgentRecord } from './agent.types';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';

@Injectable()
export class AgentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly connections: LlmConnectionService,
  ) {}

  async create(tenant: TenantContext, dto: CreateAgentDto): Promise<Record<string, unknown>> {
    const connection = await this.connections.get(tenant.tenantId, dto.llmConnectionId);

    if (!connection.enabled || connection.provider !== dto.llmProvider) {
      throw new BadRequestException('The LLM connection must be enabled and match llmProvider');
    }

    return this.database.transaction(async (client) => {
      await this.validateAllowlists(
        client,
        tenant.tenantId,
        dto.allowedMcpServerIds,
        dto.allowedMcpToolIds,
      );

      const result = await client.query<AgentRecord>(
        `INSERT INTO agents
         (tenant_id, created_by, name, description, expected_output, trigger_mode,
          llm_connection_id, llm_provider, llm_model, max_iterations, max_tool_calls,
          execution_timeout_seconds, default_input, output_schema, configuration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
         RETURNING *`,
        [
          tenant.tenantId,
          tenant.userId,
          dto.name,
          dto.description,
          dto.expectedOutput,
          dto.triggerMode ?? 'MANUAL',
          dto.llmConnectionId,
          dto.llmProvider,
          dto.llmModel,
          dto.maxIterations ?? 8,
          dto.maxToolCalls ?? 20,
          dto.executionTimeoutSeconds ?? 300,
          asJson(dto.defaultInput ?? {}),
          dto.outputSchema ? asJson(dto.outputSchema) : null,
          asJson(dto.configuration ?? {}),
        ],
      );

      const agent = result.rows[0];
      await this.replaceAllowlists(client, agent.id, dto.allowedMcpServerIds, dto.allowedMcpToolIds);
      return {
        ...agent,
        allowed_mcp_server_ids: dto.allowedMcpServerIds,
        allowed_mcp_tool_ids: dto.allowedMcpToolIds,
      };
    });
  }

  async list(tenantId: string): Promise<AgentRecord[]> {
    const result = await this.database.query<AgentRecord>(
      'SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return result.rows;
  }

  async get(tenantId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.database.one<AgentRecord>(
      'SELECT * FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );

    if (!agent) {
      throw new NotFoundException('Agent was not found');
    }

    return agent;
  }

  async getWithAccess(tenantId: string, agentId: string): Promise<Record<string, unknown>> {
    const agent = await this.get(tenantId, agentId);
    const [servers, tools] = await Promise.all([
      this.database.query<{ mcp_server_id: string }>(
        'SELECT mcp_server_id FROM agent_allowed_mcp_servers WHERE agent_id = $1',
        [agentId],
      ),
      this.database.query<{ mcp_tool_id: string }>(
        'SELECT mcp_tool_id FROM agent_allowed_mcp_tools WHERE agent_id = $1',
        [agentId],
      ),
    ]);

    return {
      ...agent,
      allowed_mcp_server_ids: servers.rows.map((row) => row.mcp_server_id),
      allowed_mcp_tool_ids: tools.rows.map((row) => row.mcp_tool_id),
    };
  }

  async update(
    tenant: TenantContext,
    agentId: string,
    dto: UpdateAgentDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.get(tenant.tenantId, agentId);
    const connectionId = dto.llmConnectionId ?? existing.llm_connection_id;
    const provider = dto.llmProvider ?? existing.llm_provider;
    const connection = await this.connections.get(tenant.tenantId, connectionId);

    if (!connection.enabled || connection.provider !== provider) {
      throw new BadRequestException('The LLM connection must be enabled and match llmProvider');
    }

    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE agents
         SET name = $3, description = $4, expected_output = $5, trigger_mode = $6,
             llm_connection_id = $7, llm_provider = $8, llm_model = $9,
             max_iterations = $10, max_tool_calls = $11, execution_timeout_seconds = $12,
             default_input = $13::jsonb, output_schema = $14::jsonb, configuration = $15::jsonb
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenant.tenantId,
          agentId,
          dto.name ?? existing.name,
          dto.description ?? existing.description,
          dto.expectedOutput ?? existing.expected_output,
          dto.triggerMode ?? existing.trigger_mode,
          connectionId,
          provider,
          dto.llmModel ?? existing.llm_model,
          dto.maxIterations ?? existing.max_iterations,
          dto.maxToolCalls ?? existing.max_tool_calls,
          dto.executionTimeoutSeconds ?? existing.execution_timeout_seconds,
          asJson(dto.defaultInput ?? existing.default_input),
          dto.outputSchema ? asJson(dto.outputSchema) : existing.output_schema ? asJson(existing.output_schema) : null,
          asJson(dto.configuration ?? existing.configuration),
        ],
      );

      if (dto.allowedMcpServerIds || dto.allowedMcpToolIds) {
        const currentServers = dto.allowedMcpServerIds ??
          (await client.query<{ mcp_server_id: string }>(
            'SELECT mcp_server_id FROM agent_allowed_mcp_servers WHERE agent_id = $1',
            [agentId],
          )).rows.map((row) => row.mcp_server_id);
        const currentTools = dto.allowedMcpToolIds ??
          (await client.query<{ mcp_tool_id: string }>(
            'SELECT mcp_tool_id FROM agent_allowed_mcp_tools WHERE agent_id = $1',
            [agentId],
          )).rows.map((row) => row.mcp_tool_id);

        await this.validateAllowlists(client, tenant.tenantId, currentServers, currentTools);
        await this.replaceAllowlists(client, agentId, currentServers, currentTools);
      }

      if (
        dto.description !== undefined ||
        dto.expectedOutput !== undefined ||
        dto.allowedMcpServerIds !== undefined ||
        dto.allowedMcpToolIds !== undefined
      ) {
        await client.query(
          `UPDATE agent_execution_plans
           SET active = FALSE, invalidated_at = NOW(), invalidation_reason = 'Agent definition or authorized tools changed'
           WHERE agent_id = $1 AND active = TRUE`,
          [agentId],
        );
      }
    });

    return this.getWithAccess(tenant.tenantId, agentId);
  }

  async setStatus(
    tenantId: string,
    agentId: string,
    status: 'ACTIVE' | 'PAUSED',
  ): Promise<AgentRecord> {
    const agent = await this.database.one<AgentRecord>(
      'UPDATE agents SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
      [tenantId, agentId, status],
    );

    if (!agent) {
      throw new NotFoundException('Agent was not found');
    }

    return agent;
  }

  async remove(tenantId: string, agentId: string): Promise<{ deleted: true }> {
    const result = await this.database.query(
      'DELETE FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );

    if (!result.rowCount) {
      throw new NotFoundException('Agent was not found');
    }

    return { deleted: true };
  }

  private async validateAllowlists(
    client: PoolClient,
    tenantId: string,
    serverIds: string[],
    toolIds: string[],
  ): Promise<void> {
    const servers = await client.query<{ id: string }>(
      `SELECT id FROM mcp_servers
       WHERE id = ANY($1::uuid[])
         AND (tenant_id = $2 OR tenant_id IS NULL)
         AND enabled = TRUE`,
      [serverIds, tenantId],
    );

    if (servers.rowCount !== serverIds.length) {
      throw new BadRequestException('Every allowed MCP server must exist, be enabled, and belong to this tenant');
    }

    const tools = await client.query<{ id: string }>(
      `SELECT id FROM mcp_tools
       WHERE id = ANY($1::uuid[])
         AND server_id = ANY($2::uuid[])
         AND enabled = TRUE`,
      [toolIds, serverIds],
    );

    if (tools.rowCount !== toolIds.length) {
      throw new BadRequestException('Every allowed MCP tool must belong to an allowed server and be enabled');
    }
  }

  private async replaceAllowlists(
    client: PoolClient,
    agentId: string,
    serverIds: string[],
    toolIds: string[],
  ): Promise<void> {
    await client.query('DELETE FROM agent_allowed_mcp_tools WHERE agent_id = $1', [agentId]);
    await client.query('DELETE FROM agent_allowed_mcp_servers WHERE agent_id = $1', [agentId]);
    await client.query(
      `INSERT INTO agent_allowed_mcp_servers (agent_id, mcp_server_id)
       SELECT $1::uuid, value FROM unnest($2::uuid[]) AS value`,
      [agentId, serverIds],
    );
    await client.query(
      `INSERT INTO agent_allowed_mcp_tools (agent_id, mcp_tool_id)
       SELECT $1::uuid, value FROM unnest($2::uuid[]) AS value`,
      [agentId, toolIds],
    );
  }
}
