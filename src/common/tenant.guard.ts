import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { PUBLIC_ROUTE_KEY } from './public.decorator';
import { TenantRequest } from './tenant-context';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const tenantId = this.header(request, 'x-tenant-id');
    const userId = this.header(request, 'x-user-id');

    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(userId)) {
      throw new BadRequestException(
        'x-tenant-id and x-user-id must contain valid UUIDs',
      );
    }

    const expectedApiKey = process.env.SERVICE_API_KEY;

    if (expectedApiKey) {
      const actualApiKey = this.header(request, 'x-service-api-key');
      const expected = Buffer.from(expectedApiKey);
      const actual = Buffer.from(actualApiKey);

      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new UnauthorizedException('Invalid service API key');
      }
    }

    request.tenantContext = { tenantId, userId };
    return true;
  }

  private header(request: TenantRequest, name: string): string {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
  }
}
