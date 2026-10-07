import { Global, Module } from '@nestjs/common';
import { McpAccessService } from './mcp-access.service';
import { McpClientService } from './mcp-client.service';
import { McpController } from './mcp.controller';
import { McpRegistryService } from './mcp-registry.service';
import { PharmaTraceMcpController } from './pharmatrace-mcp.controller';
import { ProfileComplianceMcpService } from './profile-compliance-mcp.service';
import { ComplianceModule } from '../compliance/compliance.module';

@Global()
@Module({
  imports: [ComplianceModule],
  controllers: [McpController, PharmaTraceMcpController],
  providers: [McpClientService, McpRegistryService, McpAccessService, ProfileComplianceMcpService],
  exports: [McpClientService, McpRegistryService, McpAccessService, ProfileComplianceMcpService],
})
export class McpModule {}
