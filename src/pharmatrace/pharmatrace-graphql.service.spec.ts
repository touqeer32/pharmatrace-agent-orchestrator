import { McpServer, McpToolRecord } from '../mcp/mcp.types';
import { KeycloakAuthService } from './keycloak-auth.service';
import { PharmaTraceGraphqlService } from './pharmatrace-graphql.service';
import { PharmaTraceNormalizerService } from './pharmatrace-normalizer.service';

describe('PharmaTraceGraphqlService', () => {
  const server = {
    id: 'server-1',
    tenant_id: 'tenant-1',
    name: 'PharmaTrace',
    description: null,
    transport: 'STREAMABLE_HTTP',
    endpoint: 'https://pharmatrace.example/graphql',
    metadata: { serverType: 'PHARMATRACE_GRAPHQL' },
    auth_config: {},
    enabled: true,
  } satisfies McpServer;
  const tool = {
    id: 'tool-1',
    name: 'get_batch_lot',
    operation_name: 'getBatchLotById',
  } as McpToolRecord;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('authenticates with Keycloak before invoking protected GraphQL', async () => {
    const order: string[] = [];
    const auth = {
      getAccessToken: jest.fn(async () => {
        order.push('keycloak-login');
        return 'test-access-token';
      }),
      invalidate: jest.fn(),
    } as unknown as KeycloakAuthService;

    global.fetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      order.push('graphql-call');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
      return new Response(
        JSON.stringify({
          data: {
            getBatchLotById: JSON.stringify({ status: 200, data: { lotId: 'lot-1' } }),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const service = new PharmaTraceGraphqlService(auth, new PharmaTraceNormalizerService());
    await expect(service.execute(server, tool, { lotId: 'lot-1' })).resolves.toEqual({ lotId: 'lot-1' });
    expect(order).toEqual(['keycloak-login', 'graphql-call']);
  });

  it('does not call GraphQL when Keycloak authentication fails', async () => {
    const auth = {
      getAccessToken: jest.fn(async () => {
        throw new Error('login rejected');
      }),
      invalidate: jest.fn(),
    } as unknown as KeycloakAuthService;
    global.fetch = jest.fn() as typeof fetch;

    const service = new PharmaTraceGraphqlService(auth, new PharmaTraceNormalizerService());
    await expect(service.execute(server, tool, { lotId: 'lot-1' })).rejects.toThrow('login rejected');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
