import { Global, Module } from '@nestjs/common';
import { ExecutionController } from './execution.controller';
import { ExecutionLoopService } from './execution-loop.service';
import { ExecutionService } from './execution.service';
import { ExecutionWorker } from './execution.worker';
import { ResponseGeneratorService } from './response-generator.service';
import { RunStepService } from './run-step.service';
import { ToolExecutorService } from './tool-executor.service';
import { McpModule } from '../mcp/mcp.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { AgentAuditService } from './agent-audit.service';

@Global()
@Module({
  imports: [McpModule, ComplianceModule],
  controllers: [ExecutionController],
  providers: [
    RunStepService,
    AgentAuditService,
    ToolExecutorService,
    ResponseGeneratorService,
    ExecutionLoopService,
    ExecutionService,
    ExecutionWorker,
  ],
  exports: [ExecutionService],
})
export class ExecutionModule {}
