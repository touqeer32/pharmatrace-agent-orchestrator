import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import {
  CreateLlmConnectionDto,
  ProviderDto,
  TestLlmConnectionDto,
  UpdateLlmConnectionDto,
} from './dto/llm.dto';
import { LlmConnectionService } from './llm-connection.service';

@Controller('llm')
export class LlmController {
  constructor(private readonly connections: LlmConnectionService) {}

  @Post('connections')
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateLlmConnectionDto) {
    return this.connections.create(tenant.tenantId, dto);
  }

  @Get('connections')
  list(@CurrentTenant() tenant: TenantContext) {
    return this.connections.list(tenant.tenantId);
  }

  @Get('providers/:provider/models')
  models(
    @CurrentTenant() tenant: TenantContext,
    @Param('provider', new ParseEnumPipe(ProviderDto)) provider: ProviderDto,
  ) {
    return this.connections.models(tenant.tenantId, provider);
  }

  @Get('connections/:connectionId')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.connections.getPublic(tenant.tenantId, connectionId);
  }

  @Patch('connections/:connectionId')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: UpdateLlmConnectionDto,
  ) {
    return this.connections.update(tenant.tenantId, connectionId, dto);
  }

  @Delete('connections/:connectionId')
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.connections.remove(tenant.tenantId, connectionId);
  }

  @Post('connections/:connectionId/test')
  test(
    @CurrentTenant() tenant: TenantContext,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: TestLlmConnectionDto,
  ) {
    return this.connections.test(tenant.tenantId, connectionId, dto.model);
  }
}
