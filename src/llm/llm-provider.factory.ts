import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { LlmSecretService } from './llm-secret.service';
import { LlmConnection } from './llm.types';

@Injectable()
export class LlmProviderFactory {
  constructor(private readonly secrets: LlmSecretService) {}

  async create(connection: LlmConnection, model: string): Promise<LanguageModel> {
    if (!connection.enabled) {
      throw new BadRequestException('The selected LLM provider connection is disabled');
    }

    const apiKey = await this.secrets.resolve(connection.api_key_secret_ref);

    if (connection.provider === 'ANTHROPIC') {
      const anthropic = createAnthropic({
        apiKey,
        ...(connection.base_url ? { baseURL: connection.base_url } : {}),
      });
      return anthropic(model);
    }

    if (connection.provider === 'OLLAMA') {
      const ollama = createOpenAI({
        // Ollama exposes an OpenAI-compatible API. The key is ignored by Ollama,
        // but the OpenAI adapter requires one.
        apiKey,
        baseURL: connection.base_url ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      });
      return ollama.chat(model);
    }

    const openai = createOpenAI({
      apiKey,
      ...(connection.base_url ? { baseURL: connection.base_url } : {}),
      ...(connection.organization_id ? { organization: connection.organization_id } : {}),
      ...(connection.project_id ? { project: connection.project_id } : {}),
    });

    // Explicitly use OpenAI's recommended Responses API surface.
    return openai.responses(model);
  }
}
