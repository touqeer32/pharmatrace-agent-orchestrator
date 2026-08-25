import { Controller, Get } from '@nestjs/common';
import { Public } from './common/public.decorator';
import { DatabaseService } from './database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health(): Promise<Record<string, unknown>> {
    await this.database.query('SELECT 1');
    return {
      status: 'ok',
      service: 'pharmatrace-agent-orchestrator',
      timestamp: new Date().toISOString(),
    };
  }
}
