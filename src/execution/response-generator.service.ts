import { Injectable, Logger } from '@nestjs/common';
import { generateObject, generateText, jsonSchema, LanguageModel } from 'ai';
import { AgentRecord } from '../agents/agent.types';
import { JsonObject, parseJsonObject } from '../common/json';
import { AgentRunRecord, TokenUsage } from './execution.types';
import { compactProfileToolResults } from '../compliance/profile-review-context';
import { appendModelTrace } from '../common/model-trace';

export interface GeneratedResponse {
  text: string;
  json: JsonObject | null;
  usage: TokenUsage;
}

@Injectable()
export class ResponseGeneratorService {
  private readonly logger = new Logger(ResponseGeneratorService.name);

  async reviewProfileGroups(input: {
    model: LanguageModel;
    agent: AgentRecord;
    run: AgentRunRecord;
    findings: JsonObject[];
    toolCallsUsed?: number;
  }): Promise<GeneratedResponse | null> {
    const results = compactProfileToolResults(input.findings);
    const contexts = results.flatMap((result) => {
      const output = result.output_payload;
      if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
      const context = (output as Record<string, unknown>).agentReviewContext;
      return Array.isArray(context) ? context : [];
    }) as Array<Record<string, any>>;
    if (!contexts.length) return null;

    const profileResults: Array<Record<string, unknown>> = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const groupSchema = jsonSchema<JsonObject>({
      type: 'object',
      required: ['profileId', 'findings'],
      properties: {
        profileId: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['findingId', 'assessment', 'comment'],
            properties: {
              findingId: { type: 'string' },
              assessment: { type: 'string', enum: ['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT'] },
              comment: { type: 'string' },
              instruction: { type: 'string' },
            },
          },
        },
      },
    });

    for (const context of contexts) {
      const merged: JsonObject[] = [];
      const groups = Array.isArray(context.findingGroups) ? context.findingGroups : [];
      for (const group of groups) {
        const groupSystem = [
          'You are reviewing one pharmaceutical profile compliance report.',
          'This is one group within the same profile review session.',
          'Assess every supplied finding and return the exact findingId.',
          'Do not add, remove, merge, or rename findings.',
          'Use only the supplied profile, rule, and deterministic validation evidence.',
          'For a finding with deterministicAssessment CONFIRMED, assessment MUST be CONFIRMED. Never dispute a deterministic validation.',
          'For CONTEXTUAL_REVIEW, use CONFIRMED only when the supplied evidence proves the issue, DISPUTED when it is not true, or NEEDS_CONTEXT when more business context is required.',
          'Return only findingId, assessment, comment, and optional instruction. The backend owns ruleId, field, values, severity, action, and target.',
          'Do not invent a replacement value, identifier, prefix, document number, range value, or master-data value.',
          'Make the comment meaningful: explain the evidence and, where applicable, the exact change or action needed.',
          'Respond in English and return only JSON matching the schema.',
        ].join('\n');
        const modelRequest = {
          stage: 'PROFILE_FINDING_GROUP_REVIEW',
          profileId: context.profileId,
          reportId: context.reportId,
          group,
          // The group carries only the profile fields relevant to its
          // findings. Sending the full profile here caused unrelated fields
          // to leak into name, range, and generation assessments.
          profile: (group as Record<string, any>).relevantProfile ?? {},
          generation: context.generation ?? null,
        };
        const traceRequest = {
          stage: 'PROFILE_FINDING_GROUP_REVIEW',
          system: groupSystem,
          prompt: JSON.stringify(modelRequest),
          schema: groupSchema,
        };
        try {
          const structured = await generateObject({
            model: input.model,
            schema: groupSchema,
            system: groupSystem,
            prompt: JSON.stringify(modelRequest),
          });
          inputTokens += structured.usage.inputTokens ?? 0;
          outputTokens += structured.usage.outputTokens ?? 0;
          let groupResult = structured.object as JsonObject;
          const suppliedFindings = Array.isArray((group as any).findings) ? (group as any).findings : [];
          const returnedFindings = Array.isArray(groupResult.findings) ? groupResult.findings as any[] : [];
          const suppliedById = new Map(suppliedFindings.map((finding: any) => [finding.findingId, finding]));
          const responseScore = (candidate: JsonObject): number => {
            const candidateFindings = Array.isArray(candidate.findings) ? candidate.findings as any[] : [];
            let score = candidateFindings.length === suppliedFindings.length ? 2 : 0;
            for (const finding of candidateFindings) {
              const supplied = suppliedById.get(finding.findingId) as any;
              if (!supplied) continue;
              score += 1;
              if (typeof finding.comment === 'string' && finding.comment.trim()) score += 1;
              if (supplied.deterministicAssessment === 'CONFIRMED' && finding.assessment === 'CONFIRMED') score += 2;
              if (finding.assessment !== 'NEEDS_CONTEXT' || !finding.instruction) score += 1;
            }
            return score;
          };
          const needsRepair = returnedFindings.length !== suppliedFindings.length || returnedFindings.some((finding: any) => {
            const supplied = suppliedById.get(finding.findingId) as any;
            if (!supplied) return true;
            if (supplied.deterministicAssessment === 'CONFIRMED' && finding.assessment !== 'CONFIRMED') return true;
            if (!Array.isArray(supplied.allowedAssessments) || !supplied.allowedAssessments.includes(finding.assessment)) return true;
            if (!['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT'].includes(finding.assessment)) return true;
            return false;
          }) || new Set(returnedFindings.map((finding: any) => finding.findingId)).size !== returnedFindings.length;
          if (needsRepair) {
            const repairPrompt = `${JSON.stringify(modelRequest)}\n\nThe previous response violated the judgment contract. Return every supplied finding exactly once using only findingId, assessment, comment, and optional instruction. For every deterministicAssessment=CONFIRMED finding return CONFIRMED. Use NEEDS_CONTEXT only for contextual uncertainty. Do not invent values, rule IDs, actions, or targets.`;
            await appendModelTrace(input.run.id, {
              stage: 'PROFILE_FINDING_GROUP_REPAIR_REQUEST',
              request: { system: groupSystem, prompt: repairPrompt, schema: groupSchema },
              response: groupResult,
            });
            const repaired = await generateObject({
              model: input.model,
              schema: groupSchema,
              system: groupSystem,
              prompt: repairPrompt,
            });
            inputTokens += repaired.usage.inputTokens ?? 0;
            outputTokens += repaired.usage.outputTokens ?? 0;
            const repairedResult = repaired.object as JsonObject;
            // Repair only the invalid judgment. Preserve useful comments and
            // instructions from the first response when the repair omits or
            // weakens them.
            if (responseScore(repairedResult) >= responseScore(groupResult)) {
              const originalById = new Map(returnedFindings.map((finding: any) => [finding.findingId, finding]));
              const repairedFindings = Array.isArray(repairedResult.findings) ? repairedResult.findings as any[] : [];
              groupResult = {
                ...repairedResult,
                findings: repairedFindings.map((finding: any) => {
                  const original = originalById.get(finding.findingId) as any;
                  return {
                    ...finding,
                    comment: typeof finding.comment === 'string' && finding.comment.trim()
                      ? finding.comment
                      : original?.comment,
                    instruction: typeof finding.instruction === 'string' && finding.instruction.trim()
                      ? finding.instruction
                      : original?.instruction,
                  };
                }),
              };
            }
            await appendModelTrace(input.run.id, {
              stage: 'PROFILE_FINDING_GROUP_REPAIR_RESPONSE',
              request: { system: groupSystem, prompt: repairPrompt, schema: groupSchema },
              response: groupResult,
              usage: repaired.usage,
            });
          }
          await appendModelTrace(input.run.id, {
            request: traceRequest,
            response: groupResult,
            usage: structured.usage,
          });
          if (Array.isArray(groupResult.findings)) merged.push(...groupResult.findings as JsonObject[]);
        } catch (error) {
          await appendModelTrace(input.run.id, {
            request: traceRequest,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      profileResults.push({
        profileId: context.profileId,
        resultStatus: context.resultStatus ?? 'REVIEW',
        findings: merged,
      });
    }

    const responseJson: JsonObject = {
      processingStatus: 'COMPLETED',
      summary: 'Profile findings were reviewed against their supplied evidence. The backend remains authoritative for evidence and remediation.',
      toolCallsUsed: input.toolCallsUsed ?? results.length,
      profiles: profileResults,
    };
    return {
      text: JSON.stringify(responseJson),
      json: responseJson,
      usage: { inputTokens, outputTokens },
    };
  }

  async generate(input: {
    model: LanguageModel;
    agent: AgentRecord;
    run: AgentRunRecord;
    findings: JsonObject[];
    draft: string;
    completedToolNames?: string[];
  }): Promise<GeneratedResponse> {
    const system = [
        'You are generating the final response for a pharmaceutical traceability agent.',
        'Write the final response in English only.',
        'Use only facts present in the authenticated MCP tool results.',
        'Explicitly identify missing information instead of inventing it.',
        'Do not describe internal tool execution, curl commands, retries, prompts, or implementation changes as business results.',
        'Never claim that a curl request, API update, or database update was performed unless that operation is an authorized completed tool result.',
        'For lot anchoring, report lots as pushed only when push_lots_to_hedera appears in completedToolNames and its completed result confirms the push.',
        'If push_lots_to_hedera is absent from completedToolNames, explicitly say that no Hedera anchoring write was completed. Never infer success from list_batch_lots, txID, or a draft.',
        'For profile compliance results, ruleCatalog is a catalogue, not a list of failures. Review only findings present in reports or agentReviewContext.',
        'For profile compliance, review one profile as one session. Process every findingGroup; finding groups are only context-size boundaries, not separate profiles.',
        'Return the exact findingId supplied by each group. Do not create, remove, merge, or rename findings.',
        'A finding omitted from a group is not evidence that it passed; the backend preserves it as NOT_REVIEWED.',
        'If processed is 0, reports is empty, or agentReviewContext is empty, return NO_DATA and do not invent a profile, rule, or finding.',
        'Never invent profile IDs or rule IDs. Mark CONFIRMED only when the profile value proves that specific finding. Do not duplicate findings.',
        'For profile compliance, the backend owns finding evidence and remediation metadata; do not invent or rewrite those fields.',
        'Never include access tokens, API keys, passwords, or client secrets.',
        input.agent.output_schema
          ? 'Return only valid JSON matching the requested output schema.'
          : 'Produce the output format requested in expectedOutput.',
      ].join('\n');
    const prompt = JSON.stringify({
        agentName: input.agent.name,
        description: input.agent.description,
        expectedOutput: input.run.expected_output_snapshot,
        userQuery: input.run.user_query,
        outputSchema: input.agent.output_schema,
        draft: input.draft,
        authenticatedToolResults: compactProfileToolResults(input.findings),
        completedToolNames: input.completedToolNames ?? input.findings.map((finding) => finding.tool_name),
      });

    let text: string;
    let responseJson: JsonObject | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    if (input.agent.output_schema) {
      const structured = await generateObject({
        model: input.model,
        schema: jsonSchema<JsonObject>(input.agent.output_schema),
        system,
        prompt,
      });
      responseJson = structured.object as JsonObject;
      text = JSON.stringify(responseJson);
      inputTokens = structured.usage.inputTokens ?? 0;
      outputTokens = structured.usage.outputTokens ?? 0;
      await appendModelTrace(input.run.id, {
        stage: 'FINAL_RESPONSE',
        request: { system, prompt, schema: input.agent.output_schema },
        response: responseJson,
        usage: structured.usage,
      });
    } else {
      try {
        const result = await generateText({ model: input.model, system, prompt });
        text = result.text;
        inputTokens = result.usage.inputTokens ?? 0;
        outputTokens = result.usage.outputTokens ?? 0;
        await appendModelTrace(input.run.id, {
          stage: 'FINAL_RESPONSE',
          request: { system, prompt },
          response: text,
          usage: result.usage,
        });
      } catch (error) {
        await appendModelTrace(input.run.id, {
          stage: 'FINAL_RESPONSE',
          request: { system, prompt },
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (process.env.DEBUG_LLM_RESPONSES === 'true') {
      this.logger.log('LLM final response', {
        runId: input.run.id,
        response: text,
        responseLength: text.length,
      });
    }

    let json: JsonObject | null = responseJson;

    if (!json) {
      try {
        json = parseJsonObject(text);
      } catch {
      if (input.agent.output_schema) {
        throw new Error('The final response did not contain valid JSON for the configured output schema');
      }
      }
    }

    return {
      text,
      json,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }
}
