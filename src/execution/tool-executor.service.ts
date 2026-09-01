import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject } from '../common/json';
import { DatabaseService } from '../database/database.service';
import { McpAccessService } from '../mcp/mcp-access.service';
import { McpClientService } from '../mcp/mcp-client.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { McpToolRecord } from '../mcp/mcp.types';
import { PharmaTraceGraphqlService } from '../pharmatrace/pharmatrace-graphql.service';
import { AgentRunRecord } from './execution.types';
import { RunStepService } from './run-step.service';
import { Logger } from '@nestjs/common';
import { redact, safeErrorMessage } from '../common/redact';
import { LotAnchorService } from '../pharmatrace/lot-anchor.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly access: McpAccessService,
    private readonly registry: McpRegistryService,
    private readonly remoteClient: McpClientService,
    private readonly pharmatrace: PharmaTraceGraphqlService,
    private readonly steps: RunStepService,
    private readonly lotAnchor: LotAnchorService,
  ) {}

  buildTools(input: {
    agent: AgentRecord;
    run: AgentRunRecord;
    tools: McpToolRecord[];
    iteration: number;
  }): ToolSet {
    return Object.fromEntries(
      input.tools.map((record) => [
        record.name,
        tool({
          description: record.description,
          inputSchema: jsonSchema<JsonObject>(record.input_schema),
          execute: async (argumentsValue: JsonObject) =>
            this.execute(input.agent, input.run, record, argumentsValue, input.iteration),
        }),
      ]),
    );
  }

  async execute(
    agent: AgentRecord,
    run: AgentRunRecord,
    candidate: McpToolRecord,
    args: JsonObject,
    iteration: number,
  ): Promise<unknown> {
    const authorized = await this.access.requireTool(run.tenant_id, agent.id, candidate.name);
    this.validateArguments(authorized.input_schema, args);

    // An empty result from the discovery tool is a valid no-op for the anchoring
    // tool. Keep it out of the transaction path so the agent can finish with a
    // clear "nothing to anchor" result instead of failing on an empty payload.
    if (authorized.name === 'push_lots_to_hedera' &&
      (!Array.isArray(args.lotIds) || args.lotIds.length === 0)) {
      const result = {
        status: 'COMPLETED',
        operation: 'NOOP',
        reason: 'No unconfirmed lots were returned by list_batch_lots',
        totalRequested: 0,
        lotsPushed: 0,
        lotsSkipped: 0,
        lotsFailed: 0,
        results: [],
      };
      this.logger.warn('Skipping lot anchor with no lot IDs', {
        runId: run.id,
        tenantId: run.tenant_id,
        tool: authorized.name,
        receivedLotIdsType: Array.isArray(args.lotIds) ? 'array' : typeof args.lotIds,
      });
      return result;
    }

    const reserved = await this.database.one<{ tool_call_count: number }>(
      `UPDATE agent_runs
       SET tool_call_count = tool_call_count + 1
       WHERE id = $1
         AND status = 'EXECUTING'
         AND tool_call_count < $2
       RETURNING tool_call_count`,
      [run.id, agent.max_tool_calls],
    );

    if (!reserved) {
      throw new ConflictException('The run was cancelled or reached its maximum tool-call limit');
    }

    const server = await this.registry.getServer(run.tenant_id, authorized.server_id);
    const stepId = await this.steps.start({
      runId: run.id,
      iterationNumber: iteration,
      stepType: 'TOOL_CALL',
      mcpServerId: server.id,
      mcpToolId: authorized.id,
      toolName: authorized.name,
      inputPayload: args,
    });

    try {
      const result =
        authorized.name === 'push_lots_to_hedera'
          ? await this.lotAnchor.anchorLots(server, args.lotIds as string[])
          : server.metadata.serverType === 'PHARMATRACE_GRAPHQL'
          ? await this.pharmatrace.execute(server, authorized, args)
          : await this.remoteClient.callTool(server, authorized.name, args);

      if (process.env.DEBUG_MCP_TOOL_RESULTS === 'true') {
        const redactedResult = redact(result);
        const serialized = JSON.stringify(redactedResult) ?? 'null';
        this.logger.log('MCP tool response', {
          runId: run.id,
          tenantId: run.tenant_id,
          tool: authorized.name,
          response: serialized.length > 20000
            ? serialized.slice(0, 20000) + '...[truncated]'
            : redactedResult,
          responseLength: serialized.length,
        });
      }

      await this.steps.complete(stepId, result);
      return result;
    } catch (error) {
      this.logger.error('MCP tool failed', {
        runId: run.id,
        tenantId: run.tenant_id,
        tool: authorized.name,
        error: safeErrorMessage(error),
      });
      await this.steps.fail(stepId, error);
      throw error;
    }
  }

  private validateArguments(schema: JsonObject, args: JsonObject): void {
    const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

    for (const name of required) {
      if (!(name in args)) {
        throw new BadRequestException(`MCP tool argument ${name} is required`);
      }
    }

    for (const [name, value] of Object.entries(args)) {
      const property = properties[name];

      if (!property && schema.additionalProperties === false) {
        throw new BadRequestException(`MCP tool argument ${name} is not allowed`);
      }

      if (!property) {
        continue;
      }

      if (property.type === 'string' && typeof value !== 'string') {
        throw new BadRequestException(`MCP tool argument ${name} must be a string`);
      }

      if (property.type === 'integer' && !Number.isInteger(value)) {
        throw new BadRequestException(`MCP tool argument ${name} must be an integer`);
      }

      if (typeof value === 'number' && typeof property.minimum === 'number' && value < property.minimum) {
        throw new BadRequestException(`MCP tool argument ${name} is below its minimum`);
      }

      if (typeof value === 'number' && typeof property.maximum === 'number' && value > property.maximum) {
        throw new BadRequestException(`MCP tool argument ${name} exceeds its maximum`);
      }
    }
  }
}
