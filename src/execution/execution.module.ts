import { Global, Module } from '@nestjs/common';
import { ExecutionController } from './execution.controller';
import { ExecutionLoopService } from './execution-loop.service';
import { ExecutionService } from './execution.service';
import { ExecutionWorker } from './execution.worker';
import { ResponseGeneratorService } from './response-generator.service';
import { RunStepService } from './run-step.service';
import { ToolExecutorService } from './tool-executor.service';

@Global()
@Module({
  controllers: [ExecutionController],
  providers: [
    RunStepService,
    ToolExecutorService,
    ResponseGeneratorService,
    ExecutionLoopService,
    ExecutionService,
    ExecutionWorker,
  ],
  exports: [ExecutionService],
})
export class ExecutionModule {}
