import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentTenant } from '../common/tenant.decorator';
import { TenantContext } from '../common/tenant-context';
import {
  AttestationSubmittedDto,
  AgentReviewDto,
  CreateComplianceReportDto,
  DemoSeedDto,
  FindingResolutionDto,
  ReportCommentDto,
  ReportDecisionDto,
  WalletPrepareDto,
} from './dto/compliance.dto';
import { ComplianceService } from './compliance.service';
import { SerialProfileComplianceService, SerialProfileRunInput } from './serial-profile-compliance.service';
import { PatternComplianceService, PatternComplianceRunInput } from './pattern-compliance.service';
import { ComplianceAuditService } from './compliance-audit.service';

@Controller('compliance/reports')
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly serialProfiles: SerialProfileComplianceService,
    private readonly patterns: PatternComplianceService,
    private readonly audit: ComplianceAuditService,
  ) {}

  @Post('serial-profiles/run')
  runSerialProfiles(@CurrentTenant() tenant: TenantContext, @Body() dto: SerialProfileRunInput) {
    return this.serialProfiles.run(tenant, dto);
  }

  @Post('sscc-profiles/run')
  runSsccProfiles(@CurrentTenant() tenant: TenantContext, @Body() dto: SerialProfileRunInput) {
    return this.serialProfiles.run(tenant, dto, 'SSCC_PROFILE');
  }

  @Post('gdti-profiles/run')
  runGdtiProfiles(@CurrentTenant() tenant: TenantContext, @Body() dto: SerialProfileRunInput) {
    return this.serialProfiles.run(tenant, dto, 'GDTI_PROFILE');
  }

  @Post('recall-patterns/run')
  runRecallPatterns(@CurrentTenant() tenant: TenantContext, @Body() dto: PatternComplianceRunInput) {
    return this.patterns.run(tenant, dto, 'RECALL_PATTERN');
  }

  @Post('shortage-patterns/run')
  runShortagePatterns(@CurrentTenant() tenant: TenantContext, @Body() dto: PatternComplianceRunInput) {
    return this.patterns.run(tenant, dto, 'SHORTAGE_PATTERN');
  }

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateComplianceReportDto) {
    return this.compliance.createReport(tenant, dto);
  }

  @Post('demo/seed')
  seedDemo(@CurrentTenant() tenant: TenantContext, @Body() dto: DemoSeedDto) {
    return this.compliance.seedDemoReports(tenant, dto.count ?? 3);
  }

  @Post(':reportId/agent/submit')
  submitAgentReport(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.compliance.submitAgentAttestation(tenant.tenantId, reportId);
  }

  @Post(':reportId/agent/review')
  agentReview(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: AgentReviewDto,
  ) {
    return this.compliance.agentReview(tenant, reportId, dto);
  }

  @Get()
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('agentType') agentType?: string,
    @Query('resultStatus') resultStatus?: string,
    @Query('recordType') recordType?: string,
    @Query('recordId') recordId?: string,
    @Query('sourceSystem') sourceSystem?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.compliance.listReports(tenant.tenantId, {
      status,
      agentType: agentType ?? type,
      resultStatus,
      recordType,
      recordId,
      sourceSystem,
      limit: this.numberQuery(limit, 50, 200),
      offset: this.numberQuery(offset, 0, Number.MAX_SAFE_INTEGER),
    });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorId: tenant.userId,
      actionType: 'COMPLIANCE_REPORT_LISTED',
      resourceType: 'COMPLIANCE_REPORT',
      status: 'COMPLETED',
      description: 'Compliance reports listed',
      privateData: { status, type: type ?? agentType, limit, offset },
    });
    return result;
  }

  @Get(':reportId')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    const result = await this.compliance.getReport(tenant.tenantId, reportId);
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorId: tenant.userId,
      actionType: 'COMPLIANCE_REPORT_VIEWED',
      resourceType: 'COMPLIANCE_REPORT',
      resourceId: reportId,
      status: 'COMPLETED',
      description: 'Compliance report viewed',
    });
    return result;
  }

  @Post(':reportId/findings/:findingId/comment')
  comment(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() dto: ReportCommentDto,
  ) {
    return this.compliance.commentFinding(tenant, reportId, findingId, dto);
  }

  @Post(':reportId/comment')
  commentReport(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReportCommentDto,
  ) {
    return this.compliance.commentReport(tenant, reportId, dto);
  }

  @Post(':reportId/findings/:findingId/resolve')
  resolve(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() dto: FindingResolutionDto,
  ) {
    return this.compliance.resolveFinding(tenant, reportId, findingId, dto);
  }

  @Post(':reportId/findings/:findingId/override')
  override(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() dto: FindingResolutionDto,
  ) {
    return this.compliance.overrideFinding(tenant, reportId, findingId, dto);
  }

  @Post(':reportId/approve')
  async approve(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReportDecisionDto,
  ) {
    const result = await this.compliance.decide(tenant, reportId, 'APPROVED', dto);
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorId: tenant.userId,
      actionType: 'COMPLIANCE_REPORT_APPROVED',
      resourceType: 'COMPLIANCE_REPORT',
      resourceId: reportId,
      status: 'APPROVED',
      description: 'Compliance report approved',
      privateData: { comment: dto.comment ?? null },
    });
    return result;
  }

  @Post(':reportId/reject')
  async reject(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReportDecisionDto,
  ) {
    const result = await this.compliance.decide(tenant, reportId, 'REJECTED', dto);
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorId: tenant.userId,
      actionType: 'COMPLIANCE_REPORT_REJECTED',
      resourceType: 'COMPLIANCE_REPORT',
      resourceId: reportId,
      status: 'REJECTED',
      description: 'Compliance report rejected and returned for review',
      privateData: { comment: dto.comment ?? null },
    });
    return result;
  }

  @Post(':reportId/wallet/prepare')
  prepareWallet(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: WalletPrepareDto,
  ) {
    return this.compliance.prepareAttestation(tenant.tenantId, reportId, dto?.payerAccountId);
  }

  @Post(':reportId/comments/:commentId/wallet/prepare')
  prepareCommentWallet(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: WalletPrepareDto,
  ) {
    return this.compliance.prepareCommentAttestation(tenant.tenantId, reportId, commentId, dto?.payerAccountId);
  }

  @Post(':reportId/actions/:actionId/wallet/prepare')
  prepareActionWallet(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body() dto: WalletPrepareDto,
  ) {
    return this.compliance.prepareActionAttestation(tenant.tenantId, reportId, actionId, dto?.payerAccountId);
  }

  @Post(':reportId/actions/prepare-pending')
  preparePendingActions(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: WalletPrepareDto,
  ) {
    return this.compliance.preparePendingActions(tenant.tenantId, reportId, dto?.payerAccountId);
  }

  @Post(':reportId/actions/:actionId/wallet/submitted')
  submittedActionWallet(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body() dto: AttestationSubmittedDto,
  ) {
    return this.compliance.recordActionSubmission(tenant.tenantId, reportId, actionId, dto);
  }

  @Get(':reportId/actions/:actionId/verify')
  verifyAction(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.compliance.verifyAction(tenant.tenantId, reportId, actionId);
  }

  @Post(':reportId/comments/:commentId/wallet/submitted')
  submittedCommentWallet(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: AttestationSubmittedDto,
  ) {
    return this.compliance.recordCommentSubmission(tenant.tenantId, reportId, commentId, dto);
  }

  @Get(':reportId/comments/:commentId/verify')
  verifyComment(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.compliance.verifyComment(tenant.tenantId, reportId, commentId);
  }

  @Post(':reportId/wallet/submitted')
  submitted(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: AttestationSubmittedDto,
  ) {
    return this.compliance.recordAttestationSubmission(tenant.tenantId, reportId, dto);
  }

  @Get(':reportId/verify')
  verify(
    @CurrentTenant() tenant: TenantContext,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.compliance.getVerificationState(tenant.tenantId, reportId);
  }

  private numberQuery(value: string | undefined, fallback: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), 0), max);
  }
}
