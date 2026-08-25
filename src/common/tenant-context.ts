export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: TenantContext;
}
