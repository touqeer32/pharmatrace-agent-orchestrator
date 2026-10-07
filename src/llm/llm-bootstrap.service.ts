import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Optionally provisions the production LLM connection from deployment env and
 * attaches it to every agent in the resolved production tenant. Disabled by
 * default so local Ollama agents are never changed accidentally.
 */
@Injectable()
export class LlmBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(LlmBootstrapService.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.LLM_BOOTSTRAP_ENABLED !== 'true') return;

    const provider = process.env.LLM_BOOTSTRAP_PROVIDER ?? 'OPENAI';
    const model = this.required('LLM_BOOTSTRAP_MODEL');
    const baseUrl = this.required('LLM_BOOTSTRAP_BASE_URL');
    const connectionName = process.env.LLM_BOOTSTRAP_CONNECTION_NAME ?? `${provider} Production`;
    const apiKeySecretRef = process.env.LLM_BOOTSTRAP_API_KEY_REF ?? 'env:NVIDIA_API_KEY';
    let tenantId = process.env.LLM_BOOTSTRAP_TENANT_ID?.trim() || null;
    let agentId = process.env.LLM_BOOTSTRAP_AGENT_ID?.trim() || null;
    const agentName = process.env.LLM_BOOTSTRAP_AGENT_NAME?.trim() || null;

    // Prefer a stable agent name in deployment configuration. This resolves
    // both IDs from the database so Helm/UI users do not copy UUIDs into env.
    if (!agentId && agentName) {
      const matches = await this.database.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM agents
         WHERE name = $1
         ORDER BY updated_at DESC
         LIMIT 2`,
        [agentName],
      );
      if (matches.rowCount !== 1) {
        throw new Error(`LLM bootstrap expected one agent named '${agentName}', found ${matches.rowCount}`);
      }
      agentId = matches.rows[0].id;
      tenantId = tenantId ?? matches.rows[0].tenant_id;
    }

    if (!tenantId) {
      this.logger.error(
        'LLM bootstrap skipped: set LLM_BOOTSTRAP_AGENT_NAME to a stable agent name or LLM_BOOTSTRAP_TENANT_ID',
      );
      return;
    }

    const connection = await this.database.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM llm_provider_connections
         WHERE tenant_id = $1 AND name = $2
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, connectionName],
      );

      if (existing.rowCount) {
        const updated = await client.query<{ id: string }>(
          `UPDATE llm_provider_connections
           SET provider = $3, api_key_secret_ref = $4, base_url = $5,
               enabled = TRUE
           WHERE tenant_id = $1 AND id = $2
           RETURNING id`,
          [tenantId, existing.rows[0].id, provider, apiKeySecretRef, baseUrl],
        );
        return updated.rows[0].id;
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO llm_provider_connections
           (tenant_id, provider, name, api_key_secret_ref, base_url, enabled)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id`,
        [tenantId, provider, connectionName, apiKeySecretRef, baseUrl],
      );
      return created.rows[0].id;
    });

    // Production bootstrap is authoritative for the resolved tenant. This
    // prevents older agents (for example profile agents created with local
    // Ollama) from continuing to call 127.0.0.1 after deployment.
    const result = await this.database.query(
      `UPDATE agents
       SET llm_connection_id = $2, llm_provider = $3, llm_model = $4
       WHERE tenant_id = $1`,
      [tenantId, connection, provider, model],
    );
    if (!result.rowCount) {
      throw new Error('LLM bootstrap found no agents for the configured tenant');
    }

    this.logger.log({
      tenantId,
      provider,
      model,
      baseUrl,
      connectionName,
      connectionId: connection,
      agentId: agentId ?? null,
      agentName: agentName ?? null,
      updatedAgentCount: result.rowCount,
    }, 'LLM connection bootstrap completed');
  }

  private required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required when LLM_BOOTSTRAP_ENABLED=true`);
    return value;
  }
}
