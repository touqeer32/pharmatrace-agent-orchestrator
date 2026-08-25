import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { generateObject, LanguageModel } from 'ai';
import { z } from 'zod';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject } from '../common/json';
import { McpToolRecord } from '../mcp/mcp.types';
import { PlannerOutput } from './planner.types';

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
    userQuery: string | null;
    inputParameters: JsonObject;
    availableTools: McpToolRecord[];
    previousResults?: unknown;
  }): Promise<GeneratedPlan> {
    const result = await generateObject({
      model: input.model,
      // Avoid deep generic expansion in the AI SDK for this recursive-looking Zod shape.
      schema: planSchema as any,
      system: [
        'You are a backend execution planner for pharmaceutical traceability.',
        'Use English for all objective, operation, condition, and completion text.',
        'Return only a JSON object matching this exact shape:',
        '{"objective":"...","steps":[{"id":"step-1","tool":"list_batch_lots","operation":"getAllBatchLot","arguments":{"page":1,"size":20}}],"completionCriteria":[]}',
        'Each step must use an actual tool name from availableTools. Never output placeholders or invented bulk operations.',
        'When related data is needed, include multiple steps using the actual authorized tools. Repeat calls for returned IDs during execution; do not invent tools such as getAllLotItemsGivenLotIds.',
        'Respect maxToolCalls and maxIterations from executionLimits. If maxToolCalls is 1, return only one tool step.',
        'Select only authorized tool names from availableTools.',
        'Use {{input.field}} and {{previous_step.results}} parameter templates where useful.',
        'Include tool arguments that exactly match the JSON schemas.',
        'Never invent a tool, expose credentials, or cross tenant boundaries.',
      ].join('\n'),
      prompt: JSON.stringify({
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
      }),
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
        this.normalizePlannerShape(result.object as JsonObject, authorizedNames),
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

    if (!parsed.steps.some((step) => step.tool)) {
      throw new BadGatewayException('The execution plan must include at least one authorized MCP tool');
    }

    return {
      plan: parsed as PlannerOutput,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    };
  }

  private normalizePlannerShape(raw: JsonObject, authorizedNames: Set<string>): JsonObject {
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
            ? { arguments: step.arguments }
            : {}),
        };
      }),
    };
  }
}
