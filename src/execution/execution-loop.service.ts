import { Injectable, Logger } from '@nestjs/common';
import { generateObject, generateText, LanguageModel, stepCountIs } from 'ai';
import { z } from 'zod';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject } from '../common/json';
import { DatabaseService } from '../database/database.service';
import { McpToolRecord } from '../mcp/mcp.types';
import { PlanCacheService } from '../planner/plan-cache.service';
import { PlannerService } from '../planner/planner.service';
import { ExecutionPlanRecord } from '../planner/planner.types';
import { AgentRunRecord, TokenUsage } from './execution.types';
import { RunStepService } from './run-step.service';
import { ToolExecutorService } from './tool-executor.service';
import { compactProfileToolResults } from '../compliance/profile-review-context';
import { appendModelTrace } from '../common/model-trace';
import { parseJsonObject } from '../common/json';

interface LoopOutput {
  draft: string;
  findings: JsonObject[];
  plan: ExecutionPlanRecord;
  iterations: number;
  usage: TokenUsage;
}

const evaluationSchema = z.object({
  complete: z.boolean(),
  missingTools: z.array(z.string()).default([]),
  reason: z.string().default(''),
});

@Injectable()
export class ExecutionLoopService {
  private readonly logger = new Logger(ExecutionLoopService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly steps: RunStepService,
    private readonly executor: ToolExecutorService,
    private readonly planner: PlannerService,
    private readonly plans: PlanCacheService,
  ) {}

