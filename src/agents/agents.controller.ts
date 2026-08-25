import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import { AgentsService } from './agents.service';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateAgentDto) {
    return this.agents.create(tenant, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: TenantContext) {
    return this.agents.list(tenant.tenantId);
  }

  @Get(':agentId')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.agents.getWithAccess(tenant.tenantId, agentId);
  }

  @Patch(':agentId')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.agents.update(tenant, agentId, dto);
  }

  @Delete(':agentId')
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.agents.remove(tenant.tenantId, agentId);
  }

  @Post(':agentId/pause')
  pause(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.agents.setStatus(tenant.tenantId, agentId, 'PAUSED');
  }

  @Post(':agentId/resume')
  resume(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.agents.setStatus(tenant.tenantId, agentId, 'ACTIVE');
  }
}
