import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { generateObject, LanguageModel } from 'ai';
import { z } from 'zod';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject } from '../common/json';
import { McpToolRecord } from '../mcp/mcp.types';
import { PlannerOutput } from './planner.types';
import { appendModelTrace } from '../common/model-trace';

const planSchema = z.object({
  objective: z.string().min(1),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        tool: z.string().optional(),
        operation: z.string().optional(),
        arguments: z.record(z.unknown()).optional(),
        repeatFor: z.string().optional(),
        condition: z.string().optional(),
      }),
    )
    .min(1),
  completionCriteria: z.array(z.string()).default([]),
});

export interface GeneratedPlan {
  plan: PlannerOutput;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  async generate(input: {
    model: LanguageModel;
    agent: AgentRecord;
    traceRunId?: string;
    userQuery: string | null;
    inputParameters: JsonObject;
    availableTools: McpToolRecord[];
    previousResults?: unknown;
  }): Promise<GeneratedPlan> {
    // Compliance profile runs have one authorized orchestration tool. The
    // backend already owns its schema and input values, so do not ask an LLM
    // to invent a plan or rewrite arguments for this path.
    if (input.availableTools.length === 1 && /^run_(serial|sscc|gdti)_profile_compliance$/.test(input.availableTools[0].name)) {
      const tool = input.availableTools[0];
      const allowed = new Set(Object.keys((tool.input_schema as any)?.properties ?? {}));
      const argumentsValue = Object.fromEntries(
        Object.entries(input.inputParameters).filter(([key]) => allowed.size === 0 || allowed.has(key)),
      );
      const plan: PlannerOutput = {
        objective: input.userQuery || `Run ${tool.name}`,
        steps: [{ id: 'step-1', tool: tool.name, operation: tool.name, arguments: argumentsValue }],
        completionCriteria: ['The authorized compliance tool completed and returned a deterministic report context.'],
      } as PlannerOutput;
      await appendModelTrace(input.traceRunId ?? input.agent.id, {
        stage: 'PLANNER_DETERMINISTIC',
        request: { inputParameters: input.inputParameters, tool: tool.name },
        response: plan,
      });
      return { plan, inputTokens: 0, outputTokens: 0 };
    }
    const system = [
      'You are a backend execution planner for pharmaceutical traceability.',
      'Use English for all objective, operation, condition, and completion text.',
      'Return only a JSON object matching this exact shape:',
      '{"objective":"...","steps":[{"id":"step-1","tool":"list_batch_lots","operation":"getAllBatchLot","arguments":{"page":1,"size":20}}],"completionCriteria":[]}',
      'Each step must use an actual tool name from availableTools. Never output placeholders or invented bulk operations.',
      'For lot anchoring, call list_batch_lots first, select only lots not confirmed on Hedera, then call push_lots_to_hedera with the selected lotIds. Never call the write tool before the list result. If no lots qualify, do not call the write tool.',
      'When related data is needed, include multiple steps using the actual authorized tools. Repeat calls for returned IDs during execution; do not invent tools such as getAllLotItemsGivenLotIds.',
      'Respect maxToolCalls and maxIterations from executionLimits. If maxToolCalls is 1, return only one tool step.',
      'Select only authorized tool names from availableTools.',
      'Use {{input.field}} and {{previous_step.results}} parameter templates where useful.',
      'Never wrap arguments as {"$": ...} or {"value": ...}; use literal values for current input parameters and {{...}} only for unresolved previous-step values.',
      'Do not include optional arguments with null values unless the tool schema explicitly permits null.',
      'Include tool arguments that exactly match the JSON schemas.',
      'Never invent a tool, expose credentials, or cross tenant boundaries.',
    ].join('\n');
    const prompt = JSON.stringify({
      agentName: input.agent.name,
      description: input.agent.description,
      expectedOutput: input.agent.expected_output,
      userQuery: input.userQuery,
      inputParameters: input.inputParameters,
      executionLimits: {
        maxIterations: input.agent.max_iterations,
        maxToolCalls: input.agent.max_tool_calls,
      },
      previousResults: input.previousResults ?? null,
      availableTools: input.availableTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        capabilities: tool.capabilities,
        relatedTools: tool.related_tool_names,
      })),
    });
    const result = await generateObject({
      model: input.model,
      // Avoid deep generic expansion in the AI SDK for this recursive-looking Zod shape.
      schema: planSchema as any,
      system,
      prompt,
    });
    await appendModelTrace(input.traceRunId ?? input.agent.id, {
      stage: 'PLANNER',
      request: { system, prompt, schema: 'plannerSchema' },
      response: result.object,
      usage: result.usage,
    });

    if (process.env.DEBUG_LLM_RESPONSES === 'true') {
      this.logger.log('LLM planner response', {
        modelResponse: JSON.stringify(result.object),
        responseLength: JSON.stringify(result.object).length,
      });
    }

    let parsed: z.infer<typeof planSchema>;
    const authorizedNames = new Set(input.availableTools.map((tool) => tool.name));

    try {
      parsed = planSchema.parse(
        this.normalizePlannerShape(result.object as JsonObject, authorizedNames, input.inputParameters),
      );
    } catch {
      if (process.env.DEBUG_LLM_RESPONSES === 'true') {
        this.logger.error('Invalid LLM planner response', {
          modelResponse: JSON.stringify(result.object),
          responseLength: JSON.stringify(result.object).length,
        });
      }
      throw new BadGatewayException('The LLM planner did not return a valid JSON execution plan');
    }

    for (const step of parsed.steps) {
      if (step.tool && !authorizedNames.has(step.tool)) {
        throw new BadGatewayException(`The planner selected unauthorized MCP tool ${step.tool}`);
      }
    }

    if (process.env.DEBUG_LLM_RESPONSES === 'true') {
      this.logger.log('Normalized execution plan', {
        inputParameters: input.inputParameters,
        plan: parsed,
      });
    }

    if (!parsed.steps.some((step) => step.tool)) {
      throw new BadGatewayException('The execution plan must include at least one authorized MCP tool');
    }

    return {
      plan: parsed as PlannerOutput,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    };
  }

  private normalizePlannerShape(
    raw: JsonObject,
    authorizedNames: Set<string>,
    inputParameters: JsonObject,
  ): JsonObject {
    if (!Array.isArray(raw.steps)) {
      return raw;
    }

    return {
      ...raw,
      steps: raw.steps.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return value;
        }

        const step = value as JsonObject;
        const toolCall = typeof step.toolCall === 'string' ? step.toolCall : '';
        const matchingTools = [...authorizedNames].filter((name) => toolCall.includes(name));
        const declaredTool = typeof step.tool === 'string' && authorizedNames.has(step.tool)
          ? step.tool
          : undefined;
        const tool = declaredTool ?? matchingTools[matchingTools.length - 1];

        return {
          ...step,
          id: typeof step.id === 'string' && step.id.trim() ? step.id : `step-${index + 1}`,
          ...(tool ? { tool } : {}),
          ...(typeof step.arguments === 'object' && step.arguments !== null
            ? { arguments: this.normalizeArguments(step.arguments as JsonObject, inputParameters) }
            : {}),
        };
      }),
    };
  }

  /**
   * Some local models wrap primitive planner arguments as { value: 1 }.
   * Tool schemas require the primitive itself, so unwrap only that exact
   * wrapper and preserve all other template/object arguments unchanged.
   */
  private normalizeArguments(argumentsValue: JsonObject, inputParameters: JsonObject): JsonObject {
    const normalized: JsonObject = {};

    for (const [name, value] of Object.entries(argumentsValue)) {
      const resolved = value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value as object).length === 0 && name in inputParameters
        ? inputParameters[name]
        : this.normalizeArgumentValue(value, inputParameters);
      if (resolved !== undefined) {
        normalized[name] = resolved;
      }
    }

    return normalized;
  }

  private normalizeArgumentValue(value: unknown, inputParameters: JsonObject): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const object = value as JsonObject;
    const keys = Object.keys(object);

    if (keys.length === 1 && 'value' in object) {
      return object.value;
    }

    if (keys.length === 1 && '$' in object && typeof object.$ === 'string') {
      if (object.$ === 'null') {
        return undefined;
      }

      const prefix = 'inputParameters.';
      if (object.$.startsWith(prefix)) {
        return this.readPath(inputParameters, object.$.slice(prefix.length));
      }

      return `{{${object.$}}}`;
    }

    return Object.fromEntries(
      Object.entries(object)
        .map(([key, item]) => [key, this.normalizeArgumentValue(item, inputParameters)])
        .filter(([, item]) => item !== undefined),
    );
  }

  private readPath(value: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
  }
}
