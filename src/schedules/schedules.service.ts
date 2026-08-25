import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { asJson, JsonObject } from '../common/json';
import { DatabaseService } from '../database/database.service';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { nextRunAt, ScheduleShape } from './schedule-calculator';

interface ScheduleRecord extends ScheduleShape {
  id: string;
  agent_id: string;
  enabled: boolean;
  input_override: JsonObject;
  next_run_at: Date | null;
}

@Injectable()
export class SchedulesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly agents: AgentsService,
  ) {}

  async create(
    tenantId: string,
    agentId: string,
    dto: CreateScheduleDto,
  ): Promise<ScheduleRecord> {
    const agent = await this.agents.get(tenantId, agentId);

    if (agent.trigger_mode === 'MANUAL') {
      throw new BadRequestException('Set the agent triggerMode to SCHEDULED or BOTH before adding a schedule');
    }

    const shape: ScheduleShape = {
      schedule_type: dto.scheduleType,
      timezone: dto.timezone ?? 'UTC',
      time_of_day: dto.timeOfDay ?? null,
      day_of_week: dto.dayOfWeek ?? null,
      day_of_month: dto.dayOfMonth ?? null,
      scheduled_for: dto.scheduledFor ?? null,
    };

    return (await this.database.one<ScheduleRecord>(
      `INSERT INTO agent_schedules
       (agent_id, schedule_type, timezone, time_of_day, day_of_week,
        day_of_month, scheduled_for, next_run_at, enabled, input_override)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [
        agentId,
        shape.schedule_type,
        shape.timezone,
        shape.time_of_day,
        shape.day_of_week,
        shape.day_of_month,
        shape.scheduled_for,
        nextRunAt(shape),
        dto.enabled ?? true,
        asJson(dto.inputOverride ?? {}),
      ],
    )) as ScheduleRecord;
  }

  async list(tenantId: string, agentId: string): Promise<ScheduleRecord[]> {
    await this.agents.get(tenantId, agentId);
    const result = await this.database.query<ScheduleRecord>(
      'SELECT * FROM agent_schedules WHERE agent_id = $1 ORDER BY created_at DESC',
      [agentId],
    );
    return result.rows;
  }

  async update(
    tenantId: string,
    agentId: string,
    scheduleId: string,
    dto: UpdateScheduleDto,
  ): Promise<ScheduleRecord> {
    await this.agents.get(tenantId, agentId);
    const existing = await this.database.one<ScheduleRecord>(
      'SELECT * FROM agent_schedules WHERE agent_id = $1 AND id = $2',
      [agentId, scheduleId],
    );

    if (!existing) {
      throw new NotFoundException('Agent schedule was not found');
    }

    const shape: ScheduleShape = {
      schedule_type: dto.scheduleType ?? existing.schedule_type,
      timezone: dto.timezone ?? existing.timezone,
      time_of_day: dto.timeOfDay ?? existing.time_of_day,
      day_of_week: dto.dayOfWeek ?? existing.day_of_week,
      day_of_month: dto.dayOfMonth ?? existing.day_of_month,
      scheduled_for: dto.scheduledFor ?? existing.scheduled_for,
    };

    return (await this.database.one<ScheduleRecord>(
      `UPDATE agent_schedules
       SET schedule_type = $3, timezone = $4, time_of_day = $5,
           day_of_week = $6, day_of_month = $7, scheduled_for = $8,
           next_run_at = $9, enabled = $10, input_override = $11::jsonb
       WHERE agent_id = $1 AND id = $2
       RETURNING *`,
      [
        agentId,
        scheduleId,
        shape.schedule_type,
        shape.timezone,
        shape.time_of_day,
        shape.day_of_week,
        shape.day_of_month,
        shape.scheduled_for,
        nextRunAt(shape),
        dto.enabled ?? existing.enabled,
        asJson(dto.inputOverride ?? existing.input_override),
      ],
    )) as ScheduleRecord;
  }

  async remove(
    tenantId: string,
    agentId: string,
    scheduleId: string,
  ): Promise<{ deleted: true }> {
    await this.agents.get(tenantId, agentId);
    const result = await this.database.query(
      'DELETE FROM agent_schedules WHERE agent_id = $1 AND id = $2',
      [agentId, scheduleId],
    );

    if (!result.rowCount) {
      throw new NotFoundException('Agent schedule was not found');
    }

    return { deleted: true };
  }

  async enqueueDueSchedules(limit = 25): Promise<number> {
    return this.database.transaction(async (client) => {
      const result = await client.query<
        ScheduleRecord & {
          tenant_id: string;
          created_by: string;
          expected_output: string;
          llm_provider: string;
          llm_model: string;
          default_input: JsonObject;
        }
      >(
        `SELECT s.*, a.tenant_id, a.created_by, a.expected_output,
                a.llm_provider, a.llm_model, a.default_input
         FROM agent_schedules s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.enabled = TRUE
           AND s.next_run_at <= NOW()
           AND a.status = 'ACTIVE'
           AND a.trigger_mode IN ('SCHEDULED', 'BOTH')
         ORDER BY s.next_run_at
         FOR UPDATE OF s SKIP LOCKED
         LIMIT $1`,
        [limit],
      );

      for (const schedule of result.rows) {
        const scheduledAt = schedule.next_run_at as Date;
        await client.query(
          `INSERT INTO agent_runs
           (agent_id, tenant_id, schedule_id, trigger_source, triggered_by,
            input_parameters, expected_output_snapshot, llm_provider_snapshot,
            llm_model_snapshot, scheduled_at)
           VALUES ($1, $2, $3, 'SCHEDULED', $4, $5::jsonb, $6, $7, $8, $9)
           ON CONFLICT (schedule_id, scheduled_at)
             WHERE schedule_id IS NOT NULL AND scheduled_at IS NOT NULL
           DO NOTHING`,
          [
            schedule.agent_id,
            schedule.tenant_id,
            schedule.id,
            schedule.created_by,
            asJson({ ...schedule.default_input, ...schedule.input_override }),
            schedule.expected_output,
            schedule.llm_provider,
            schedule.llm_model,
            scheduledAt,
          ],
        );

        if (schedule.schedule_type === 'ONCE') {
          await client.query(
            'UPDATE agent_schedules SET enabled = FALSE, last_run_at = $2, next_run_at = NULL WHERE id = $1',
            [schedule.id, scheduledAt],
          );
        } else {
          await client.query(
            'UPDATE agent_schedules SET last_run_at = $2, next_run_at = $3 WHERE id = $1',
            [schedule.id, scheduledAt, nextRunAt(schedule, new Date())],
          );
        }
      }

      return result.rowCount ?? 0;
    });
  }
}
