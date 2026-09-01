import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JsonObject } from '../common/json';
import { KeycloakAuthService } from '../pharmatrace/keycloak-auth.service';
import { McpServer } from './mcp.types';

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

@Injectable()
export class McpClientService {
  private readonly sessions = new Map<string, string>();

  constructor(private readonly auth: KeycloakAuthService) {}

  async listTools(server: McpServer): Promise<JsonObject[]> {
    await this.request(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'pharmatrace-agent-orchestrator', version: '1.0.0' },
    });
    await this.notifyInitialized(server);

    const result = (await this.request(server, 'tools/list', {})) as {
      tools?: JsonObject[];
    };
    return result.tools ?? [];
  }

  async callTool(server: McpServer, name: string, args: JsonObject): Promise<unknown> {
    const result = (await this.request(server, 'tools/call', {
      name,
      arguments: args,
    })) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean };

    if (result.isError) {
      throw new BadGatewayException(`Remote MCP tool ${name} returned an error`);
    }

    return result.structuredContent ?? result.content ?? result;
  }

  private async request(server: McpServer, method: string, params: JsonObject): Promise<unknown> {
    if (server.transport !== 'STREAMABLE_HTTP') {
      throw new BadRequestException('Only STREAMABLE_HTTP external MCP servers are currently supported');
    }

    // Never issue an MCP request until Keycloak authentication has succeeded.
    const accessToken = await this.auth.getAccessToken(server);
    const sessionId = this.sessions.get(server.id);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
      ...(server.tenant_id ? { 'x-tenant-id': server.tenant_id } : {}),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    };

    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
    });

    if (response.status === 401 || response.status === 403) {
      this.auth.invalidate(server.id);
      const details = (await response.text()).slice(0, 500);
      throw new BadGatewayException(
        `Authenticated MCP request was rejected with HTTP ${response.status}${details ? `: ${details}` : ''}`,
      );
    }

    if (!response.ok) {
      const details = (await response.text()).slice(0, 1000);
      throw new BadGatewayException(
        `Remote MCP server returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
      );
    }

    const issuedSessionId = response.headers.get('mcp-session-id');

    if (issuedSessionId) {
      this.sessions.set(server.id, issuedSessionId);
    }

    const contentType = response.headers.get('content-type') ?? '';

    const payload = contentType.includes('text/event-stream')
      ? this.parseEventStream(await response.text())
      : contentType.includes('application/json')
        ? ((await response.json()) as JsonRpcResponse)
        : (() => {
            throw new BadGatewayException('The MCP server returned an unsupported response content type');
          })();

    if (payload.error) {
      throw new BadGatewayException(payload.error.message ?? `MCP method ${method} failed`);
    }

    return payload.result;
  }

  private async notifyInitialized(server: McpServer): Promise<void> {
    const accessToken = await this.auth.getAccessToken(server);
    const sessionId = this.sessions.get(server.id);
    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
        ...(server.tenant_id ? { 'x-tenant-id': server.tenant_id } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 1000);
      throw new BadGatewayException(
        `Remote MCP initialization notification returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
      );
    }
  }

  private parseEventStream(body: string): JsonRpcResponse {
    const events = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');

    for (let index = events.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(events[index]) as JsonRpcResponse;

        if ('result' in parsed || 'error' in parsed) {
          return parsed;
        }
      } catch {
        // Ignore non-JSON progress notifications and continue searching.
      }
    }

    throw new BadGatewayException('The MCP event stream did not contain a JSON-RPC response');
  }
}
