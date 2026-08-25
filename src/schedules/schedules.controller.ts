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
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { SchedulesService } from './schedules.service';

@Controller('agents/:agentId/schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Post()
  create(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: CreateScheduleDto,
  ) {
    return this.schedules.create(tenant.tenantId, agentId, dto);
  }

  @Get()
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.schedules.list(tenant.tenantId, agentId);
  }

  @Patch(':scheduleId')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.schedules.update(tenant.tenantId, agentId, scheduleId, dto);
  }

  @Delete(':scheduleId')
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
  ) {
    return this.schedules.remove(tenant.tenantId, agentId, scheduleId);
  }
}
