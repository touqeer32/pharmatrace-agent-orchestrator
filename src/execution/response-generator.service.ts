import { Injectable, Logger } from '@nestjs/common';
import { generateText, LanguageModel } from 'ai';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject, parseJsonObject } from '../common/json';
import { AgentRunRecord, TokenUsage } from './execution.types';

export interface GeneratedResponse {
  text: string;
  json: JsonObject | null;
  usage: TokenUsage;
}

@Injectable()
export class ResponseGeneratorService {
  private readonly logger = new Logger(ResponseGeneratorService.name);

  async generate(input: {
    model: LanguageModel;
    agent: AgentRecord;
    run: AgentRunRecord;
    findings: JsonObject[];
    draft: string;
    completedToolNames?: string[];
  }): Promise<GeneratedResponse> {
    const result = await generateText({
      model: input.model,
      system: [
        'You are generating the final response for a pharmaceutical traceability agent.',
        'Write the final response in English only.',
        'Use only facts present in the authenticated MCP tool results.',
        'Explicitly identify missing information instead of inventing it.',
        'For lot anchoring, report lots as pushed only when push_lots_to_hedera appears in completedToolNames and its completed result confirms the push.',
        'If push_lots_to_hedera is absent from completedToolNames, explicitly say that no Hedera anchoring write was completed. Never infer success from list_batch_lots, txID, or a draft.',
        'Never include access tokens, API keys, passwords, or client secrets.',
        input.agent.output_schema
          ? 'Return only valid JSON matching the requested output schema.'
          : 'Produce the output format requested in expectedOutput.',
      ].join('\n'),
      prompt: JSON.stringify({
        agentName: input.agent.name,
        description: input.agent.description,
        expectedOutput: input.run.expected_output_snapshot,
        userQuery: input.run.user_query,
        outputSchema: input.agent.output_schema,
        draft: input.draft,
        authenticatedToolResults: input.findings,
        completedToolNames: input.completedToolNames ?? input.findings.map((finding) => finding.tool_name),
      }),
    });

    if (process.env.DEBUG_LLM_RESPONSES === 'true') {
      this.logger.log('LLM final response', {
        runId: input.run.id,
        response: result.text,
        responseLength: result.text.length,
      });
    }

    let json: JsonObject | null = null;

    try {
      json = parseJsonObject(result.text);
    } catch {
      if (input.agent.output_schema) {
        throw new Error('The final response did not contain valid JSON for the configured output schema');
      }
    }

    return {
      text: result.text,
      json,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    };
  }
}
