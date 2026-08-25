import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { safeErrorMessage } from '../common/redact';
import { SchedulesService } from './schedules.service';

@Injectable()
export class SchedulerWorker {
  private readonly logger = new Logger(SchedulerWorker.name);
  private polling = false;

  constructor(private readonly schedules: SchedulesService) {}

  @Interval(Number(process.env.SCHEDULER_POLL_INTERVAL_MS ?? 15_000))
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;

    try {
      const count = await this.schedules.enqueueDueSchedules();

      if (count) {
        this.logger.log(`Queued ${count} scheduled agent execution(s)`);
      }
    } catch (error) {
      this.logger.error(`Scheduler polling failed: ${safeErrorMessage(error)}`);
    } finally {
      this.polling = false;
    }
  }
}
