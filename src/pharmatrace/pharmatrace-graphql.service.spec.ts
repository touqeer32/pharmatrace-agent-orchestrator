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

  it('sends the exact batch-lot operation, pagination variables, and tenant headers', async () => {
    const auth = {
      getAccessToken: jest.fn(async () => 'test-access-token'),
      invalidate: jest.fn(),
    } as unknown as KeycloakAuthService;
    const listTool = {
      id: 'tool-2',
      name: 'list_batch_lots',
      operation_name: 'getAllBatchLot',
    } as McpToolRecord;
    let requestBody: { query: string; variables: unknown } | undefined;

    global.fetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-access-token');
      expect(headers.tenantid).toBe('tenant-1');
      expect(headers['x-tenant-id']).toBe('tenant-1');
      return new Response(
        JSON.stringify({ data: { getAllBatchLot: { data: [], page: { totalElements: 0 } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const service = new PharmaTraceGraphqlService(auth, new PharmaTraceNormalizerService());
    await service.execute(server, listTool, { page: 1, size: 20 });

    expect(requestBody?.variables).toEqual({ pageInput: { page: 1, size: 20 } });
    expect(requestBody?.query).toContain('query getAllBatchLot($pageInput: PageInput)');
    expect(requestBody?.query).toContain('getAllBatchLot(page: $pageInput)');
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
