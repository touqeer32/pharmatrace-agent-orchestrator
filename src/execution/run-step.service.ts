import { Injectable } from '@nestjs/common';
import { asJson, JsonObject } from '../common/json';
import { redact, safeErrorMessage } from '../common/redact';
import { DatabaseService } from '../database/database.service';

type StepType = 'PLAN' | 'TOOL_CALL' | 'EVALUATION' | 'REPLAN' | 'FINAL_RESPONSE';

export interface RunStepInput {
  runId: string;
  iterationNumber?: number;
  stepType: StepType;
  mcpServerId?: string;
  mcpToolId?: string;
  toolName?: string;
  inputPayload?: unknown;
  reasoningSummary?: string;
}

@Injectable()
export class RunStepService {
  constructor(private readonly database: DatabaseService) {}

  async start(input: RunStepInput): Promise<string> {
    return this.database.transaction(async (client) => {
      // Serialize step-number assignment even when a model invokes tools concurrently.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.runId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO agent_run_steps
         (run_id, step_number, iteration_number, step_type, status,
          mcp_server_id, mcp_tool_id, tool_name, input_payload, reasoning_summary)
         VALUES (
           $1,
           COALESCE((SELECT MAX(step_number) + 1 FROM agent_run_steps WHERE run_id = $1), 1),
           $2, $3, 'STARTED', $4, $5, $6, $7::jsonb, $8
         )
         RETURNING id`,
        [
          input.runId,
          input.iterationNumber ?? 1,
          input.stepType,
          input.mcpServerId ?? null,
          input.mcpToolId ?? null,
          input.toolName ?? null,
          input.inputPayload === undefined ? null : asJson(redact(input.inputPayload)),
          input.reasoningSummary ?? null,
        ],
      );
      return result.rows[0].id;
    });
  }

  async complete(
    stepId: string,
    output: unknown,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    await this.database.query(
      `UPDATE agent_run_steps
       SET status = 'COMPLETED',
           output_payload = $2::jsonb,
           input_tokens = $3,
           output_tokens = $4,
           completed_at = NOW(),
           duration_ms = ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::integer
       WHERE id = $1`,
      [
        stepId,
        output === undefined ? null : asJson(redact(output)),
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
      ],
    );
  }

  async fail(stepId: string, error: unknown): Promise<void> {
    await this.database.query(
      `UPDATE agent_run_steps
       SET status = 'FAILED', error_message = $2, completed_at = NOW(),
           duration_ms = ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::integer
       WHERE id = $1`,
      [stepId, safeErrorMessage(error)],
    );
  }

  async completedToolResults(runId: string): Promise<JsonObject[]> {
    const result = await this.database.query<JsonObject>(
      `SELECT tool_name, input_payload, output_payload, iteration_number
       FROM agent_run_steps
       WHERE run_id = $1 AND step_type = 'TOOL_CALL' AND status = 'COMPLETED'
       ORDER BY step_number`,
      [runId],
    );
    return result.rows;
  }

  async unrecoveredToolFailures(runId: string): Promise<JsonObject[]> {
    const result = await this.database.query<JsonObject>(
      `SELECT failed.tool_name, failed.error_message, failed.step_number
       FROM agent_run_steps failed
       WHERE failed.run_id = $1
         AND failed.step_type = 'TOOL_CALL'
         AND failed.status = 'FAILED'
         AND NOT EXISTS (
           SELECT 1
           FROM agent_run_steps succeeded
           WHERE succeeded.run_id = failed.run_id
             AND succeeded.step_type = 'TOOL_CALL'
             AND succeeded.status = 'COMPLETED'
             AND succeeded.tool_name = failed.tool_name
             AND succeeded.step_number > failed.step_number
         )
       ORDER BY failed.step_number`,
      [runId],
    );
    return result.rows;
  }
}
