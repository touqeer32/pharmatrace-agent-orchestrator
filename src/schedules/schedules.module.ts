import { Module } from '@nestjs/common';
import { SchedulerWorker } from './scheduler.worker';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerWorker],
})
export class SchedulesModule {}
