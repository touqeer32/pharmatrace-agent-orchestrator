import { Global, Module } from '@nestjs/common';
import { McpAccessService } from './mcp-access.service';
import { McpClientService } from './mcp-client.service';
import { McpController } from './mcp.controller';
import { McpRegistryService } from './mcp-registry.service';
import { PharmaTraceMcpController } from './pharmatrace-mcp.controller';

@Global()
@Module({
  controllers: [McpController, PharmaTraceMcpController],
  providers: [McpClientService, McpRegistryService, McpAccessService],
  exports: [McpClientService, McpRegistryService, McpAccessService],
})
export class McpModule {}
