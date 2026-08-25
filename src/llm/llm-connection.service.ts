import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateText } from 'ai';
import { DatabaseService } from '../database/database.service';
import { safeErrorMessage } from '../common/redact';
import {
  CreateLlmConnectionDto,
  UpdateLlmConnectionDto,
} from './dto/llm.dto';
import { LlmProviderFactory } from './llm-provider.factory';
import { LlmSecretService } from './llm-secret.service';
import { LlmConnection, LlmProvider } from './llm.types';

@Injectable()
export class LlmConnectionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: LlmSecretService,
    private readonly factory: LlmProviderFactory,
  ) {}

  async create(tenantId: string, dto: CreateLlmConnectionDto): Promise<Record<string, unknown>> {
    if (dto.apiKey && dto.apiKeySecretRef) {
      throw new BadRequestException('Provide either apiKey or apiKeySecretRef, not both');
    }

    const reference = dto.apiKey
      ? await this.secrets.store(dto.apiKey)
      : (dto.apiKeySecretRef as string);

    const row = await this.database.one<LlmConnection>(
      `INSERT INTO llm_provider_connections
       (tenant_id, provider, name, api_key_secret_ref, api_key_hint, base_url, organization_id, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        dto.provider,
        dto.name,
        reference,
        dto.apiKey ? this.secrets.hint(dto.apiKey) : null,
        dto.baseUrl ?? null,
        dto.organizationId ?? null,
        dto.projectId ?? null,
      ],
    );

    return this.publicConnection(row as LlmConnection);
  }

  async list(tenantId: string): Promise<Record<string, unknown>[]> {
    const result = await this.database.query<LlmConnection>(
      'SELECT * FROM llm_provider_connections WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return result.rows.map((row) => this.publicConnection(row));
  }

  async get(tenantId: string, connectionId: string): Promise<LlmConnection> {
    const row = await this.database.one<LlmConnection>(
      'SELECT * FROM llm_provider_connections WHERE tenant_id = $1 AND id = $2',
      [tenantId, connectionId],
    );

    if (!row) {
      throw new NotFoundException('LLM provider connection was not found');
    }

    return row;
  }

  async getPublic(tenantId: string, connectionId: string): Promise<Record<string, unknown>> {
    return this.publicConnection(await this.get(tenantId, connectionId));
  }

  async update(
    tenantId: string,
    connectionId: string,
    dto: UpdateLlmConnectionDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.get(tenantId, connectionId);

    if (dto.apiKey && dto.apiKeySecretRef) {
      throw new BadRequestException('Provide either apiKey or apiKeySecretRef, not both');
    }

    const reference = dto.apiKey
      ? await this.secrets.store(dto.apiKey)
      : dto.apiKeySecretRef ?? existing.api_key_secret_ref;

    const row = await this.database.one<LlmConnection>(
      `UPDATE llm_provider_connections
       SET name = $3, api_key_secret_ref = $4, api_key_hint = $5,
           base_url = $6, organization_id = $7, project_id = $8, enabled = $9
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        connectionId,
        dto.name ?? existing.name,
        reference,
        dto.apiKey ? this.secrets.hint(dto.apiKey) : existing.api_key_hint,
        dto.baseUrl ?? existing.base_url,
        dto.organizationId ?? existing.organization_id,
        dto.projectId ?? existing.project_id,
        dto.enabled ?? existing.enabled,
      ],
    );

    return this.publicConnection(row as LlmConnection);
  }

  async remove(tenantId: string, connectionId: string): Promise<{ deleted: true }> {
    const result = await this.database.query(
      'DELETE FROM llm_provider_connections WHERE tenant_id = $1 AND id = $2',
      [tenantId, connectionId],
    );

    if (!result.rowCount) {
      throw new NotFoundException('LLM provider connection was not found');
    }

    return { deleted: true };
  }

  async test(
    tenantId: string,
    connectionId: string,
    modelName: string,
  ): Promise<Record<string, unknown>> {
    const connection = await this.get(tenantId, connectionId);

    try {
      const model = await this.factory.create(connection, modelName);
      const result = await generateText({
        model,
        prompt: 'Reply with exactly: connection-ok',
        maxOutputTokens: 32,
      });

      await this.database.query(
        `UPDATE llm_provider_connections
         SET last_tested_at = NOW(), last_test_succeeded = TRUE, last_test_error = NULL
         WHERE id = $1`,
        [connectionId],
      );

      return {
        success: true,
        provider: connection.provider,
        model: modelName,
        response: result.text,
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.database.query(
        `UPDATE llm_provider_connections
         SET last_tested_at = NOW(), last_test_succeeded = FALSE, last_test_error = $2
         WHERE id = $1`,
        [connectionId, message],
      );
      throw new BadRequestException({ success: false, provider: connection.provider, message });
    }
  }

  async models(tenantId: string, provider: LlmProvider): Promise<Record<string, unknown>> {
    const connection = await this.database.one<LlmConnection>(
      `SELECT * FROM llm_provider_connections
       WHERE tenant_id = $1 AND provider = $2 AND enabled = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, provider],
    );

    if (!connection) {
      throw new NotFoundException(`No enabled ${provider} connection exists for this tenant`);
    }

    const apiKey = await this.secrets.resolve(connection.api_key_secret_ref);
    const baseUrl = connection.base_url ??
      (provider === 'OPENAI'
        ? 'https://api.openai.com/v1'
        : provider === 'OLLAMA'
          ? (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1')
          : 'https://api.anthropic.com/v1');
    const headers: Record<string, string> =
      provider === 'OPENAI' || provider === 'OLLAMA'
        ? { Authorization: `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });

    if (!response.ok) {
      throw new BadRequestException(`The ${provider} models endpoint returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    return { provider, models: body.data ?? [] };
  }

  publicConnection(connection: LlmConnection): Record<string, unknown> {
    const { api_key_secret_ref: _secretReference, ...safe } = connection;
    return safe;
  }
}
