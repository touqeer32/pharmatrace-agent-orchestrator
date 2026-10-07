import { Injectable } from '@nestjs/common';
import { TenantContext } from '../common/tenant-context';
import { SerialProfileComplianceService } from '../compliance/serial-profile-compliance.service';
import { PatternComplianceService } from '../compliance/pattern-compliance.service';

@Injectable()
export class ProfileComplianceMcpService {
  constructor(
    private readonly profiles: SerialProfileComplianceService,
    private readonly patterns: PatternComplianceService,
  ) {}

  run(toolName: string, tenant: TenantContext, input: Record<string, unknown>) {
    if (toolName === 'run_recall_pattern_compliance' || toolName === 'run_shortage_pattern_compliance') {
      return this.patterns.run(tenant, {
        limit: typeof input.limit === 'number' ? input.limit : 500,
        minEvents: typeof input.minEvents === 'number' ? input.minEvents : 2,
        windowDays: typeof input.windowDays === 'number' ? input.windowDays : 365,
        resetReports: input.resetReports === true,
      }, toolName === 'run_recall_pattern_compliance' ? 'RECALL_PATTERN' : 'SHORTAGE_PATTERN');
    }
    const family = toolName === 'run_sscc_profile_compliance'
      ? 'SSCC_PROFILE'
      : toolName === 'run_gdti_profile_compliance'
        ? 'GDTI_PROFILE'
        : 'SERIAL_NUMBER_PROFILE';
    return this.profiles.run(tenant, {
      limit: typeof input.limit === 'number' ? input.limit : 100,
      generateDemoNumbers: input.generateDemoNumbers !== false,
      demoNumberCount: typeof input.demoNumberCount === 'number' ? input.demoNumberCount : 2,
      resetReports: input.resetReports === true,
    }, family);
  }
}
