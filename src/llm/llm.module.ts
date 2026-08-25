import { Global, Module } from '@nestjs/common';
import { LlmConnectionService } from './llm-connection.service';
import { LlmController } from './llm.controller';
import { LlmProviderFactory } from './llm-provider.factory';
import { LlmSecretService } from './llm-secret.service';

@Global()
@Module({
  controllers: [LlmController],
  providers: [LlmSecretService, LlmProviderFactory, LlmConnectionService],
  exports: [LlmSecretService, LlmProviderFactory, LlmConnectionService],
})
export class LlmModule {}
