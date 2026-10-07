import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditDatabaseService } from '../database/audit-database.service';

type ComplianceAuditInput = {
  tenantId: string;
  actorId: string;
  actionType: string;
  resourceType: string;
  resourceId?: string;
  status?: 'STARTED' | 'COMPLETED' | 'FAILED' | 'APPROVED' | 'REJECTED';
  description: string;
  privateData?: Record<string, unknown>;
};

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

@Injectable()
export class ComplianceAuditService {
  private readonly logger = new Logger(ComplianceAuditService.name);

  constructor(private readonly database: AuditDatabaseService) {}

  async record(input: ComplianceAuditInput): Promise<void> {
    const occurredAt = new Date().toISOString();
    try {
      const previous = await this.database.one<{ event_hash: string }>(
        `SELECT event_hash FROM audit_logs
         WHERE tenant_id = $1
         ORDER BY occurred_at DESC, recorded_at DESC, id DESC LIMIT 1`,
        [input.tenantId],
      );
      const previousEventHash = previous?.event_hash ?? null;
      const eventHash = createHash('sha256').update(stable({
        ...input,
        actorType: 'HUMAN',
        previousEventHash,
        occurredAt,
      })).digest('hex');

      await this.database.query(
        `INSERT INTO audit_logs
          (tenant_id, workflow_id, actor_type, actor_id, action_type,
           resource_type, resource_id, status, description, private_data,
           previous_event_hash, event_hash, occurred_at)
         VALUES ($1, NULL, 'HUMAN', $2, $3, $4, $5, $6, $7, $8::jsonb,
                 $9, $10, $11)`,
        [
          input.tenantId,
          input.actorId,
          input.actionType,
          input.resourceType,
          input.resourceId ?? null,
          input.status ?? 'COMPLETED',
          input.description,
          JSON.stringify(input.privateData ?? {}),
          previousEventHash,
          eventHash,
          occurredAt,
        ],
      );
    } catch (error) {
      // Audit persistence must not turn a successful user operation into a
      // failed compliance request. The application log retains the failure.
      this.logger.error('Compliance audit event could not be persisted', {
        actionType: input.actionType,
        resourceId: input.resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
