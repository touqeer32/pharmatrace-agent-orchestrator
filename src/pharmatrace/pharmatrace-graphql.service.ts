import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { JsonObject } from '../common/json';
import { McpServer, McpToolRecord } from '../mcp/mcp.types';
import { KeycloakAuthService } from './keycloak-auth.service';
import { PharmaTraceNormalizerService } from './pharmatrace-normalizer.service';
import { DEFAULT_GRAPHQL_DOCUMENTS } from './pharmatrace-tools';

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string }>;
}

@Injectable()
export class PharmaTraceGraphqlService {
  private readonly logger = new Logger(PharmaTraceGraphqlService.name);

  constructor(
    private readonly auth: KeycloakAuthService,
    private readonly normalizer: PharmaTraceNormalizerService,
  ) {}

  async execute(
    server: McpServer,
    tool: McpToolRecord,
    variables: JsonObject,
  ): Promise<unknown> {
    // Authentication must always complete before a protected GraphQL/MCP call.
    const accessToken = await this.auth.getAccessToken(server);
    const documents = server.metadata.graphqlDocuments as JsonObject | undefined;
    const configuredDocument = documents?.[tool.name];
    const query =
      typeof configuredDocument === 'string'
        ? configuredDocument
        : DEFAULT_GRAPHQL_DOCUMENTS[tool.name];

    if (!query || !tool.operation_name) {
      throw new BadRequestException(`No GraphQL document is configured for ${tool.name}`);
    }

    const requestVariables = tool.name === 'list_batch_lots'
      ? { pageInput: variables }
      : variables;

    if (process.env.DEBUG_GRAPHQL_REQUESTS === 'true') {
      this.logger.log('PharmaTrace GraphQL request', {
        tenantId: server.tenant_id,
        tool: tool.name,
        operationName: tool.operation_name,
        endpoint: server.endpoint,
        variables: requestVariables,
        hasBearerToken: Boolean(accessToken),
      });
    }

    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(server.tenant_id ? { tenantid: server.tenant_id } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables: requestVariables }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
    });

    if (response.status === 401 || response.status === 403) {
      this.auth.invalidate(server.id);
      throw new BadGatewayException(`PharmaTrace rejected the authenticated request with HTTP ${response.status}`);
    }

    if (!response.ok) {
      const details = (await response.text()).slice(0, 1000);
      throw new BadGatewayException(
        `PharmaTrace GraphQL returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
      );
    }

    if (process.env.DEBUG_GRAPHQL_REQUESTS === 'true') {
      this.logger.log('PharmaTrace GraphQL response', {
        tenantId: server.tenant_id,
        tool: tool.name,
        operationName: tool.operation_name,
        status: response.status,
      });
    }

    const payload = (await response.json()) as GraphqlResponse;

    if (payload.errors?.length) {
      throw new BadGatewayException(
        payload.errors.map((item) => item.message ?? 'Unknown GraphQL error').join('; '),
      );
    }

    return this.normalizer.normalize(tool.name, payload.data?.[tool.operation_name]);
  }
}
