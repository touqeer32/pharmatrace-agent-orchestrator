import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentsModule } from './agents/agents.module';
import { ComplianceModule } from './compliance/compliance.module';
import { TenantGuard } from './common/tenant.guard';
import { DatabaseModule } from './database/database.module';
import { ExecutionModule } from './execution/execution.module';
import { HealthController } from './health.controller';
import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { PharmaTraceModule } from './pharmatrace/pharmatrace.module';
import { PlannerModule } from './planner/planner.module';
import { SchedulesModule } from './schedules/schedules.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    LlmModule,
    PharmaTraceModule,
    McpModule,
    AgentsModule,
    ComplianceModule,
    PlannerModule,
    ExecutionModule,
    SchedulesModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: TenantGuard }],
})
export class AppModule {}
