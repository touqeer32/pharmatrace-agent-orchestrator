import { Global, Module } from '@nestjs/common';
import { PlanCacheService } from './plan-cache.service';
import { PlannerController } from './planner.controller';
import { PlannerService } from './planner.service';

@Global()
@Module({
  controllers: [PlannerController],
  providers: [PlannerService, PlanCacheService],
  exports: [PlannerService, PlanCacheService],
})
export class PlannerModule {}
