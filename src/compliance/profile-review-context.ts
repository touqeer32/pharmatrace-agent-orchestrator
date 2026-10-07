import { JsonObject } from '../common/json';

/**
 * Keeps profile-compliance prompts bounded. The database retains the complete
 * deterministic report; the model receives one profile and its grouped
 * findings, not the full report, source snapshot, and rule catalog repeatedly.
 */
export function compactProfileToolResults(results: JsonObject[]): JsonObject[] {
  return results.map((result) => {
    const output = result.output_payload;
    if (!output || typeof output !== 'object' || Array.isArray(output)) return result;
    const payload = output as Record<string, unknown>;
    if (!Array.isArray(payload.agentReviewContext)) return result;

    return {
      ...result,
      output_payload: {
        agentType: payload.agentType,
        recordType: payload.recordType,
        ruleSetVersion: payload.ruleSetVersion,
        processingStatus: payload.processingStatus,
        processed: payload.processed,
        sourceRecords: payload.sourceRecords,
        skipped: payload.skipped,
        pass: payload.pass,
        fail: payload.fail,
        review: payload.review,
        agentReviewInstructions: payload.agentReviewInstructions,
        agentReviewContext: payload.agentReviewContext,
      },
    };
  });
}
