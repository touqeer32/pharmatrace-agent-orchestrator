import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { JsonObject } from '../common/json';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import { PharmaTraceGraphqlService } from '../pharmatrace/pharmatrace-graphql.service';
import { JsonRpcDto } from './dto/mcp.dto';
import { McpClientService } from './mcp-client.service';
import { McpRegistryService } from './mcp-registry.service';

@Controller('mcp/servers/:serverId')
export class PharmaTraceMcpController {
  constructor(
    private readonly registry: McpRegistryService,
    private readonly pharmatrace: PharmaTraceGraphqlService,
    private readonly remoteClient: McpClientService,
  ) {}

  @Post('rpc')
  async handle(
    @CurrentTenant() tenant: TenantContext,
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Body() request: JsonRpcDto,
  ): Promise<Record<string, unknown>> {
    const server = await this.registry.getServer(tenant.tenantId, serverId);

    if (!server.enabled) {
      throw new BadRequestException('The MCP server is disabled');
    }

    let result: unknown;

    if (request.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: '1.0.0' },
      };
    } else if (request.method === 'tools/list') {
      const records = await this.registry.listTools(tenant.tenantId, serverId);
      result = {
        tools: records.filter((record) => record.enabled).map((record) => ({
          name: record.name,
          description: record.description,
          inputSchema: record.input_schema,
        })),
      };
    } else if (request.method === 'tools/call') {
      const requestedName = request.params?.name;

      if (typeof requestedName !== 'string') {
        throw new BadRequestException('tools/call requires params.name');
      }

      const args =
        request.params?.arguments && typeof request.params.arguments === 'object'
          ? (request.params.arguments as JsonObject)
          : {};
      const records = await this.registry.listTools(tenant.tenantId, serverId);
      const selected = records.find((record) => record.name === requestedName && record.enabled);

      if (!selected) {
        throw new BadRequestException(`Unknown or disabled MCP tool ${requestedName}`);
      }

      const value =
        server.metadata.serverType === 'PHARMATRACE_GRAPHQL'
          ? await this.pharmatrace.execute(server, selected, args)
          : await this.remoteClient.callTool(server, selected.name, args);

      result = {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent:
          value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : { result: value },
        isError: false,
      };
    } else {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `Unsupported method ${request.method}` },
      };
    }

    return { jsonrpc: '2.0', id: request.id ?? null, result };
  }
}
