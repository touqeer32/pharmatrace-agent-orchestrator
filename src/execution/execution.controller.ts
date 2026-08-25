import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RunAgentDto } from '../agents/dto/agent.dto';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import { ExecutionService } from './execution.service';

@Controller('agents/:agentId')
export class ExecutionController {
  constructor(private readonly execution: ExecutionService) {}

  @Post('run')
  run(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: RunAgentDto,
  ) {
    return this.execution.enqueue(tenant, agentId, dto);
  }

  @Get('runs')
  runs(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.execution.listRuns(tenant.tenantId, agentId);
  }

  @Get('runs/:runId')
  getRun(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.execution.getRun(tenant.tenantId, agentId, runId);
  }

  @Get('runs/:runId/steps')
  steps(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.execution.runSteps(tenant.tenantId, agentId, runId);
  }

  @Get('runs/:runId/tool-calls')
  toolCalls(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.execution.runSteps(tenant.tenantId, agentId, runId, true);
  }

  @Post('runs/:runId/cancel')
  cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.execution.cancel(tenant.tenantId, agentId, runId);
  }
}
