import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceHcsService } from './compliance-hcs.service';
import { SerialProfileComplianceService } from './serial-profile-compliance.service';
import { Gs1ValidationService } from './gs1-validation.service';
import { PatternComplianceService } from './pattern-compliance.service';
import { ComplianceAuditService } from './compliance-audit.service';

@Module({
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceHcsService, SerialProfileComplianceService, Gs1ValidationService, PatternComplianceService, ComplianceAuditService],
  exports: [ComplianceService, ComplianceHcsService, SerialProfileComplianceService, Gs1ValidationService, PatternComplianceService],
})
export class ComplianceModule {}
