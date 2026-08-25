import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import { CreateMcpServerDto, UpdateMcpServerDto } from './dto/mcp.dto';
import { McpRegistryService } from './mcp-registry.service';

@Controller('mcp')
export class McpController {
  constructor(private readonly registry: McpRegistryService) {}

  @Post('servers')
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateMcpServerDto) {
    return this.registry.create(tenant.tenantId, dto);
  }

  @Get('servers')
  servers(@CurrentTenant() tenant: TenantContext) {
    return this.registry.listServers(tenant.tenantId);
  }

  @Get('tools')
  tools(@CurrentTenant() tenant: TenantContext, @Query('serverId') serverId?: string) {
    return this.registry.listTools(tenant.tenantId, serverId);
  }

  @Get('tools/:toolId')
  tool(
    @CurrentTenant() tenant: TenantContext,
    @Param('toolId', ParseUUIDPipe) toolId: string,
  ) {
    return this.registry.getTool(tenant.tenantId, toolId);
  }

  @Get('servers/:serverId')
  server(
    @CurrentTenant() tenant: TenantContext,
    @Param('serverId', ParseUUIDPipe) serverId: string,
  ) {
    return this.registry.getServer(tenant.tenantId, serverId);
  }

  @Patch('servers/:serverId')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    return this.registry.update(tenant.tenantId, serverId, dto);
  }

  @Post('servers/:serverId/sync-tools')
  sync(
    @CurrentTenant() tenant: TenantContext,
    @Param('serverId', ParseUUIDPipe) serverId: string,
  ) {
    return this.registry.syncTools(tenant.tenantId, serverId);
  }
}
