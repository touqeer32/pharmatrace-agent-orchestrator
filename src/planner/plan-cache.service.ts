import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentRecord } from '../agents/agent.types';
import { asJson, JsonObject } from '../common/json';
import { DatabaseService } from '../database/database.service';
import { McpToolRecord } from '../mcp/mcp.types';
import { ExecutionPlanRecord, PlannerOutput } from './planner.types';

@Injectable()
export class PlanCacheService {
  constructor(private readonly database: DatabaseService) {}

  definitionHash(agent: AgentRecord, tools: McpToolRecord[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          description: agent.description,
          expectedOutput: agent.expected_output,
          outputSchema: agent.output_schema,
          tools: tools
            .map((tool) => ({ id: tool.id, name: tool.name, inputSchema: tool.input_schema }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        }),
      )
      .digest('hex');
  }

  async getActive(agentId: string): Promise<ExecutionPlanRecord | null> {
    return this.database.one<ExecutionPlanRecord>(
      'SELECT * FROM agent_execution_plans WHERE agent_id = $1 AND active = TRUE',
      [agentId],
    );
  }

  async getReusable(
    agent: AgentRecord,
    tools: McpToolRecord[],
  ): Promise<ExecutionPlanRecord | null> {
    const active = await this.getActive(agent.id);

    if (!active) {
      return null;
    }

    const authorizedNames = new Set(tools.map((tool) => tool.name));
    const valid =
      active.agent_definition_hash === this.definitionHash(agent, tools) &&
      active.selected_tool_names.every((name) => authorizedNames.has(name));

    if (!valid) {
      await this.invalidate(agent.id, 'Agent definition or MCP tool catalog changed');
      return null;
    }

    return active;
  }

  async save(
    agent: AgentRecord,
    tools: McpToolRecord[],
    plannerOutput: PlannerOutput,
  ): Promise<ExecutionPlanRecord> {
    const selectedNames = [...new Set(
      plannerOutput.steps
        .map((step) => step.tool)
        .filter((name): name is string => typeof name === 'string'),
    )];
    const selectedTools = tools.filter((tool) => selectedNames.includes(tool.name));
    const parameterTemplates: JsonObject = Object.fromEntries(
      plannerOutput.steps
        .filter((step) => step.tool)
        .map((step) => [step.tool as string, step.arguments ?? {}]),
    );

    return this.database.transaction(async (client) => {
      await client.query(
        `UPDATE agent_execution_plans
         SET active = FALSE, invalidated_at = NOW(), invalidation_reason = 'Superseded by a newer execution plan'
         WHERE agent_id = $1 AND active = TRUE`,
        [agent.id],
      );

      const result = await client.query<ExecutionPlanRecord>(
        `INSERT INTO agent_execution_plans
         (agent_id, version, active, agent_definition_hash, planner_summary,
          selected_server_ids, selected_tool_names, execution_graph, parameter_templates)
         VALUES (
           $1,
           COALESCE((SELECT MAX(version) + 1 FROM agent_execution_plans WHERE agent_id = $1), 1),
           TRUE, $2, $3, $4, $5, $6::jsonb, $7::jsonb
         )
         RETURNING *`,
        [
          agent.id,
          this.definitionHash(agent, tools),
          plannerOutput.objective,
          [...new Set(selectedTools.map((tool) => tool.server_id))],
          selectedNames,
          asJson(plannerOutput),
          asJson(parameterTemplates),
        ],
      );

      return result.rows[0];
    });
  }

  async invalidate(agentId: string, reason: string): Promise<{ invalidated: boolean }> {
    const result = await this.database.query(
      `UPDATE agent_execution_plans
       SET active = FALSE, invalidated_at = NOW(), invalidation_reason = $2
       WHERE agent_id = $1 AND active = TRUE`,
      [agentId, reason],
    );
    return { invalidated: Boolean(result.rowCount) };
  }

  async requireActive(agentId: string): Promise<ExecutionPlanRecord> {
    const plan = await this.getActive(agentId);

    if (!plan) {
      throw new NotFoundException('This agent has no active execution plan');
    }

    return plan;
  }

  async recordSuccess(planId: string): Promise<void> {
    await this.database.query(
      `UPDATE agent_execution_plans
       SET success_count = success_count + 1, last_used_at = NOW(), last_success_at = NOW()
       WHERE id = $1`,
      [planId],
    );
  }

  async recordFailure(planId: string): Promise<void> {
    await this.database.query(
      `UPDATE agent_execution_plans
       SET failure_count = failure_count + 1, last_used_at = NOW()
       WHERE id = $1`,
      [planId],
    );
  }
}
