import 'dotenv/config';
import { Pool } from 'pg';
import { PHARMATRACE_TOOLS } from '../pharmatrace/pharmatrace-tools';

async function seed(): Promise<void> {
  const tenantId = process.env.SEED_TENANT_ID;

  if (!tenantId) {
    throw new Error('Set SEED_TENANT_ID to the UUID that owns the seeded PharmaTrace resources');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const authConfig = {
      tokenUrl: process.env.KEYCLOAK_TOKEN_URL,
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? 'api',
      grantType: process.env.KEYCLOAK_GRANT_TYPE ?? 'password',
      ...(process.env.KEYCLOAK_CLIENT_SECRET ? { clientSecretRef: 'env:KEYCLOAK_CLIENT_SECRET' } : {}),
      ...(process.env.KEYCLOAK_USERNAME ? { usernameRef: 'env:KEYCLOAK_USERNAME' } : {}),
      ...(process.env.KEYCLOAK_PASSWORD ? { passwordRef: 'env:KEYCLOAK_PASSWORD' } : {}),
    };

    const server = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers
       (tenant_id, name, description, endpoint, auth_config, metadata)
       VALUES ($1, 'PharmaTrace Lots', $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET endpoint = EXCLUDED.endpoint,
                     auth_config = EXCLUDED.auth_config,
                     metadata = EXCLUDED.metadata
       RETURNING id`,
      [
        tenantId,
        'Keycloak-authenticated pharmaceutical lot and product traceability',
        process.env.PHARMATRACE_GRAPHQL_URL ?? 'https://apigateway.k8s.pharmatrace.io/graphql',
        JSON.stringify(authConfig),
        JSON.stringify({ serverType: 'PHARMATRACE_GRAPHQL' }),
      ],
    );

    const serverId = server.rows[0].id;

    for (const definition of PHARMATRACE_TOOLS) {
      await pool.query(
        `INSERT INTO mcp_tools
         (server_id, name, description, domain, entity_type, operation_name,
          input_schema, keywords, capabilities, related_tool_names, metadata)
         VALUES ($1, $2, $3, 'pharmaceutical_traceability', $4, $5, $6::jsonb,
                 $7, $8, $9, $10::jsonb)
         ON CONFLICT (server_id, name)
         DO UPDATE SET description = EXCLUDED.description,
                       input_schema = EXCLUDED.input_schema,
                       enabled = TRUE`,
        [
          serverId,
          definition.name,
          definition.description,
          definition.entityType,
          definition.operationName,
          JSON.stringify(definition.inputSchema),
          definition.keywords,
          definition.capabilities,
          definition.relatedToolNames,
          JSON.stringify({ source: 'PHARMATRACE_GRAPHQL' }),
        ],
      );
    }

    for (const [provider, variable] of [
      ['OPENAI', 'OPENAI_API_KEY'],
      ['ANTHROPIC', 'ANTHROPIC_API_KEY'],
    ] as const) {
      if (!process.env[variable]) {
        continue;
      }

      await pool.query(
        `INSERT INTO llm_provider_connections
         (tenant_id, provider, name, api_key_secret_ref)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name)
         DO UPDATE SET api_key_secret_ref = EXCLUDED.api_key_secret_ref,
                       enabled = TRUE`,
        [tenantId, provider, `${provider} environment connection`, `env:${variable}`],
      );
    }

    process.stdout.write(`Seeded PharmaTrace MCP server ${serverId} with ${PHARMATRACE_TOOLS.length} tools\n`);
  } finally {
    await pool.end();
  }
}

void seed().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
