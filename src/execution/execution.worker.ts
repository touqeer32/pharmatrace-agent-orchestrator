import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { safeErrorMessage } from '../common/redact';
import { ExecutionService } from './execution.service';

@Injectable()
export class ExecutionWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ExecutionWorker.name);
  private processing = false;
  private stopping = false;

  constructor(private readonly execution: ExecutionService) {}

  @Interval(Number(process.env.EXECUTION_POLL_INTERVAL_MS ?? 3000))
  async poll(): Promise<void> {
    if (this.stopping || this.processing) {
      return;
    }

    this.processing = true;

    try {
      const concurrency = Math.max(1, Math.min(10, Number(process.env.EXECUTION_CONCURRENCY ?? 3)));
      const runs = await this.execution.claim(concurrency);
      await Promise.all(runs.map((run) => this.execution.process(run)));
    } catch (error) {
      this.logger.error('Execution worker failed', safeErrorMessage(error));
    } finally {
      this.processing = false;
    }
  }

  beforeApplicationShutdown(): void {
    this.stopping = true;
  }
}
