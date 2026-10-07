import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { RunAgentDto } from '../agents/dto/agent.dto';
import { asJson } from '../common/json';
import { safeErrorMessage } from '../common/redact';
import { TenantContext } from '../common/tenant-context';
import { DatabaseService } from '../database/database.service';
import { LlmConnectionService } from '../llm/llm-connection.service';
import { LlmProviderFactory } from '../llm/llm-provider.factory';
import { McpAccessService } from '../mcp/mcp-access.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { KeycloakAuthService } from '../pharmatrace/keycloak-auth.service';
import { PlanCacheService } from '../planner/plan-cache.service';
import { PlannerService } from '../planner/planner.service';
import { ExecutionLoopService } from './execution-loop.service';
import { AgentRunRecord } from './execution.types';
import { ResponseGeneratorService } from './response-generator.service';
import { RunStepService } from './run-step.service';
import { ComplianceService } from '../compliance/compliance.service';
import { AgentAuditService } from './agent-audit.service';

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly agents: AgentsService,
    private readonly connections: LlmConnectionService,
    private readonly models: LlmProviderFactory,
    private readonly access: McpAccessService,
    private readonly registry: McpRegistryService,
    private readonly auth: KeycloakAuthService,
    private readonly planner: PlannerService,
    private readonly plans: PlanCacheService,
    private readonly steps: RunStepService,
    private readonly loop: ExecutionLoopService,
    private readonly responses: ResponseGeneratorService,
    private readonly compliance: ComplianceService,
    private readonly agentAudit: AgentAuditService,
  ) {}

  async enqueue(
    tenant: TenantContext,
    agentId: string,
    dto: RunAgentDto,
  ): Promise<AgentRunRecord> {
    const agent = await this.agents.get(tenant.tenantId, agentId);

    if (agent.status !== 'ACTIVE') {
      throw new BadRequestException('Only active agents can be executed');
    }

    if (agent.trigger_mode === 'SCHEDULED') {
      throw new BadRequestException('This agent is configured for scheduled execution only');
    }

    return (await this.database.one<AgentRunRecord>(
      `INSERT INTO agent_runs
       (agent_id, tenant_id, trigger_source, triggered_by, user_query,
        input_parameters, expected_output_snapshot, llm_provider_snapshot,
        llm_model_snapshot, force_replan)
       VALUES ($1, $2, 'MANUAL', $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [
        agent.id,
        tenant.tenantId,
        tenant.userId,
        dto.query ?? null,
        asJson({ ...agent.default_input, ...dto.input }),
        agent.expected_output,
        agent.llm_provider,
        agent.llm_model,
        dto.forceReplan ?? false,
      ],
    )) as AgentRunRecord;
  }

  async claim(limit: number): Promise<AgentRunRecord[]> {
    const result = await this.database.query<AgentRunRecord>(
      `WITH pending AS (
         SELECT r.id
         FROM agent_runs r
         JOIN agents a ON a.id = r.agent_id
         WHERE r.status = 'QUEUED' AND a.status = 'ACTIVE'
         ORDER BY r.created_at
         FOR UPDATE OF r SKIP LOCKED
         LIMIT $1
       )
       UPDATE agent_runs r
       SET status = 'PLANNING', started_at = COALESCE(started_at, NOW())
       FROM pending
       WHERE r.id = pending.id
       RETURNING r.*`,
      [limit],
    );
    return result.rows;
  }

  async process(run: AgentRunRecord): Promise<void> {
    let activePlanId: string | null = null;

    try {
      const agent = await this.agents.get(run.tenant_id, run.agent_id);
      await this.agentAudit.record({
        tenantId: run.tenant_id,
        workflowId: run.id,
        actorId: agent.id,
        actionType: 'AGENT_RUN_STARTED',
        resourceType: 'AGENT_RUN',
        resourceId: run.id,
        status: 'STARTED',
        description: `Agent run started: ${agent.name}`,
        privateData: { agentName: agent.name, triggeredBy: run.triggered_by },
      });
      const authorizedTools = await this.access.toolsForAgent(run.tenant_id, agent.id);

      if (!authorizedTools.length) {
        throw new BadRequestException('Agent has no enabled, authorized MCP tools');
      }

      await this.authenticateMcpServers(run, authorizedTools);

      const connection = await this.connections.get(run.tenant_id, agent.llm_connection_id);

      if (connection.provider !== run.llm_provider_snapshot) {
        throw new BadRequestException('The agent provider changed after this run was queued');
      }

      const model = await this.models.create(connection, run.llm_model_snapshot);
      const configuredTimeoutSeconds = agent.execution_timeout_seconds;
      const isNvidiaEndpoint =
        connection.provider === 'OPENAI' &&
        (connection.base_url ?? '').toLowerCase().includes('integrate.api.nvidia.com');
      const nvidiaTimeoutSeconds = Number(
        process.env.NVIDIA_EXECUTION_TIMEOUT_SECONDS ?? 1200,
      );
      const executionTimeoutSeconds = isNvidiaEndpoint
        ? Math.max(configuredTimeoutSeconds, nvidiaTimeoutSeconds)
        : configuredTimeoutSeconds;

      this.logger.log('Agent execution timeout selected', {
        runId: run.id,
        provider: connection.provider,
        baseUrl: connection.base_url,
        configuredTimeoutSeconds,
        executionTimeoutSeconds,
      });
      let inputTokens = 0;
      let outputTokens = 0;
      let plan = !run.force_replan ? await this.plans.getReusable(agent, authorizedTools) : null;

      if (plan) {
        activePlanId = plan.id;
        await this.database.query(
          `UPDATE agent_runs
           SET execution_plan_id = $2, reused_execution_plan = TRUE, planner_output = $3::jsonb
           WHERE id = $1`,
          [run.id, plan.id, asJson(plan.execution_graph)],
        );
      } else {
        const planStep = await this.steps.start({
          runId: run.id,
          stepType: 'PLAN',
          inputPayload: {
            agentDescription: agent.description,
            expectedOutput: run.expected_output_snapshot,
            tools: authorizedTools.map((tool) => tool.name),
          },
        });

        try {
        const generated = await this.planner.generate({
          model,
          agent,
          traceRunId: run.id,
            userQuery: run.user_query,
            inputParameters: run.input_parameters,
            availableTools: authorizedTools,
          });
          inputTokens += generated.inputTokens;
          outputTokens += generated.outputTokens;
          plan = await this.plans.save(agent, authorizedTools, generated.plan);
          activePlanId = plan.id;
          await this.database.query(
            `UPDATE agent_runs
             SET execution_plan_id = $2, reused_execution_plan = FALSE, planner_output = $3::jsonb
             WHERE id = $1`,
            [run.id, plan.id, asJson(generated.plan)],
          );
          await this.steps.complete(planStep, generated.plan, {
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          });
        } catch (error) {
          await this.steps.fail(planStep, error);
          throw error;
        }
      }

      await this.database.query(
        "UPDATE agent_runs SET status = 'EXECUTING' WHERE id = $1 AND status != 'CANCELLED'",
        [run.id],
      );

      const execution = await this.loop.run({
        model,
        agent,
        run,
        plan,
        authorizedTools,
        executionTimeoutSeconds,
      });

      const unrecoveredToolFailures = await this.steps.unrecoveredToolFailures(run.id);
      if (unrecoveredToolFailures.length) {
        const details = unrecoveredToolFailures
          .map((failure) => String(failure.error_message ?? 'unknown tool error'))
          .join('; ');
        throw new Error('MCP tool execution failed: ' + details);
      }

      if (!execution.findings.length) {
        throw new Error(
          'No MCP tool call completed successfully; inspect the tool-call error for the upstream cause',
        );
      }

      activePlanId = execution.plan.id;
      inputTokens += execution.usage.inputTokens;
      outputTokens += execution.usage.outputTokens;

      const generating = await this.database.query(
        "UPDATE agent_runs SET status = 'GENERATING' WHERE id = $1 AND status != 'CANCELLED'",
        [run.id],
      );

      if (!generating.rowCount) {
        throw new Error('Agent run was cancelled');
      }

      const finalStep = await this.steps.start({
        runId: run.id,
        iterationNumber: execution.iterations,
        stepType: 'FINAL_RESPONSE',
        inputPayload: { findingCount: execution.findings.length },
      });

      try {
        const runCounters = await this.database.one<{ tool_call_count: number }>(
          'SELECT tool_call_count FROM agent_runs WHERE id = $1',
          [run.id],
        );
        const response = await this.responses.reviewProfileGroups({
          model,
          agent,
          run,
          findings: execution.findings,
          toolCallsUsed: Number(runCounters?.tool_call_count ?? execution.findings.length),
        }) ?? await this.responses.generate({
            model,
            agent,
            run,
            findings: execution.findings,
            draft: execution.draft,
            completedToolNames: execution.findings
              .map((finding) => finding.tool_name)
              .filter((name): name is string => typeof name === 'string'),
          });
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
        await this.steps.complete(finalStep, response.json ?? { text: response.text }, response.usage);

        if (response.json?.profiles && Array.isArray(response.json.profiles)) {
          const persistedReviews = await this.compliance.persistAgentProfileReview({
            tenantId: run.tenant_id,
            agentId: agent.id,
            agentName: agent.name,
            response: response.json,
          });
          response.json.processingStatus = 'COMPLETED';
          response.json.summary = `Validated ${persistedReviews.length} profile review report(s). Deterministic evidence and remediation metadata were preserved by the backend.`;
          response.text = JSON.stringify(response.json);
        }

        await this.database.transaction(async (client) => {
          const completed = await client.query<{ id: string; status: string }>(
            `UPDATE agent_runs
             SET status = 'COMPLETED', final_response = $2, final_response_json = $3::jsonb,
                 input_tokens = $4, output_tokens = $5, total_tokens = $6,
                 iteration_count = $7, completed_at = NOW()
             WHERE id = $1 AND status != 'CANCELLED'
             RETURNING id, status`,
            [
              run.id,
              response.text,
              response.json ? asJson(response.json) : null,
              inputTokens,
              outputTokens,
              inputTokens + outputTokens,
              execution.iterations,
            ],
          );

          if (!completed.rowCount) {
            throw new Error('Agent run was cancelled before the final response could be stored');
          }

          await client.query('UPDATE agents SET last_run_at = NOW() WHERE id = $1', [agent.id]);
        });

        this.logger.log('Agent run completed', {
          runId: run.id,
          status: 'COMPLETED',
          responseLength: response.text.length,
          hasJsonResponse: Boolean(response.json),
          inputTokens,
          outputTokens,
        });

        await this.agentAudit.record({
          tenantId: run.tenant_id,
          workflowId: run.id,
          actorId: agent.id,
          actionType: 'AGENT_RUN_COMPLETED',
          resourceType: 'AGENT_RUN',
          resourceId: run.id,
          status: 'COMPLETED',
          description: `Agent run completed: ${agent.name}`,
          privateData: { responseLength: response.text.length },
        });

        await this.plans.recordSuccess(execution.plan.id);
      } catch (error) {
        await this.steps.fail(finalStep, error);
        throw error;
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Agent run ${run.id} failed: ${message}`);

      await this.agentAudit.record({
        tenantId: run.tenant_id,
        workflowId: run.id,
        actorId: run.agent_id,
        actionType: 'AGENT_RUN_FAILED',
        resourceType: 'AGENT_RUN',
        resourceId: run.id,
        status: 'FAILED',
        description: `Agent run failed: ${message}`,
        privateData: { error: message },
      });

      await this.database.query(
        `UPDATE agent_runs
         SET status = CASE WHEN status = 'CANCELLED' THEN 'CANCELLED'::agent_run_status ELSE 'FAILED'::agent_run_status END,
             error_message = $2,
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = $1`,
        [run.id, message],
      );

      if (activePlanId) {
        await this.plans.recordFailure(activePlanId);
      }
    }
  }

  private async authenticateMcpServers(
    run: AgentRunRecord,
    tools: Array<{ server_id: string }>,
  ): Promise<void> {
    const serverIds = [...new Set(tools.map((tool) => tool.server_id))];

    for (const serverId of serverIds) {
      const server = await this.registry.getServer(run.tenant_id, serverId);
      await this.auth.getAccessToken(server);
      this.logger.log('MCP authentication completed', {
        runId: run.id,
        tenantId: run.tenant_id,
        serverId: server.id,
        serverName: server.name,
      });
    }
  }

  async listRuns(tenantId: string, agentId: string): Promise<AgentRunRecord[]> {
    await this.agents.get(tenantId, agentId);
    const result = await this.database.query<AgentRunRecord>(
      'SELECT * FROM agent_runs WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 100',
      [tenantId, agentId],
    );
    return result.rows;
  }

  async getRun(tenantId: string, agentId: string, runId: string): Promise<AgentRunRecord> {
    const run = await this.database.one<AgentRunRecord>(
      'SELECT * FROM agent_runs WHERE tenant_id = $1 AND agent_id = $2 AND id = $3',
      [tenantId, agentId, runId],
    );

    if (!run) {
      throw new NotFoundException('Agent run was not found');
    }

    return run;
  }

  async runSteps(
    tenantId: string,
    agentId: string,
    runId: string,
    toolCallsOnly = false,
  ): Promise<Record<string, unknown>[]> {
    await this.getRun(tenantId, agentId, runId);
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM agent_run_steps
       WHERE run_id = $1 AND ($2::boolean = FALSE OR step_type = 'TOOL_CALL')
       ORDER BY step_number`,
      [runId, toolCallsOnly],
    );
    return result.rows;
  }

  async cancel(tenantId: string, agentId: string, runId: string): Promise<AgentRunRecord> {
    const run = await this.database.one<AgentRunRecord>(
      `UPDATE agent_runs
       SET status = 'CANCELLED', completed_at = NOW()
       WHERE tenant_id = $1 AND agent_id = $2 AND id = $3
         AND status IN ('QUEUED', 'PLANNING', 'EXECUTING', 'GENERATING')
       RETURNING *`,
      [tenantId, agentId, runId],
    );

    if (!run) {
      throw new BadRequestException('The run does not exist or is already finished');
    }

    return run;
  }
}
