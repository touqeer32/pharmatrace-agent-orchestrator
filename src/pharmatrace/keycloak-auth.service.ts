import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LlmSecretService } from '../llm/llm-secret.service';
import { McpServer } from '../mcp/mcp.types';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface KeycloakTokenResponse {
  access_token?: string;
  expires_in?: number;
}

@Injectable()
export class KeycloakAuthService {
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly secrets: LlmSecretService) {}

  async getAccessToken(server: McpServer): Promise<string> {
    const existing = this.tokens.get(server.id);

    if (existing && existing.expiresAt > Date.now() + 30_000) {
      return existing.accessToken;
    }

    const configuration = server.auth_config;
    const tokenUrl = this.string(configuration.tokenUrl) ?? process.env.KEYCLOAK_TOKEN_URL;
    const clientId = this.string(configuration.clientId) ?? process.env.KEYCLOAK_CLIENT_ID;
    const grantType =
      this.string(configuration.grantType) ?? process.env.KEYCLOAK_GRANT_TYPE ?? 'password';

    if (!tokenUrl || !clientId) {
      throw new BadRequestException('Keycloak tokenUrl and clientId must be configured before MCP calls');
    }

    if (!['client_credentials', 'password'].includes(grantType)) {
      throw new BadRequestException('Keycloak grantType must be client_credentials or password');
    }

    const body = new URLSearchParams({ grant_type: grantType, client_id: clientId });
    const clientSecretRef =
      this.string(configuration.clientSecretRef) ??
      (process.env.KEYCLOAK_CLIENT_SECRET ? 'env:KEYCLOAK_CLIENT_SECRET' : undefined);

    if (clientSecretRef) {
      body.set('client_secret', await this.secrets.resolve(clientSecretRef));
    }

    const scope = this.string(configuration.scope);

    if (scope) {
      body.set('scope', scope);
    }

    if (grantType === 'password') {
      const usernameRef =
        this.string(configuration.usernameRef) ??
        (process.env.KEYCLOAK_USERNAME ? 'env:KEYCLOAK_USERNAME' : undefined);
      const passwordRef =
        this.string(configuration.passwordRef) ??
        (process.env.KEYCLOAK_PASSWORD ? 'env:KEYCLOAK_PASSWORD' : undefined);

      if (!usernameRef || !passwordRef) {
        throw new BadRequestException('Password grant requires usernameRef and passwordRef');
      }

      body.set('username', await this.secrets.resolve(usernameRef));
      body.set('password', await this.secrets.resolve(passwordRef));
    }

    let response: Response;

    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
      });
    } catch {
      throw new BadGatewayException('Could not reach the Keycloak token endpoint');
    }

    if (!response.ok) {
      throw new UnauthorizedException(
        `Keycloak authentication failed with HTTP ${response.status}; protected MCP calls were not attempted`,
      );
    }

    const data = (await response.json()) as KeycloakTokenResponse;

    if (!data.access_token) {
      throw new UnauthorizedException('Keycloak did not return an access token');
    }

    this.tokens.set(server.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max(30, data.expires_in ?? 300) * 1000,
    });

    return data.access_token;
  }

  invalidate(serverId: string): void {
    this.tokens.delete(serverId);
  }

  private string(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
}
