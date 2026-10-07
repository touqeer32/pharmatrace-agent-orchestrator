import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditDatabaseService } from '../database/audit-database.service';

type AgentAuditEvent = {
  tenantId: string;
  workflowId: string;
  actorId: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
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
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);

  constructor(private readonly database: AuditDatabaseService) {}

  async record(event: AgentAuditEvent): Promise<void> {
    const occurredAt = new Date().toISOString();
    try {
      const previous = await this.database.one<{ event_hash: string }>(
        `SELECT event_hash FROM audit_logs
         WHERE tenant_id = $1
         ORDER BY occurred_at DESC, recorded_at DESC, id DESC
         LIMIT 1`,
        [event.tenantId],
      );
      const previousEventHash = previous?.event_hash ?? null;
      const eventHash = createHash('sha256').update(stable({
        ...event,
        previousEventHash,
        occurredAt,
      })).digest('hex');

      await this.database.query(
        `INSERT INTO audit_logs
          (tenant_id, workflow_id, actor_type, actor_id, action_type,
           resource_type, resource_id, status, description, private_data,
           previous_event_hash, event_hash, occurred_at)
         VALUES ($1, $2, 'AGENT', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
        [
          event.tenantId,
          event.workflowId,
          event.actorId,
          event.actionType,
          event.resourceType,
          event.resourceId,
          event.status,
          event.description,
          JSON.stringify(event.privateData ?? {}),
          previousEventHash,
          eventHash,
          occurredAt,
        ],
      );
    } catch (error) {
      // Audit failure must not make the business agent fail. It remains visible
      // in application logs and can be recovered by the audit service later.
      this.logger.error('Agent audit event could not be persisted', {
        tenantId: event.tenantId,
        workflowId: event.workflowId,
        actionType: event.actionType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
