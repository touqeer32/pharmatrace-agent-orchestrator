import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asJson, JsonObject } from '../common/json';
import { DatabaseService } from '../database/database.service';
import { PHARMATRACE_TOOLS } from '../pharmatrace/pharmatrace-tools';
import { CreateMcpServerDto, UpdateMcpServerDto } from './dto/mcp.dto';
import { McpClientService } from './mcp-client.service';
import { McpServer, McpToolDefinition, McpToolRecord } from './mcp.types';

@Injectable()
export class McpRegistryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly client: McpClientService,
  ) {}

  async create(tenantId: string, dto: CreateMcpServerDto): Promise<McpServer> {
    this.rejectPlaintextSecrets(dto.authConfig ?? {});
    const metadata = {
      serverType: 'PHARMATRACE_GRAPHQL',
      ...dto.metadata,
    };

    return (await this.database.one<McpServer>(
      `INSERT INTO mcp_servers
       (tenant_id, name, description, transport, endpoint, auth_config, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
      [
        tenantId,
        dto.name,
        dto.description ?? null,
        dto.transport ?? 'STREAMABLE_HTTP',
        dto.endpoint,
        asJson(dto.authConfig ?? {}),
        asJson(metadata),
      ],
    )) as McpServer;
  }

  async listServers(tenantId: string): Promise<McpServer[]> {
    const result = await this.database.query<McpServer>(
      `SELECT * FROM mcp_servers
       WHERE tenant_id = $1 OR tenant_id IS NULL
       ORDER BY name`,
      [tenantId],
    );
    return result.rows;
  }

  async getServer(tenantId: string, serverId: string): Promise<McpServer> {
    const server = await this.database.one<McpServer>(
      `SELECT * FROM mcp_servers
       WHERE id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)`,
      [serverId, tenantId],
    );

    if (!server) {
      throw new NotFoundException('MCP server was not found');
    }

    return server;
  }

  async update(
    tenantId: string,
    serverId: string,
    dto: UpdateMcpServerDto,
  ): Promise<McpServer> {
    const existing = await this.getServer(tenantId, serverId);

    if (existing.tenant_id !== tenantId) {
      throw new BadRequestException('Shared MCP servers cannot be changed by a tenant');
    }

    if (dto.authConfig) {
      this.rejectPlaintextSecrets(dto.authConfig);
    }

    const server = await this.database.one<McpServer>(
      `UPDATE mcp_servers
       SET name = $3, description = $4, endpoint = $5,
           auth_config = $6::jsonb, metadata = $7::jsonb, enabled = $8
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        serverId,
        dto.name ?? existing.name,
        dto.description ?? existing.description,
        dto.endpoint ?? existing.endpoint,
        asJson(dto.authConfig ?? existing.auth_config),
        asJson(dto.metadata ?? existing.metadata),
        dto.enabled ?? existing.enabled,
      ],
    );

    return server as McpServer;
  }

  async syncTools(tenantId: string, serverId: string): Promise<Record<string, unknown>> {
    const server = await this.getServer(tenantId, serverId);

    if (!server.enabled) {
      throw new BadRequestException('Cannot synchronize a disabled MCP server');
    }

    const definitions =
      server.metadata.serverType === 'PHARMATRACE_GRAPHQL'
        ? PHARMATRACE_TOOLS
        : this.normalizeRemoteDefinitions(await this.client.listTools(server));

    for (const definition of definitions) {
      await this.database.query(
        `INSERT INTO mcp_tools
         (server_id, name, description, domain, entity_type, operation_name,
          input_schema, keywords, capabilities, related_tool_names, metadata, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, TRUE)
         ON CONFLICT (server_id, name)
         DO UPDATE SET description = EXCLUDED.description,
                       domain = EXCLUDED.domain,
                       entity_type = EXCLUDED.entity_type,
                       operation_name = EXCLUDED.operation_name,
                       input_schema = EXCLUDED.input_schema,
                       keywords = EXCLUDED.keywords,
                       capabilities = EXCLUDED.capabilities,
                       related_tool_names = EXCLUDED.related_tool_names,
                       enabled = TRUE`,
        [
          server.id,
          definition.name,
          definition.description,
          'pharmaceutical_traceability',
          definition.entityType,
          definition.operationName,
          asJson(definition.inputSchema),
          definition.keywords,
          definition.capabilities,
          definition.relatedToolNames,
          asJson({ source: server.metadata.serverType ?? 'REMOTE_MCP' }),
        ],
      );
    }

    await this.database.query(
      'UPDATE mcp_tools SET enabled = FALSE WHERE server_id = $1 AND NOT (name = ANY($2::text[]))',
      [server.id, definitions.map((item) => item.name)],
    );

    return {
      serverId: server.id,
      synchronized: definitions.length,
      tools: definitions.map((item) => item.name),
    };
  }

  async listTools(tenantId: string, serverId?: string): Promise<McpToolRecord[]> {
    const result = await this.database.query<McpToolRecord>(
      `SELECT t.* FROM mcp_tools t
       JOIN mcp_servers s ON s.id = t.server_id
       WHERE (s.tenant_id = $1 OR s.tenant_id IS NULL)
         AND ($2::uuid IS NULL OR t.server_id = $2::uuid)
       ORDER BY t.name`,
      [tenantId, serverId ?? null],
    );
    return result.rows;
  }

  async getTool(tenantId: string, toolId: string): Promise<McpToolRecord> {
    const tool = await this.database.one<McpToolRecord>(
      `SELECT t.* FROM mcp_tools t
       JOIN mcp_servers s ON s.id = t.server_id
       WHERE t.id = $1 AND (s.tenant_id = $2 OR s.tenant_id IS NULL)`,
      [toolId, tenantId],
    );

    if (!tool) {
      throw new NotFoundException('MCP tool was not found');
    }

    return tool;
  }

  private normalizeRemoteDefinitions(tools: JsonObject[]): McpToolDefinition[] {
    return tools.map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? tool.name),
      operationName: String(tool.name),
      entityType: 'remote_tool',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonObject,
      keywords: [],
      capabilities: [],
      relatedToolNames: [],
    }));
  }

  private rejectPlaintextSecrets(configuration: JsonObject): void {
    const blocked = new Set([
      'password',
      'clientsecret',
      'apikey',
      'accesstoken',
      'refreshtoken',
      'authorization',
    ]);

    for (const key of Object.keys(configuration)) {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();

      if (blocked.has(normalized)) {
        throw new BadRequestException(
          `authConfig.${key} must not contain plaintext credentials; use a secret reference such as ${key}Ref`,
        );
      }
    }
  }
}
