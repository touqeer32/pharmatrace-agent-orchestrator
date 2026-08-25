import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TenantContext, TenantRequest } from './tenant-context';

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    return request.tenantContext as TenantContext;
  },
);