  async run(input: {
    model: LanguageModel;
    agent: AgentRecord;
    run: AgentRunRecord;
    plan: ExecutionPlanRecord;
    authorizedTools: McpToolRecord[];
    executionTimeoutSeconds?: number;
  }): Promise<LoopOutput> {
    let plan = input.plan;
    let draft = '';
    let iterations = 0;
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    while (iterations < input.agent.max_iterations) {
      iterations += 1;
      await this.database.query(
        'UPDATE agent_runs SET iteration_count = $2 WHERE id = $1',
        [input.run.id, iterations],
      );

      const selectedNames = new Set(plan.selected_tool_names);
      const selectedTools = input.authorizedTools.filter((toolRecord) => selectedNames.has(toolRecord.name));
      const current = await this.database.one<{ tool_call_count: number; status: string }>(
        'SELECT tool_call_count, status FROM agent_runs WHERE id = $1',
        [input.run.id],
      );

      if (!current || current.status === 'CANCELLED') {
        throw new Error('Agent run was cancelled');
      }

      const remainingCalls = input.agent.max_tool_calls - current.tool_call_count;

      if (remainingCalls <= 0) {
        break;
      }

      const tools = this.executor.buildTools({
        agent: input.agent,
        run: input.run,
        tools: selectedTools,
        iteration: iterations,
      });

      const executionSystem = [
        'You are executing a pharmaceutical traceability investigation.',
        'Respond in English.',
        'You must call at least one authorized MCP tool before writing any response.',
        'Call authorized MCP tools to obtain every fact needed for the expected output.',
        'Follow the execution plan and adapt arguments to the current query and input.',
        'Use the exact page and size values from inputParameters for list_batch_lots. Do not retry the same tool with wrapper objects such as {"$": ...} or {"value": ...}.',
        'Do not call get_drug when drugId is null, empty, or the literal string null.',
        'For lot anchoring, do not call push_lots_to_hedera when list_batch_lots returns no qualifying lot IDs.',
        'For profile compliance results, ruleCatalog is a catalogue, not a list of failures. Review only findings present in reports or agentReviewContext.',
        'For profile compliance, one profile is one review session. findingGroups are only small context groups within that same profile; never mix profiles.',
        'Use the exact findingId supplied by the finding group and never invent or discard a finding.',
        'If processed is 0, reports is empty, or agentReviewContext is empty, return NO_DATA and do not invent a profile, rule, or finding.',
        'Never invent profile IDs or rule IDs. Mark a finding CONFIRMED only when the profile value proves that specific rule failed. Do not duplicate findings.',
        'Profile compliance review is performed after tool execution. Do not invent findings or remediation values; the backend owns deterministic evidence and actions.',
        'Never invent records, reveal credentials, or use unauthorized tools.',
      ].join('\n');
      const executionPrompt = JSON.stringify({
        agentDescription: input.agent.description,
        expectedOutput: input.run.expected_output_snapshot,
        userQuery: input.run.user_query,
        inputParameters: input.run.input_parameters,
        executionPlan: plan.execution_graph,
        priorToolResults: compactProfileToolResults(await this.steps.completedToolResults(input.run.id)),
      });
      const execution = await generateText({
        model: input.model,
        system: executionSystem,
        prompt: executionPrompt,
        tools,
        toolChoice: 'required',
        stopWhen: stepCountIs(Math.min(remainingCalls + 1, 12)),
        abortSignal: AbortSignal.timeout(
          (input.executionTimeoutSeconds ?? input.agent.execution_timeout_seconds) * 1000,
        ),
      });

      const executedToolCalls = execution.steps.flatMap((step) => step.toolCalls ?? []);
      const executedToolResults = execution.steps.flatMap((step) => step.toolResults ?? []);

      await appendModelTrace(input.run.id, {
        stage: 'TOOL_EXECUTION',
        iteration: iterations,
        request: { system: executionSystem, prompt: executionPrompt },
        response: execution.text,
        executedTools: executedToolCalls.map((call) => call.toolName),
        toolResultCount: executedToolResults.length,
        usage: execution.usage,
      });

      if (process.env.DEBUG_LLM_RESPONSES === 'true') {
        this.logger.log('LLM execution response', {
          runId: input.run.id,
          iteration: iterations,
          response: execution.text,
          responseLength: execution.text.length,
          reservedToolCallCount: current.tool_call_count,
          executedToolCallCount: executedToolCalls.length,
          executedTools: executedToolCalls.map((call) => call.toolName),
          toolResultCount: executedToolResults.length,
        });
      }

      if (executedToolCalls.length === 0) {
        throw new Error(
          'The execution model returned text without executing an authorized MCP tool',
        );
      }

      draft = execution.text;
      usage.inputTokens += execution.usage.inputTokens ?? 0;
      usage.outputTokens += execution.usage.outputTokens ?? 0;
      const findings = await this.steps.completedToolResults(input.run.id);

      const evaluationStep = await this.steps.start({
        runId: input.run.id,
        iterationNumber: iterations,
        stepType: 'EVALUATION',
        inputPayload: { selectedTools: [...selectedNames], findingCount: findings.length },
      });

      try {
        const profileComplianceRun = selectedTools.some((tool) => /^run_(serial|sscc|gdti)_profile_compliance$/.test(tool.name));
        if (profileComplianceRun) {
          const latest = await this.database.one<{ tool_call_count: number }>(
            'SELECT tool_call_count FROM agent_runs WHERE id = $1',
            [input.run.id],
          );
          const outcome = this.deterministicProfileEvaluation(
            findings,
            input.agent.max_tool_calls,
            Number(latest?.tool_call_count ?? current.tool_call_count + executedToolCalls.length),
          ) as JsonObject;
          await appendModelTrace(input.run.id, {
            stage: 'EVALUATION_DETERMINISTIC',
            iteration: iterations,
            request: { selectedTools: [...selectedNames], findingCount: findings.length },
            response: outcome,
          });
          if (process.env.DEBUG_LLM_RESPONSES === 'true') {
            this.logger.log('Deterministic compliance evaluation', {
              runId: input.run.id,
              iteration: iterations,
              response: JSON.stringify(outcome),
            });
          }
          await this.steps.complete(evaluationStep, outcome);
          return { draft, findings, plan, iterations, usage };
        }
        const evaluationSystem = [
          'Evaluate whether the authenticated tool results satisfy expectedOutput.',
          'Respond in English and return only the structured evaluation object.',
          'missingTools may only contain names from authorizedTools.',
          'Return complete=true when further tools cannot improve the result.',
        ].join('\n');
        const evaluationPrompt = JSON.stringify({
          expectedOutput: input.run.expected_output_snapshot,
          userQuery: input.run.user_query,
          findings: compactProfileToolResults(findings),
          draft,
          authorizedTools: input.authorizedTools.map((record) => record.name),
        });
        let evaluationObject: z.infer<typeof evaluationSchema>;
        let evaluationUsage: { inputTokens?: number; outputTokens?: number } = {};
        try {
          const evaluation = await generateObject({
            model: input.model,
            schema: evaluationSchema as any,
            system: evaluationSystem,
            prompt: evaluationPrompt,
          });
          evaluationObject = evaluationSchema.parse(evaluation.object);
          evaluationUsage = evaluation.usage;
        } catch (error) {
          this.logger.warn('Structured evaluation returned no object; retrying as JSON text', {
            runId: input.run.id,
            provider: input.agent.llm_provider,
            error: error instanceof Error ? error.message : String(error),
          });
          const fallback = await generateText({
            model: input.model,
            system: `${evaluationSystem}\nReturn only a JSON object. Do not use markdown or commentary.`,
            prompt: evaluationPrompt,
            maxOutputTokens: 256,
            temperature: 0,
          });
          evaluationObject = evaluationSchema.parse(parseJsonObject(fallback.text));
          evaluationUsage = fallback.usage;
        }
        await appendModelTrace(input.run.id, {
          stage: 'EVALUATION',
          iteration: iterations,
          request: { system: evaluationSystem, prompt: evaluationPrompt, schema: 'evaluationSchema' },
          response: evaluationObject,
          usage: evaluationUsage,
        });

        if (process.env.DEBUG_LLM_RESPONSES === 'true') {
          this.logger.log('LLM evaluation response', {
            runId: input.run.id,
            iteration: iterations,
            response: JSON.stringify(evaluationObject),
            responseLength: JSON.stringify(evaluationObject).length,
          });
        }
        usage.inputTokens += evaluationUsage.inputTokens ?? 0;
        usage.outputTokens += evaluationUsage.outputTokens ?? 0;

        const outcome = evaluationObject as JsonObject;
        await this.steps.complete(evaluationStep, outcome, {
          inputTokens: evaluationUsage.inputTokens ?? 0,
          outputTokens: evaluationUsage.outputTokens ?? 0,
        });

        const missingTools = Array.isArray(outcome.missingTools)
          ? outcome.missingTools.filter((value): value is string => typeof value === 'string')
          : [];

        if (outcome.complete === true || !missingTools.length) {
          return { draft, findings, plan, iterations, usage };
        }

        const missingAuthorized = missingTools.filter((name) =>
          input.authorizedTools.some((record) => record.name === name),
        );

        if (!missingAuthorized.length || iterations >= input.agent.max_iterations) {
          return { draft, findings, plan, iterations, usage };
        }

        const replanStep = await this.steps.start({
          runId: input.run.id,
          iterationNumber: iterations,
          stepType: 'REPLAN',
          inputPayload: { missingTools: missingAuthorized, findings },
        });

        try {
          const revised = await this.planner.generate({
            model: input.model,
            agent: input.agent,
            traceRunId: input.run.id,
            userQuery: input.run.user_query,
            inputParameters: input.run.input_parameters,
            availableTools: input.authorizedTools,
            previousResults: findings,
          });
          usage.inputTokens += revised.inputTokens;
          usage.outputTokens += revised.outputTokens;
          plan = await this.plans.save(input.agent, input.authorizedTools, revised.plan);
          await this.database.query(
            'UPDATE agent_runs SET execution_plan_id = $2, planner_output = $3::jsonb WHERE id = $1',
            [input.run.id, plan.id, JSON.stringify(revised.plan)],
          );
          await this.steps.complete(replanStep, revised.plan, {
            inputTokens: revised.inputTokens,
            outputTokens: revised.outputTokens,
          });
        } catch (error) {
          await this.steps.fail(replanStep, error);
          throw error;
        }
      } catch (error) {
        await this.steps.fail(evaluationStep, error);
        throw error;
      }
    }

    return {
      draft,
      findings: await this.steps.completedToolResults(input.run.id),
      plan,
      iterations,
      usage,
    };
  }

  private deterministicProfileEvaluation(
    findings: JsonObject[],
    maxToolCalls: number,
    toolCallCount: number,
  ): JsonObject {
    const completed = findings.filter((finding: any) => finding.status === 'COMPLETED' || finding.output_payload);
    const contexts = completed.flatMap((finding: any) => {
      const output = finding.output_payload;
      return output && typeof output === 'object' && Array.isArray(output.agentReviewContext)
        ? output.agentReviewContext
        : [];
    });
    const reports = completed.flatMap((finding: any) => {
      const output = finding.output_payload;
      return output && typeof output === 'object' && Array.isArray(output.reports) ? output.reports : [];
    });
    const complete = completed.length > 0 && (contexts.length > 0 || reports.length > 0);
    return {
      complete,
      missingTools: [],
      reason: complete
        ? 'The compliance tool completed and returned deterministic report context for every processed profile.'
        : 'The compliance tool did not return a completed report context.',
      processed: contexts.length || reports.length,
      toolCallsUsed: toolCallCount,
      toolCallLimit: maxToolCalls,
    };
  }
}
