import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import { PlanCacheService } from './plan-cache.service';

@Controller('agents/:agentId/execution-plan')
export class PlannerController {
  constructor(
    private readonly agents: AgentsService,
    private readonly plans: PlanCacheService,
  ) {}

  @Get()
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    await this.agents.get(tenant.tenantId, agentId);
    return this.plans.requireActive(agentId);
  }

  @Post('invalidate')
  async invalidate(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    await this.agents.get(tenant.tenantId, agentId);
    return this.plans.invalidate(agentId, 'Manually invalidated');
  }

  @Post('rebuild')
  async rebuild(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    await this.agents.get(tenant.tenantId, agentId);
    await this.plans.invalidate(agentId, 'Manual rebuild requested');
    return { rebuildOnNextRun: true };
  }
}
