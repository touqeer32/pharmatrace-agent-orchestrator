import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { AccountId } from '@hashgraph/sdk';
import { DatabaseService } from '../database/database.service';
import { hederaTopicId, mirrorNodeUrl } from '../common/hedera-config';
import {
  AttestationSubmittedDto,
  AgentReviewDto,
  CreateComplianceReportDto,
  FindingResolutionDto,
  ReportCommentDto,
  ReportDecisionDto,
  ComplianceResultStatusDto,
  ComplianceSeverityDto,
} from './dto/compliance.dto';
import { TenantContext } from '../common/tenant-context';
import { ComplianceHcsService } from './compliance-hcs.service';

type ReportFilters = {
  status?: string;
  agentType?: string;
  resultStatus?: string;
  recordType?: string;
  recordId?: string;
  sourceSystem?: string;
  limit: number;
  offset: number;
};

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

type MerkleLeaf = {
  leafType: string;
  sourceId: string | null;
  payload: Record<string, unknown>;
};

function merkleRootAndProofs(hashes: string[]) {
  if (!hashes.length) return { root: digest({ empty: true }), proofs: [] as string[][] };
  let level = hashes.slice();
  const proofs = hashes.map(() => [] as string[]);
  const indexes = hashes.map((_, index) => index);

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      const rightWasDuplicated = index + 1 >= level.length;
      const leftLeafIndex = indexes[index];
      const rightLeafIndex = indexes[index + 1];
      proofs[leftLeafIndex].push(`R:${right}`);
      if (rightLeafIndex !== undefined) proofs[rightLeafIndex].push(`L:${left}`);
      else if (!rightWasDuplicated) proofs[leftLeafIndex].push(`R:${right}`);
      next.push(createHash('sha256').update(`${left}${right}`).digest('hex'));
    }
    const nextIndexes: number[] = [];
    for (let index = 0; index < indexes.length; index += 2) nextIndexes.push(indexes[index]);
    level = next;
    indexes.splice(0, indexes.length, ...nextIndexes);
  }
  return { root: level[0], proofs };
}

const closedFindingStatuses = new Set(['RESOLVED', 'OVERRIDDEN', 'CLOSED_NO_ACTION']);

function buildReviewPolicy(report: any, findings: any[]) {
  const openRequiredFindings = findings.filter((finding) =>
    finding.requires_resolution !== false &&
    !closedFindingStatuses.has(String(finding.status).toUpperCase()),
  ).length;
  const status = String(report.status || '').toUpperCase();
  const final = ['APPROVED', 'APPROVED_WITH_OVERRIDE', 'REJECTED', 'ATTESTED'].includes(status);
  const agentQueue = status === 'AGENT_REVIEW';
  const queueMode = status === 'AGENT_REVIEW' || status === 'HUMAN_REVIEW'
    ? status
    : openRequiredFindings > 0
      ? 'RESOLUTION_REQUIRED'
      : status === 'PENDING_REVIEW' ? 'DIRECT_APPROVAL' : 'READY_FOR_APPROVAL';
  return {
    mode: queueMode,
    reviewQueue: status === 'AGENT_REVIEW' ? 'AGENT' : status === 'HUMAN_REVIEW' ? 'HUMAN' : null,
    agentReviewRequired: status === 'AGENT_REVIEW',
    requiresUserAction: !final,
    requiresFindingResolution: openRequiredFindings > 0,
    openRequiredFindings,
    allowApprove: !final && !agentQueue && openRequiredFindings === 0,
    allowResolve: !final && !agentQueue && openRequiredFindings > 0,
    allowOverride: !final && !agentQueue && openRequiredFindings > 0,
    allowReject: !final && !agentQueue,
  };
}

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly hcs: ComplianceHcsService,
  ) {}

  async submitAgentAttestation(tenantId: string, reportId: string) {
    const result = await this.hcs.submitReportCreated(tenantId, reportId);
    return {
      ...result,
      report: await this.getReport(tenantId, reportId),
    };
  }

  async persistAgentProfileReview(input: {
    tenantId: string;
    agentId: string;
    agentName: string;
    response: Record<string, unknown>;
  }): Promise<Array<Record<string, unknown>>> {
    const profiles = Array.isArray(input.response.profiles) ? input.response.profiles : [];
    if (input.response.processingStatus === 'NO_DATA' || !profiles.length) return [];

    const created: Array<Record<string, unknown>> = [];
    for (const item of profiles) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const profile = item as Record<string, any>;
      if (typeof profile.profileId !== 'string' || !profile.profileId) continue;

      const current = await this.db.one<any>(
        `SELECT * FROM compliance_reports
         WHERE tenant_id = $1 AND record_id = $2
         ORDER BY report_version DESC, created_at DESC LIMIT 1`,
        [input.tenantId, profile.profileId],
      );
      if (!current) continue;

      const originalFindings = await this.db.query<any>(
        `SELECT * FROM compliance_findings WHERE tenant_id = $1 AND report_id = $2 ORDER BY created_at`,
        [input.tenantId, current.id],
      );
      const agentFindings = Array.isArray(profile.findings) ? profile.findings : [];
      const agentById = new Map(agentFindings
        .filter((finding: any) => finding && typeof finding === 'object' && typeof finding.findingId === 'string')
        .map((finding: any) => [finding.findingId, finding]));
      const agentByRule = new Map(agentFindings
        .filter((finding: any) => finding && typeof finding === 'object' && typeof finding.ruleId === 'string')
        .map((finding: any) => [finding.ruleId, finding]));

      // Merge the agent assessment into every original deterministic finding.
      // Findings omitted by a group remain present and are marked NOT_REVIEWED.
      const findings = originalFindings.rows.map((original: any) => {
        const assessment = agentById.get(original.id) ?? agentByRule.get(original.rule_id);
        const modelAssessment = assessment?.assessment ?? assessment?.agentAssessment;
        const modelComment = assessment?.comment ?? assessment?.finding;
        const contradictoryNeedsContext = modelAssessment === 'NEEDS_CONTEXT' && original.requires_resolution !== false;
        const contextualFilterNeedsContext = original.rule_id === 'GDTI-FILTER-002'
          && !/travel/i.test(String(current.source_data?.documentType ?? ''))
          && modelAssessment === 'CONFIRMED';
        const invalidAssessment = Boolean(assessment) && (
          !['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT'].includes(String(modelAssessment))
          || contradictoryNeedsContext
        );
        const agentAssessment = !assessment
          ? 'NOT_REVIEWED'
          : invalidAssessment ? 'REVIEW_FAILED' : contextualFilterNeedsContext ? 'NEEDS_CONTEXT' : modelAssessment;
        const currentValue = original.evidence?.currentValue;
        const expectedValue = original.evidence?.expectedValue;
        const ruleId = String(original.rule_id ?? '');
        const ownerAction = /REMAINING|THRESHOLD|STATUS/.test(ruleId)
          ? 'REPLENISH_NUMBER_RANGE'
          : /INDEX/.test(ruleId)
            ? 'RECONCILE_GENERATOR_STATE'
            : /GENERATION|GS1-ENGINE|OUTPUT/.test(ruleId)
              ? 'INVESTIGATE_GENERATOR'
              : original.user_can_fix === false ? 'ESCALATE_TO_RANGE_OR_MASTER_DATA_OWNER' : 'UPDATE_PROFILE_FIELD';
        const remediationTarget = /REMAINING|THRESHOLD|STATUS/.test(ruleId)
          ? 'RANGE_ALLOCATION'
          : /INDEX/.test(ruleId)
            ? 'GENERATOR_STATE'
            : /GENERATION|GS1-ENGINE|OUTPUT/.test(ruleId)
              ? 'GENERATOR_OUTPUT'
              : 'PROFILE_CONFIGURATION';
        const deterministicInstruction = original.user_can_fix === false
          ? original.suggested_action ?? original.recommendation ?? 'Escalate this finding to the system owner.'
          : original.suggested_action ?? original.recommendation ?? 'Apply the expected rule correction.';
        const deterministicRemediation = agentAssessment === 'NEEDS_CONTEXT' || agentAssessment === 'NOT_REVIEWED' || agentAssessment === 'REVIEW_FAILED'
          ? undefined
          : { action: ownerAction, target: remediationTarget, from: currentValue, to: expectedValue, instruction: deterministicInstruction };
        return {
          ruleId: original.rule_id,
          title: original.title,
          comment: invalidAssessment ? original.comment : modelComment || original.comment,
          recommendation: original.recommendation,
          severity: original.severity ?? current.severity ?? ComplianceSeverityDto.MEDIUM,
          requiresResolution: original.requires_resolution !== false,
          status: agentAssessment === 'NEEDS_CONTEXT' ? 'OPEN' : original.status ?? 'OPEN',
          field: original.field ?? undefined,
          userCanFix: original.user_can_fix ?? true,
          suggestedAction: original.suggested_action,
          evidence: {
            ...(original.evidence ?? {}),
            findingKey: original.evidence?.findingKey ?? digest({
              recordId: current.record_id,
              ruleId: original.rule_id,
              field: original.field ?? null,
            }),
            supersedesFindingId: original.id,
            agentAssessment,
            assessment: agentAssessment,
            // These are authoritative deterministic values. The LLM is not
            // allowed to recreate or alter them.
            currentValue,
            expectedValue,
            remediation: deterministicRemediation,
            ...(invalidAssessment ? { agentReviewError: 'Model assessment failed backend evidence/consistency validation.' } : {}),
          },
        };
      });
      const resultStatus = ['PASS', 'FAIL', 'REVIEW'].includes(String(profile.resultStatus).toUpperCase())
        ? String(profile.resultStatus).toUpperCase() as ComplianceResultStatusDto
        : ComplianceResultStatusDto.REVIEW;
      const acceptedAssessments = findings.filter((finding: any) =>
        ['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT'].includes(String(finding.evidence?.agentAssessment)),
      ).length;
      const failedAssessments = findings.filter((finding: any) => finding.evidence?.agentAssessment === 'REVIEW_FAILED').length;
      this.logger.log('Profile agent review merge', {
        tenantId: input.tenantId,
        reportId: current.id,
        profileId: profile.profileId,
        receivedAssessments: agentFindings.length,
        persistedFindings: findings.length,
        acceptedAssessments,
        failedAssessments,
      });
      const review = {
        reviewedAt: new Date().toISOString(),
        reviewer: input.agentName,
        status: failedAssessments > 0 ? 'FAILED' : 'COMPLETED',
        resultStatus,
        reviewedFindingCount: acceptedAssessments,
        failedFindingCount: failedAssessments,
        // Do not copy rejected model output into the authoritative report.
        // The full request/response is available in the redacted model trace.
        findings: failedAssessments > 0 ? [] : agentFindings,
      };

      created.push(await this.createReport({ tenantId: input.tenantId, userId: input.agentId }, {
        agentType: current.agent_type,
        sourceRunId: current.source_run_id ?? undefined,
        supersedesReportId: current.id,
        revisionReason: 'Agent verified the profile against the rule catalog and initial findings.',
        profileId: current.profile_id ?? undefined,
        recordType: current.record_type ?? undefined,
        recordId: current.record_id ?? undefined,
        sourceSystem: current.source_system ?? undefined,
        sourceVersion: current.source_version ?? undefined,
        sourceUpdatedAt: current.source_updated_at?.toISOString?.() ?? undefined,
        recordFingerprint: current.record_fingerprint ?? undefined,
        creatorName: input.agentName,
        creatorPublicKey: process.env.AGENT_REPORT_CREATOR_PUBLIC_KEY,
        resultStatus,
        severity: current.severity ?? ComplianceSeverityDto.MEDIUM,
        ruleSetVersion: current.rule_set_version,
        summary: failedAssessments > 0
          ? `Agent review failed validation for ${failedAssessments} finding(s); deterministic findings remain authoritative.`
          : typeof input.response.summary === 'string' ? input.response.summary : current.summary,
        scope: current.scope ?? {},
        reportStatus: failedAssessments > 0 ? 'AGENT_REVIEW' : 'PENDING_REVIEW',
        report: { ...(current.report_json ?? {}), agentReview: review },
        findings,
        sourceData: current.source_data ?? {},
        requiresApproval: true,
      } as any));
    }
    return created;
  }

  /**
   * Test-only cleanup used by profile compliance runs. Scope is deliberately
   * limited to one tenant, agent family, record type, and fetched record IDs.
   * HCS history is immutable and is not removed by this operation.
   */
  async resetReportsForRecords(
    tenantId: string,
    agentType: string,
    recordType: string,
    recordIds: string[],
  ): Promise<number> {
    if (!recordIds.length) return 0;
    const result = await this.db.query(
      `DELETE FROM compliance_reports
       WHERE tenant_id = $1
         AND agent_type = $2
         AND record_type = $3
         AND record_id = ANY($4::text[])`,
      [tenantId, agentType, recordType, recordIds],
    );
    return result.rowCount ?? 0;
  }

  async createReport(tenant: TenantContext, dto: CreateComplianceReportDto) {
    const reportJson = dto.report ?? {};
    const sourceData = dto.sourceData ?? {};
    const evidenceDigest = dto.evidenceDigest ?? digest(dto.findings ?? []);
    const sourceDataDigest = dto.sourceDataDigest ?? digest(sourceData);
    const recordId = dto.recordId ?? (dto.profileId ?? null);
    const recordFingerprint = dto.recordFingerprint ?? (recordId ? digest({
      recordType: dto.recordType ?? 'PROFILE',
      recordId,
      sourceVersion: dto.sourceVersion ?? null,
      sourceUpdatedAt: dto.sourceUpdatedAt ?? null,
      sourceDataDigest,
    }) : null);
    const issueFingerprint = dto.issueFingerprint ?? digest({
      tenantId: tenant.tenantId,
      agentType: dto.agentType,
      profileId: dto.profileId ?? null,
      recordType: dto.recordType ?? null,
      recordId,
      sourceSystem: dto.sourceSystem ?? null,
      recordFingerprint,
      resultStatus: dto.resultStatus,
      findings: dto.findings ?? [],
    });
    const reportDigest = digest({
      agentType: dto.agentType,
      profileId: dto.profileId ?? null,
      resultStatus: dto.resultStatus,
      severity: dto.severity ?? 'INFO',
      ruleSetVersion: dto.ruleSetVersion,
      summary: dto.summary,
      scope: dto.scope ?? {},
      report: reportJson,
      evidenceDigest,
      sourceDataDigest,
      recordType: dto.recordType ?? null,
      recordId,
      sourceSystem: dto.sourceSystem ?? null,
      sourceVersion: dto.sourceVersion ?? null,
      recordFingerprint,
      supersedesReportId: dto.supersedesReportId ?? null,
      revisionReason: dto.revisionReason ?? null,
    });
    const requiredFindingCount = (dto.findings ?? []).filter(
      (finding) => finding.requiresResolution !== false,
    ).length;
    const initialReviewPolicy = {
      mode: requiredFindingCount > 0 ? 'RESOLUTION_REQUIRED' : 'DIRECT_APPROVAL',
      requiresUserAction: true,
      requiresFindingResolution: requiredFindingCount > 0,
      openRequiredFindings: requiredFindingCount,
    };

    const report = await this.db.transaction(async (client) => {
      let parent: any = null;
      if (dto.supersedesReportId) {
        parent = await this.assertReport(client, tenant.tenantId, dto.supersedesReportId);
      } else {
        const existing = await client.query(
          `SELECT * FROM compliance_reports
           WHERE tenant_id = $1 AND issue_fingerprint = $2
           ORDER BY report_version DESC LIMIT 1`,
          [tenant.tenantId, issueFingerprint],
        );
        if (existing.rowCount) {
          return this.getReportWithClient(client, tenant.tenantId, existing.rows[0].id);
        }
      }

      const reportResult = await client.query(
        `INSERT INTO compliance_reports
          (tenant_id, agent_type, source_run_id, profile_id, status, result_status, severity,
           rule_set_version, issue_fingerprint, source_data_digest, source_data, report_digest, evidence_digest,
           summary, scope, report_json, requires_approval, creator_id, creator_name, creator_public_key,
           report_version, supersedes_report_id, revision_reason, review_policy,
           record_type, record_id, source_system, source_version, source_updated_at, record_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
         RETURNING *`,
        [
          tenant.tenantId,
          dto.agentType,
          dto.sourceRunId ?? null,
          dto.profileId ?? null,
          dto.reportStatus ?? (dto.requiresApproval === false && dto.resultStatus === 'PASS' ? 'REPORT_READY' : 'PENDING_REVIEW'),
          dto.resultStatus,
          dto.severity ?? 'INFO',
          dto.ruleSetVersion,
          issueFingerprint,
          sourceDataDigest,
          sourceData,
          reportDigest,
          evidenceDigest,
          dto.summary,
          dto.scope ?? {},
          reportJson,
          dto.requiresApproval !== false,
          tenant.userId,
          dto.creatorName ?? null,
          dto.creatorPublicKey ?? null,
          parent ? Number(parent.report_version) + 1 : 1,
          parent?.id ?? null,
          dto.revisionReason ?? null,
          initialReviewPolicy,
          dto.recordType ?? null,
          recordId,
          dto.sourceSystem ?? null,
          dto.sourceVersion ?? null,
          dto.sourceUpdatedAt ? new Date(dto.sourceUpdatedAt) : null,
          recordFingerprint,
        ],
      );
      const report = reportResult.rows[0];

      for (const finding of dto.findings ?? []) {
        await client.query(
          `INSERT INTO compliance_findings
            (tenant_id, report_id, rule_id, status, severity, title, comment, recommendation, evidence, requires_resolution)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            tenant.tenantId,
            report.id,
            finding.ruleId,
            finding.status ?? 'OPEN',
            finding.severity ?? 'MEDIUM',
            finding.title,
            finding.comment ?? null,
            finding.recommendation ?? null,
            {
              ...(finding.evidence ?? {}),
              findingKey: (finding.evidence as any)?.findingKey ?? digest({ recordId, ruleId: finding.ruleId, field: finding.field ?? null }),
            },
            finding.requiresResolution !== false,
          ],
        );
      }

      await this.appendAction(client, tenant, report.id, null, 'REPORT_CREATED', null, {
        resultStatus: dto.resultStatus,
          issueFingerprint,
          recordType: dto.recordType ?? null,
          recordId,
          sourceSystem: dto.sourceSystem ?? null,
          sourceVersion: dto.sourceVersion ?? null,
          recordFingerprint,
        reportDigest,
        creator: {
          id: report.creator_id,
          name: report.creator_name,
          publicKey: report.creator_public_key,
        },
      });
      await client.query(
        `INSERT INTO compliance_attestations
          (tenant_id, report_id, attestation_type, status, payload_digest, payload)
         VALUES ($1,$2,'REPORT_CREATED','PREPARED',$3,$4)`,
        [tenant.tenantId, report.id, reportDigest, {
          version: 1,
          reportId: report.id,
          reportVersion: report.report_version,
          reportType: report.agent_type,
          profileId: report.profile_id,
          status: report.status,
          resultStatus: report.result_status,
          severity: report.severity,
          issueFingerprint: report.issue_fingerprint,
          reportDigest,
          evidenceDigest,
          recordType: report.record_type,
          recordId: report.record_id,
          sourceSystem: report.source_system,
          sourceVersion: report.source_version,
          sourceUpdatedAt: report.source_updated_at,
          recordFingerprint: report.record_fingerprint,
          supersedesReportId: report.supersedes_report_id,
          revisionReason: report.revision_reason,
          creator: {
            id: report.creator_id,
            name: report.creator_name,
            publicKey: report.creator_public_key,
          },
        }],
      );
      return this.getReportWithClient(client, tenant.tenantId, report.id);
    });
    if (this.hcs.isConfigured()) {
      await this.hcs.submitReportCreated(tenant.tenantId, report.id);
      return this.getReport(tenant.tenantId, report.id);
    }
    return report;
  }

  async seedDemoReports(tenant: TenantContext, count: number) {
    if (process.env.COMPLIANCE_DEMO_ENABLED !== 'true') {
      throw new ConflictException('Compliance demo generation is disabled');
    }

    // Keep demo runs repeatable without touching real agent reports. Child
    // findings, actions, decisions, and attestations cascade from the report.
    await this.db.query(
      `DELETE FROM compliance_reports
       WHERE tenant_id = $1
         AND (
           scope->>'source' = 'demo-seed'
           OR report_json->>'generatedBy' = 'compliance-demo-seed'
         )`,
      [tenant.tenantId],
    );

    const reports: Array<Record<string, unknown>> = [];
    const demoAgentTypes = [
      'SERIAL_NUMBER_PROFILE',
      'SERIAL_NUMBER_ISSUE',
      'LOT_COMPLIANCE',
      'AUDIT_LOG_ANALYSIS',
      'SHORTAGE_ANALYSIS',
      'RECALL_ANALYSIS',
    ];
    for (let index = 0; index < count; index += 1) {
      const resultStatus: ComplianceResultStatusDto = index % 3 === 0
        ? ComplianceResultStatusDto.FAIL
        : index % 3 === 1
          ? ComplianceResultStatusDto.REVIEW
          : ComplianceResultStatusDto.PASS;
      const report = await this.createReport(tenant, {
        agentType: demoAgentTypes[index % demoAgentTypes.length],
        profileId: randomUUID(),
        creatorName: `Demo Reviewer ${index + 1}`,
        creatorPublicKey: `demo-public-key-${index + 1}`,
        resultStatus,
        severity: resultStatus === ComplianceResultStatusDto.FAIL
          ? ComplianceSeverityDto.HIGH
          : resultStatus === ComplianceResultStatusDto.REVIEW
            ? ComplianceSeverityDto.MEDIUM
            : ComplianceSeverityDto.INFO,
        ruleSetVersion: 'demo-gs1-1.0',
        summary: resultStatus === 'PASS'
          ? 'Demo report passed all configured checks.'
          : resultStatus === 'FAIL'
            ? 'Demo report contains a failed validation rule.'
            : 'Demo report requires reviewer attention.',
        scope: { source: 'demo-seed', sampleNumber: index + 1 },
        report: { sample: true, generatedBy: 'compliance-demo-seed' },
        findings: resultStatus === ComplianceResultStatusDto.PASS ? [] : [{
          ruleId: resultStatus === 'FAIL' ? 'DEMO-GS1-001' : 'DEMO-GS1-002',
          requiresResolution: resultStatus === 'FAIL',
          severity: resultStatus === ComplianceResultStatusDto.FAIL ? ComplianceSeverityDto.HIGH : ComplianceSeverityDto.MEDIUM,
          title: resultStatus === ComplianceResultStatusDto.FAIL ? 'Demo profile does not match the rule' : 'Demo profile needs review',
          recommendation: resultStatus === 'FAIL'
            ? 'Correct the profile values or explicitly override this finding.'
            : 'Review the profile values; this informational finding does not block approval.',
          evidence: { sampleNumber: index + 1 },
        }],
        requiresApproval: resultStatus !== 'PASS',
      });
      const demoFindingId = report.findings?.[0]?.id as string | undefined;
      if (index === 3 && demoFindingId) {
        await this.commentFinding(tenant, report.id, demoFindingId, {
          comment: 'Demo reviewer added a comment and requested human follow-up.',
          idempotencyKey: `demo-human-review-${report.id}`,
        });
      } else if (index === 4 && demoFindingId) {
        await this.overrideFinding(tenant, report.id, demoFindingId, {
          comment: 'Demo reviewer accepted this finding as an approved exception; agent review is required.',
          idempotencyKey: `demo-agent-review-override-${report.id}`,
        });
      } else if (index === 5) {
        await this.decide(tenant, report.id, 'REJECTED', {
          comment: 'Demo reviewer rejected this report and requested agent re-analysis.',
          idempotencyKey: `demo-agent-review-reject-${report.id}`,
        });
      }
      const submittedReport = await this.getReport(tenant.tenantId, report.id);
      const reportCreatedAttestation = submittedReport.attestations?.find(
        (item: any) => item.attestation_type === 'REPORT_CREATED',
      );
      reports.push({
        id: submittedReport.id,
        agentType: submittedReport.agent_type,
        status: submittedReport.status,
        resultStatus: submittedReport.result_status,
        reportDigest: submittedReport.report_digest,
        creator: {
          id: submittedReport.creator_id,
          name: submittedReport.creator_name,
          publicKey: submittedReport.creator_public_key,
        },
        agent: reportCreatedAttestation?.payload?.agent ?? null,
        attestation: reportCreatedAttestation,
        hcs: reportCreatedAttestation ? {
          attestationType: reportCreatedAttestation.attestation_type,
          status: reportCreatedAttestation.status,
          topicId: reportCreatedAttestation.topic_id,
          transactionId: reportCreatedAttestation.transaction_id,
          sequenceNumber: reportCreatedAttestation.sequence_number,
          consensusTimestamp: reportCreatedAttestation.consensus_timestamp,
        } : null,
        hcsPayload: reportCreatedAttestation?.payload,
      });
    }
    return { created: reports.length, reports };
  }

  async listReports(tenantId: string, filters: ReportFilters) {
    const values: unknown[] = [tenantId];
    // A report revision chain is one logical report. Normal list consumers
    // should see only the current revision; superseded revisions remain
    // addressable by ID for audit/history views.
    const where = [
      'r.tenant_id = $1',
      `NOT EXISTS (
         SELECT 1
         FROM compliance_reports newer_report
         WHERE newer_report.tenant_id = r.tenant_id
           AND newer_report.supersedes_report_id = r.id
       )`,
      // The revision link is authoritative, but older deployments could
      // create the reviewed row without it. Collapse those rows as well so
      // the normal UI list exposes one current report per source record.
      `(
        r.record_id IS NULL OR NOT EXISTS (
          SELECT 1
          FROM compliance_reports newer_record_report
          WHERE newer_record_report.tenant_id = r.tenant_id
            AND newer_record_report.agent_type = r.agent_type
            AND newer_record_report.record_type IS NOT DISTINCT FROM r.record_type
            AND newer_record_report.record_id = r.record_id
            AND (
              newer_record_report.created_at > r.created_at
              OR (
                newer_record_report.created_at = r.created_at
                AND newer_record_report.id > r.id
              )
            )
        )
      )`,
    ];
    if (filters.status) { values.push(filters.status); where.push(`r.status = $${values.length}`); }
    if (filters.agentType) { values.push(filters.agentType); where.push(`r.agent_type = $${values.length}`); }
    if (filters.resultStatus) { values.push(filters.resultStatus); where.push(`r.result_status = $${values.length}`); }
    if (filters.recordType) { values.push(filters.recordType); where.push(`r.record_type = $${values.length}`); }
    if (filters.recordId) { values.push(filters.recordId); where.push(`r.record_id = $${values.length}`); }
    if (filters.sourceSystem) { values.push(filters.sourceSystem); where.push(`r.source_system = $${values.length}`); }
    const dataValues = [...values, filters.limit, filters.offset];
    const countValues = [...values];
    const [result, countResult] = await Promise.all([
      this.db.query(
      `SELECT r.*, hcs.report_created_attestation,
          COUNT(f.id)::int AS finding_count,
          COUNT(f.id) FILTER (WHERE f.status IN ('OPEN','ACKNOWLEDGED','REMEDIATION_IN_PROGRESS'))::int AS open_finding_count,
          COUNT(f.id) FILTER (WHERE f.requires_resolution = TRUE
            AND f.status IN ('OPEN','ACKNOWLEDGED','REMEDIATION_IN_PROGRESS'))::int AS open_required_finding_count
       FROM compliance_reports r
       LEFT JOIN compliance_findings f ON f.report_id = r.id
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'id', a.id,
           'status', a.status,
           'attestationType', a.attestation_type,
           'topicId', a.topic_id,
           'transactionId', a.transaction_id,
           'sequenceNumber', a.sequence_number,
           'consensusTimestamp', a.consensus_timestamp,
           'lastError', a.last_error,
           'preparedAt', a.prepared_at,
           'submittedAt', a.submitted_at,
           'confirmedAt', a.confirmed_at
         ) AS report_created_attestation
         FROM compliance_attestations a
         WHERE a.tenant_id = r.tenant_id
           AND a.report_id = r.id
           AND a.attestation_type = 'REPORT_CREATED'
         ORDER BY a.prepared_at DESC
         LIMIT 1
       ) hcs ON TRUE
       WHERE ${where.join(' AND ')}
       GROUP BY r.id, hcs.report_created_attestation
       ORDER BY r.created_at DESC LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
      dataValues,
      ),
      this.db.query(
        `SELECT COUNT(*)::int AS total FROM compliance_reports r WHERE ${where.join(' AND ')}`,
        countValues,
      ),
    ]);
    const total = countResult.rows[0]?.total ?? 0;
    return {
      items: result.rows.map((row: any) => ({
        ...row,
        hcs: row.report_created_attestation ?? null,
        hcsStatus: row.report_created_attestation?.status ?? 'NOT_PREPARED',
        record: row.record_type && row.record_id ? {
          type: row.record_type,
          id: row.record_id,
          sourceSystem: row.source_system,
          sourceVersion: row.source_version,
          sourceUpdatedAt: row.source_updated_at,
          fingerprint: row.record_fingerprint,
        } : null,
        review_policy: buildReviewPolicy(
          row,
          Array.from({ length: Number(row.open_required_finding_count ?? 0) }, () => ({
            requires_resolution: true,
            status: 'OPEN',
          })),
        ),
        reviewPolicy: buildReviewPolicy(
          row,
          Array.from({ length: Number(row.open_required_finding_count ?? 0) }, () => ({
            requires_resolution: true,
            status: 'OPEN',
          })),
        ),
      })),
      // Keep these fields for clients using the previous response shape.
      limit: filters.limit,
      offset: filters.offset,
      pagination: {
        limit: filters.limit,
        offset: filters.offset,
        total,
        hasMore: filters.offset + result.rows.length < total,
      },
    };
  }

  /**
   * Returns the latest workflow status for source records before an agent
   * spends tokens validating them again. AGENT_REVIEW is intentionally not
   * filtered out: it means a human returned the record to the agent queue.
   */
  async findLatestReportStatuses(
    tenantId: string,
    agentType: string,
    recordType: string,
    recordIds: string[],
  ): Promise<Map<string, string>> {
    if (!recordIds.length) return new Map();
    const result = await this.db.query<{ record_id: string; status: string }>(
      `SELECT DISTINCT ON (record_id) record_id, status
       FROM compliance_reports
       WHERE tenant_id = $1
         AND agent_type = $2
         AND record_type = $3
         AND record_id = ANY($4::text[])
       ORDER BY record_id, report_version DESC, created_at DESC`,
      [tenantId, agentType, recordType, recordIds],
    );
    return new Map(result.rows.map((row) => [row.record_id, row.status]));
  }

  async getReport(tenantId: string, reportId: string) {
    return this.db.transaction((client) => this.getReportWithClient(client, tenantId, reportId));
  }

  async commentFinding(tenant: TenantContext, reportId: string, findingId: string, dto: ReportCommentDto) {
    return this.updateFinding(tenant, reportId, findingId, 'ACKNOWLEDGED', dto.comment, 'COMMENT', dto.idempotencyKey);
  }

  async commentReport(tenant: TenantContext, reportId: string, dto: ReportCommentDto) {
    return this.db.transaction(async (client) => {
      await this.assertReport(client, tenant.tenantId, reportId);
      const action = await this.appendAction(
        client,
        tenant,
        reportId,
        null,
        'COMMENT',
        dto.comment,
        { scope: 'REPORT' },
        dto.idempotencyKey,
      );
      await client.query(
        `UPDATE compliance_reports SET status = 'HUMAN_REVIEW', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status IN ('PENDING_REVIEW','REPORT_READY','HUMAN_REVIEW')`,
        [reportId, tenant.tenantId],
      );
      const attestation = await this.createCommentAttestation(client, tenant.tenantId, reportId, action);
      return {
        commentId: action.id,
        action,
        attestation,
        report: await this.getReportWithClient(client, tenant.tenantId, reportId),
      };
    });
  }

  async resolveFinding(tenant: TenantContext, reportId: string, findingId: string, dto: FindingResolutionDto) {
    return this.updateFinding(tenant, reportId, findingId, 'RESOLVED', dto.comment, 'RESOLVE_FINDING', dto.idempotencyKey);
  }

  async overrideFinding(tenant: TenantContext, reportId: string, findingId: string, dto: FindingResolutionDto) {
    return this.updateFinding(tenant, reportId, findingId, 'OVERRIDDEN', dto.comment, 'OVERRIDE_FINDING', dto.idempotencyKey);
  }

  private async updateFinding(
    tenant: TenantContext,
    reportId: string,
    findingId: string,
    status: string,
    comment: string,
    actionType: string,
    idempotencyKey?: string,
  ) {
    return this.db.transaction(async (client) => {
      const finding = await client.query(
        `UPDATE compliance_findings SET status = $1::varchar(40), comment = $2,
           resolved_by = CASE WHEN $1::text IN ('RESOLVED','OVERRIDDEN') THEN $3 ELSE resolved_by END,
           resolved_at = CASE WHEN $1::text IN ('RESOLVED','OVERRIDDEN') THEN NOW() ELSE resolved_at END,
           updated_at = NOW()
         WHERE id = $4 AND report_id = $5 AND tenant_id = $6 RETURNING *`,
        [status, comment, tenant.userId, findingId, reportId, tenant.tenantId],
      );
      if (!finding.rowCount) throw new NotFoundException('Finding was not found for this report');
      const report = await this.assertReport(client, tenant.tenantId, reportId);
      const action = await this.appendAction(client, tenant, reportId, findingId, actionType, comment, {}, idempotencyKey);
      const actionAttestation = ['COMMENT', 'RESOLVE_FINDING', 'OVERRIDE_FINDING'].includes(actionType)
        ? await this.createCommentAttestation(client, tenant.tenantId, reportId, action)
        : null;
      if (['RESOLVED', 'OVERRIDDEN'].includes(status)) {
        const openRequired = await client.query(
          `SELECT COUNT(*)::int AS count FROM compliance_findings
           WHERE report_id = $1 AND tenant_id = $2 AND requires_resolution = TRUE
             AND status IN ('OPEN','ACKNOWLEDGED','REMEDIATION_IN_PROGRESS')`,
          [reportId, tenant.tenantId],
        );
        if (Number(openRequired.rows[0].count) === 0 &&
            ['PENDING_REVIEW', 'HUMAN_REVIEW', 'REPORT_READY'].includes(report.status) &&
            status === 'RESOLVED') {
          const approvedStatus = 'APPROVED';
          await client.query(
            `UPDATE compliance_reports SET status = $1, approved_by = $2,
             approved_at = NOW(), updated_at = NOW()
             WHERE id = $3 AND tenant_id = $4`,
            [approvedStatus, tenant.userId, reportId, tenant.tenantId],
          );
          const decisionDigest = digest({
            reportId,
            reportVersion: report.report_version,
            decision: approvedStatus,
            actorId: tenant.userId,
            comment,
          });
          await client.query(
            `INSERT INTO compliance_decisions
              (tenant_id, report_id, report_version, decision, actor_id, comment, decision_digest)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [tenant.tenantId, reportId, report.report_version, approvedStatus, tenant.userId, comment, decisionDigest],
          );
          const approvalAction = await this.appendAction(
            client,
            tenant,
            reportId,
            null,
            'APPROVED',
            comment,
            { automatic: true, triggeredBy: action.id },
          );
          await this.createCommentAttestation(client, tenant.tenantId, reportId, approvalAction, 'DECISION');
        } else if (status === 'OVERRIDDEN') {
          await client.query(
            `UPDATE compliance_reports SET status = 'AGENT_REVIEW', updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [reportId, tenant.tenantId],
          );
        } else if (status === 'RESOLVED') {
          await client.query(
            `UPDATE compliance_reports SET status = 'HUMAN_REVIEW', updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [reportId, tenant.tenantId],
          );
        }
      } else if (actionType === 'COMMENT') {
        await client.query(
          `UPDATE compliance_reports SET status = 'HUMAN_REVIEW', updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2 AND status IN ('PENDING_REVIEW','REPORT_READY','HUMAN_REVIEW')`,
          [reportId, tenant.tenantId],
        );
      }
      const updatedReport = await this.getReportWithClient(client, tenant.tenantId, reportId);
      return {
        ...updatedReport,
        commentId: actionType === 'COMMENT' ? action.id : undefined,
        action,
        actionAttestation,
      };
    });
  }

  async decide(tenant: TenantContext, reportId: string, decision: 'APPROVED' | 'REJECTED', dto: ReportDecisionDto) {
    return this.db.transaction(async (client) => {
      const report = await this.assertReport(client, tenant.tenantId, reportId);
      if (decision === 'APPROVED') {
        const open = await client.query(
          `SELECT COUNT(*)::int AS count FROM compliance_findings
           WHERE report_id = $1 AND tenant_id = $2 AND requires_resolution = TRUE
             AND status IN ('OPEN','ACKNOWLEDGED','REMEDIATION_IN_PROGRESS')`,
          [reportId, tenant.tenantId],
        );
        if (Number(open.rows[0].count) > 0 && report.result_status !== 'PASS') {
          throw new ConflictException('Resolve or explicitly override all open findings before approval');
        }
      }
      const status = decision === 'APPROVED' ? 'APPROVED' : 'AGENT_REVIEW';
      const updated = await client.query(
        `UPDATE compliance_reports SET status = $1::varchar(40),
           approved_by = CASE WHEN $1::text = 'APPROVED' THEN $2 ELSE approved_by END,
           approved_at = CASE WHEN $1::text = 'APPROVED' THEN NOW() ELSE approved_at END,
           rejected_by = CASE WHEN $1::text = 'AGENT_REVIEW' THEN $2 ELSE rejected_by END,
           rejected_at = CASE WHEN $1::text = 'AGENT_REVIEW' THEN NOW() ELSE rejected_at END,
           updated_at = NOW() WHERE id = $3 AND tenant_id = $4 RETURNING *`,
        [status, tenant.userId, reportId, tenant.tenantId],
      );
      const decisionDigest = digest({
        reportId,
        reportVersion: report.report_version,
        decision,
        comment: dto.comment ?? null,
        actorId: tenant.userId,
      });
      await client.query(
        `INSERT INTO compliance_decisions
          (tenant_id, report_id, report_version, decision, actor_id, comment, decision_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenant.tenantId, reportId, report.report_version, decision, tenant.userId, dto.comment ?? null, decisionDigest],
      );
      const action = await this.appendAction(client, tenant, reportId, null, decision, dto.comment, {}, dto.idempotencyKey);
      await this.createCommentAttestation(client, tenant.tenantId, reportId, action, 'DECISION');
      return this.getReportWithClient(client, tenant.tenantId, updated.rows[0].id);
    });
  }

  async agentReview(tenant: TenantContext, reportId: string, dto: AgentReviewDto) {
    const report = await this.getReport(tenant.tenantId, reportId);
    if (report.status !== 'AGENT_REVIEW') {
      throw new ConflictException('Report is not waiting for agent review');
    }

    const actionResult = await this.db.transaction(async (client) => {
      const current = await this.assertReport(client, tenant.tenantId, reportId);
      const action = await this.appendAction(
        client,
        tenant,
        reportId,
        null,
        dto.decision === 'AGREE' ? 'AGENT_AGREED' : 'AGENT_DISAGREED',
        dto.comment,
        { actorType: 'AGENT', revisionReason: dto.revisionReason ?? null },
        dto.idempotencyKey,
      );
      await this.createCommentAttestation(client, tenant.tenantId, reportId, action);
      if (dto.decision === 'AGREE') {
        await client.query(
          `UPDATE compliance_reports SET status = 'HUMAN_REVIEW', updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2`,
          [reportId, tenant.tenantId],
        );
      }
      return { current, action };
    });
    if (dto.decision === 'AGREE') {
      return {
        decision: 'AGREE',
        action: actionResult.action,
        hcs: null,
        report: await this.getReport(tenant.tenantId, reportId),
      };
    }

    const revised = await this.createReport(tenant, {
      agentType: report.agent_type,
      sourceRunId: report.source_run_id ?? undefined,
      supersedesReportId: reportId,
      revisionReason: dto.revisionReason ?? dto.comment,
      profileId: report.profile_id ?? undefined,
      creatorName: 'Compliance Review Agent',
      resultStatus: dto.resultStatus ?? report.result_status,
      ruleSetVersion: report.rule_set_version,
      summary: dto.summary ?? dto.comment,
      scope: report.scope ?? {},
      report: report.report_json ?? {},
      findings: dto.findings,
      requiresApproval: true,
    });
    return {
      decision: 'DISAGREE',
      action: actionResult.action,
      hcs: null,
      supersedesReportId: reportId,
      report: revised,
    };
  }

  async prepareAttestation(tenantId: string, reportId: string, payerAccountId?: string) {
    if (!payerAccountId) throw new ConflictException('payerAccountId is required for wallet preparation');
    try {
      AccountId.fromString(payerAccountId);
    } catch {
      throw new BadRequestException('payerAccountId must be a valid Hedera account ID');
    }
    return this.db.transaction(async (client) => {
      const report = await this.assertReport(client, tenantId, reportId);
      if (!['APPROVED', 'APPROVED_WITH_OVERRIDE', 'AGENT_REVIEW', 'READY_FOR_WALLET', 'SUBMITTED', 'ATTESTED'].includes(report.status)) {
        throw new ConflictException('Report must be approved or waiting for agent review before wallet preparation');
      }
      let result = await client.query(
        `SELECT * FROM compliance_attestations
         WHERE tenant_id = $1 AND report_id = $2 AND attestation_type = 'DECISION'
           AND status IN ('PREPARED','SUBMITTED','VERIFYING','WAITING_FOR_CONFIRMATION','CONFIRMED')
         ORDER BY prepared_at DESC LIMIT 1`,
        [tenantId, reportId],
      );
      const decision = await client.query(
        `SELECT decision, actor_id, created_at FROM compliance_decisions
         WHERE tenant_id = $1 AND report_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [tenantId, reportId],
      );

      // A submitted/confirmed approval is immutable. Never rebuild it or
      // silently prepare a second wallet message for the same report version.
      let attestation = result.rows[0];
      if (attestation && ['SUBMITTED', 'VERIFYING', 'WAITING_FOR_CONFIRMATION', 'CONFIRMED'].includes(attestation.status)) {
        return {
          report: await this.getReportWithClient(client, tenantId, reportId),
          attestation,
          payload: attestation.payload,
          message: attestation.message,
          payloadDigest: attestation.payload_digest,
          alreadyProcessed: true,
          alreadyPrepared: false,
        };
      }

      const history = await this.buildApprovalMerkleSnapshot(client, tenantId, reportId, report);
      const payload = {
        version: 1,
        type: 'COMPLIANCE_REPORT_APPROVED',
        reportId: report.id,
        reportVersion: report.report_version,
        reportDigest: report.report_digest,
        evidenceDigest: report.evidence_digest,
        historyMerkleRoot: history.historyMerkleRoot,
        findingStateRoot: history.findingStateRoot,
        actionCount: history.actionCount,
        approvedBy: decision.rows[0]?.actor_id ?? tenantId,
        approvedAt: decision.rows[0]?.created_at ?? new Date().toISOString(),
        decision: decision.rows[0]?.decision ?? 'APPROVED',
      };
      if (!result.rowCount) {
        const payloadDigest = digest(payload);
        result = await client.query(
          `INSERT INTO compliance_attestations
            (tenant_id, report_id, attestation_type, status, payload_digest, payload)
           VALUES ($1,$2,'DECISION','PREPARED',$3,$4) RETURNING *`,
          [tenantId, reportId, payloadDigest, payload],
        );
        attestation = result.rows[0];
      }
      // The connected wallet submits this exact canonical JSON string. The
      // backend never signs, freezes, or replaces it with a compact hash.
      const message = JSON.stringify(payload);
      if (Buffer.byteLength(message, 'utf8') > 1024) {
        throw new BadRequestException(`Compliance approval HCS message is ${Buffer.byteLength(message, 'utf8')} bytes; maximum is 1024 bytes`);
      }
      const messageDigest = createHash('sha256').update(message, 'utf8').digest('hex');
      const alreadyPrepared = Boolean(attestation?.payer_account_id === payerAccountId
        && attestation.topic_id === hederaTopicId()
        && attestation.payload_digest === messageDigest);
      if (!alreadyPrepared) {
        const refreshed = await client.query(
          `UPDATE compliance_attestations
           SET payload = $1, message = $2, payload_digest = $3, topic_id = $4,
               payer_account_id = $5, prepared_transaction_id = NULL,
               wallet_transaction_bytes = NULL, last_error = NULL,
               prepared_at = NOW()
          WHERE id = $6 AND tenant_id = $7 AND status = 'PREPARED'
           RETURNING *`,
          [payload, message, messageDigest, hederaTopicId(), payerAccountId, attestation.id, tenantId],
        );
        if (refreshed.rowCount) Object.assign(attestation, refreshed.rows[0]);
      }
      await client.query(`UPDATE compliance_reports SET status = 'READY_FOR_WALLET', updated_at = NOW() WHERE id = $1`, [reportId]);
      const updatedReport = await this.getReportWithClient(client, tenantId, reportId);
      return {
        report: updatedReport,
        attestation,
        payload: attestation.payload,
        payloadDigest: attestation.payload_digest,
        message,
        attestationId: attestation.id,
        payerAccountId,
        topicId: attestation.topic_id ?? hederaTopicId(),
        historyMerkleRoot: history.historyMerkleRoot,
        findingStateRoot: history.findingStateRoot,
        actionCount: history.actionCount,
        status: 'READY_FOR_WALLET',
        alreadyPrepared,
        alreadyProcessed: false,
      };
    });
  }

  async prepareCommentAttestation(tenantId: string, reportId: string, commentId: string, payerAccountId?: string) {
    return this.prepareActionAttestation(tenantId, reportId, commentId, payerAccountId);
  }

  async prepareActionAttestation(tenantId: string, reportId: string, actionId: string, payerAccountId?: string) {
    throw new ConflictException('Individual comments, finding resolutions, and overrides are not submitted to HCS. Approve the report to prepare one history snapshot.');
  }

  async recordCommentSubmission(tenantId: string, reportId: string, commentId: string, dto: AttestationSubmittedDto) {
    return this.recordActionSubmission(tenantId, reportId, commentId, dto);
  }

  /**
   * Prepare every pending user/agent action exactly once. This is intentionally
   * preparation only: the connected wallet still signs and submits each HCS
   * transaction, while already submitted/confirmed actions are returned as
   * skipped and are never prepared again.
   */
  async preparePendingActions(tenantId: string, reportId: string, payerAccountId?: string) {
    throw new ConflictException('Individual comments, finding resolutions, and overrides are not submitted to HCS. Approve the report to prepare one history snapshot.');
  }

  async recordActionSubmission(tenantId: string, reportId: string, actionId: string, dto: AttestationSubmittedDto) {
    const current = await this.db.one<any>(
      `SELECT * FROM compliance_attestations
       WHERE id = $1 AND action_event_id = $2 AND report_id = $3 AND tenant_id = $4`,
      [dto.attestationId, actionId, reportId, tenantId],
    );
    if (['SUBMITTED', 'VERIFYING', 'WAITING_FOR_CONFIRMATION', 'CONFIRMED'].includes(current.status)) {
      return {
        ...(await this.getReport(tenantId, reportId)),
        alreadySubmitted: true,
        actionAttestation: current,
      };
    }
    this.assertSubmissionMatchesPreparedPayer(current.payer_account_id, dto.transactionId, dto.topicId);
    const result = await this.db.query(
      `UPDATE compliance_attestations SET status = 'SUBMITTED', topic_id = $1,
         transaction_id = $2, sequence_number = $3, consensus_timestamp = $4,
         submitted_at = NOW(), last_error = NULL
       WHERE id = $5 AND action_event_id = $6 AND report_id = $7 AND tenant_id = $8
         AND status IN ('PREPARED','SUBMITTED')
       RETURNING *`,
      [dto.topicId, dto.transactionId, dto.sequenceNumber, dto.consensusTimestamp, dto.attestationId, actionId, reportId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundException('Prepared action attestation was not found');
    return {
      ...(await this.getReport(tenantId, reportId)),
      alreadySubmitted: false,
      actionAttestation: result.rows[0],
    };
  }

  async verifyComment(tenantId: string, reportId: string, commentId: string) {
    return this.verifyAction(tenantId, reportId, commentId);
  }

  async verifyAction(tenantId: string, reportId: string, actionId: string) {
    const result = await this.db.query(
      `SELECT * FROM compliance_attestations
       WHERE action_event_id = $1 AND report_id = $2 AND tenant_id = $3
         LIMIT 1`,
      [actionId, reportId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundException('Action attestation was not found');
    const attestation = result.rows[0];
    if (!attestation.transaction_id) return attestation;
    const mirror = await this.lookupMirrorTransaction(attestation.transaction_id);
    if (mirror?.result === 'SUCCESS' && mirror.consensus_timestamp) {
      return (await this.db.one<any>(
        `UPDATE compliance_attestations
         SET status = 'CONFIRMED', consensus_timestamp = $1, confirmed_at = NOW(), last_error = NULL
         WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [mirror.consensus_timestamp, attestation.id, tenantId],
      ));
    }
    return attestation;
  }

  async recordAttestationSubmission(tenantId: string, reportId: string, dto: AttestationSubmittedDto) {
    const prepared = dto.attestationId
      ? await this.db.one<any>(
        `SELECT * FROM compliance_attestations
         WHERE id = $1 AND report_id = $2 AND tenant_id = $3`,
        [dto.attestationId, reportId, tenantId],
      )
      : await this.db.one<any>(
        `SELECT * FROM compliance_attestations
         WHERE report_id = $1 AND tenant_id = $2 AND attestation_type = 'DECISION'
           AND status IN ('PREPARED','SUBMITTED','VERIFYING')
         ORDER BY prepared_at DESC LIMIT 1`,
        [reportId, tenantId],
      );
    this.assertSubmissionMatchesPreparedPayer(prepared.payer_account_id, dto.transactionId, dto.topicId);
    const result = dto.attestationId
      ? await this.db.query(
        `UPDATE compliance_attestations SET status = 'SUBMITTED', topic_id = $1, transaction_id = $2,
           sequence_number = $3, consensus_timestamp = $4, submitted_at = NOW()
         WHERE id = $5 AND report_id = $6 AND tenant_id = $7 AND status IN ('PREPARED','SUBMITTED','VERIFYING')
         RETURNING *`,
        [dto.topicId, dto.transactionId, dto.sequenceNumber, dto.consensusTimestamp, dto.attestationId, reportId, tenantId],
      )
      : await this.db.query(
        `UPDATE compliance_attestations SET status = 'SUBMITTED', topic_id = $1, transaction_id = $2,
           sequence_number = $3, consensus_timestamp = $4, submitted_at = NOW()
         WHERE report_id = $5 AND tenant_id = $6 AND attestation_type = 'DECISION'
           AND status IN ('PREPARED','SUBMITTED','VERIFYING') RETURNING *`,
        [dto.topicId, dto.transactionId, dto.sequenceNumber, dto.consensusTimestamp, reportId, tenantId],
      );
    if (!result.rowCount) throw new NotFoundException('Prepared report attestation was not found');
    await this.db.query(`UPDATE compliance_attestations SET status = 'VERIFYING' WHERE id = $1 AND tenant_id = $2 AND status = 'SUBMITTED'`, [result.rows[0].id, tenantId]);
    await this.db.query(`UPDATE compliance_reports SET status = 'VERIFYING', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`, [reportId, tenantId]);
    return this.getReport(tenantId, reportId);
  }

  async getVerificationState(tenantId: string, reportId: string) {
    const report = await this.getReport(tenantId, reportId);
    for (const attestation of report.attestations ?? []) {
      if (!attestation.transaction_id || !['SUBMITTED', 'VERIFYING', 'WAITING_FOR_CONFIRMATION'].includes(attestation.status)) continue;
      const mirror = await this.lookupMirrorTransaction(attestation.transaction_id);
      if (mirror?.result === 'SUCCESS'
        && mirror.entity_id === (attestation.topic_id ?? hederaTopicId())
        && mirror.consensus_timestamp) {
        const mirrorPayload = await this.lookupMirrorTopicMessage(
          attestation.topic_id ?? hederaTopicId(),
          attestation.sequence_number,
        );
        // Do not attest a transaction merely because it succeeded. The
        // immutable HCS message must be the exact prepared report payload.
        if (!mirrorPayload) continue;
        const expectedMessage = String(attestation.message ?? '');
        if (!expectedMessage || mirrorPayload !== expectedMessage) {
          await this.db.query(
            `UPDATE compliance_attestations
             SET status = 'FAILED', last_error = $1
             WHERE id = $2 AND tenant_id = $3`,
            ['HCS message does not match the prepared compliance report payload', attestation.id, tenantId],
          );
          await this.db.query(
            `UPDATE compliance_reports SET status = 'VERIFICATION_FAILED', updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [reportId, tenantId],
          );
          continue;
        }
        await this.db.query(
          `UPDATE compliance_attestations
           SET status = 'CONFIRMED', consensus_timestamp = $1, confirmed_at = NOW(), last_error = NULL
           WHERE id = $2 AND tenant_id = $3`,
          [mirror.consensus_timestamp, attestation.id, tenantId],
        );
        if (attestation.attestation_type === 'DECISION') {
          await this.db.query(
            `UPDATE compliance_reports SET status = 'ATTESTED', updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2 AND status IN ('SUBMITTED','VERIFYING','READY_FOR_WALLET')`,
            [reportId, tenantId],
          );
        }
      }
    }
    const refreshed = await this.getReport(tenantId, reportId);
    return {
      reportId,
      reportStatus: refreshed.status,
      reportDigest: refreshed.report_digest,
      attestations: refreshed.attestations,
      verified: refreshed.status === 'ATTESTED' || refreshed.attestations.some((item: any) => item.status === 'CONFIRMED'),
    };
  }

  private async assertReport(client: PoolClient, tenantId: string, reportId: string) {
    const result = await client.query('SELECT * FROM compliance_reports WHERE id = $1 AND tenant_id = $2', [reportId, tenantId]);
    if (!result.rowCount) throw new NotFoundException('Compliance report was not found');
    return result.rows[0];
  }

  private async getReportWithClient(client: PoolClient, tenantId: string, reportId: string) {
    const report = await this.assertReport(client, tenantId, reportId);
      const [findings, actions, decisions, attestations] = await Promise.all([
      client.query('SELECT * FROM compliance_findings WHERE report_id = $1 AND tenant_id = $2 ORDER BY created_at', [reportId, tenantId]),
      client.query('SELECT * FROM compliance_action_events WHERE report_id = $1 AND tenant_id = $2 ORDER BY created_at DESC', [reportId, tenantId]),
      client.query('SELECT * FROM compliance_decisions WHERE report_id = $1 AND tenant_id = $2 ORDER BY created_at DESC', [reportId, tenantId]),
      client.query('SELECT * FROM compliance_attestations WHERE report_id = $1 AND tenant_id = $2 ORDER BY prepared_at DESC', [reportId, tenantId]),
      ]);
      return {
      ...report,
      record: report.record_type && report.record_id ? {
        type: report.record_type,
        id: report.record_id,
        sourceSystem: report.source_system,
        sourceVersion: report.source_version,
        sourceUpdatedAt: report.source_updated_at,
        fingerprint: report.record_fingerprint,
      } : null,
      findings: findings.rows,
      actions: actions.rows,
      decisions: decisions.rows,
      attestations: attestations.rows,
      review_policy: buildReviewPolicy(report, findings.rows),
      reviewPolicy: buildReviewPolicy(report, findings.rows),
    };
  }

  private async appendAction(
    client: PoolClient,
    tenant: TenantContext,
    reportId: string,
    findingId: string | null,
    actionType: string,
    comment: string | null | undefined,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    const inserted = await client.query(
      `INSERT INTO compliance_action_events
        (tenant_id, report_id, finding_id, action_type, actor_id, comment, payload, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [tenant.tenantId, reportId, findingId, actionType, tenant.userId, comment ?? null, payload, idempotencyKey ?? null],
    );
    if (inserted.rowCount) return inserted.rows[0];
    const existing = await client.query(
      `SELECT * FROM compliance_action_events
       WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [tenant.tenantId, idempotencyKey],
    );
    return existing.rows[0];
  }

  private async createCommentAttestation(
    client: PoolClient,
    tenantId: string,
    reportId: string,
    action: any,
    attestationType: 'REPORT_COMMENT' | 'DECISION' = 'REPORT_COMMENT',
  ) {
    const result = await client.query(
      `SELECT * FROM compliance_attestations WHERE action_event_id = $1 AND tenant_id = $2 LIMIT 1`,
      [action.id, tenantId],
    );
    if (result.rowCount) return result.rows[0];
    const report = await this.assertReport(client, tenantId, reportId);
    const payload = {
      version: 1,
      attestationType,
      reportId,
      reportVersion: report.report_version,
      reportDigest: report.report_digest,
      actionId: action.id,
      actionType: action.action_type,
      findingId: action.finding_id,
      comment: action.comment,
      actorId: action.actor_id,
      actionPayload: action.payload ?? {},
      createdAt: action.created_at,
    };
    return (await client.query(
      `INSERT INTO compliance_attestations
        (tenant_id, report_id, action_event_id, attestation_type, status, payload_digest, payload)
       VALUES ($1,$2,$3,$4,'PREPARED',$5,$6) RETURNING *`,
      [tenantId, reportId, action.id, attestationType, digest(payload), payload],
    )).rows[0];
  }

  private async buildApprovalMerkleSnapshot(
    client: PoolClient,
    tenantId: string,
    reportId: string,
    report: any,
  ) {
    // A PoolClient cannot execute multiple queries concurrently. Keep these
    // reads sequential so report preparation does not trigger pg's
    // "client.query() when already executing" warning.
    const actions = await client.query(
      `SELECT id, action_type, finding_id, actor_id, comment, payload, idempotency_key, created_at
       FROM compliance_action_events
       WHERE tenant_id = $1 AND report_id = $2 ORDER BY created_at, id`,
      [tenantId, reportId],
    );
    const decisions = await client.query(
      `SELECT id, report_version, decision, actor_id, comment, decision_digest, created_at
       FROM compliance_decisions
       WHERE tenant_id = $1 AND report_id = $2 ORDER BY created_at, id`,
      [tenantId, reportId],
    );
    const findings = await client.query(
      `SELECT id, rule_id, status, requires_resolution, severity, title, comment,
              recommendation, evidence, resolved_by, resolved_at, updated_at
       FROM compliance_findings
       WHERE tenant_id = $1 AND report_id = $2 ORDER BY id`,
      [tenantId, reportId],
    );

    const leaves: MerkleLeaf[] = [{
      leafType: 'REPORT',
      sourceId: report.id,
      payload: {
        type: 'REPORT',
        reportId: report.id,
        reportVersion: report.report_version,
        reportDigest: report.report_digest,
        evidenceDigest: report.evidence_digest,
        status: report.status,
        resultStatus: report.result_status,
      },
    }];

    const findingLeaves = findings.rows.map((finding) => ({
      leafType: 'FINDING',
      sourceId: finding.id,
      payload: {
        type: 'FINDING',
        id: finding.id,
        ruleId: finding.rule_id,
        status: finding.status,
        requiresResolution: finding.requires_resolution,
        severity: finding.severity,
        title: finding.title,
        comment: finding.comment,
        recommendation: finding.recommendation,
        evidence: finding.evidence,
        resolvedBy: finding.resolved_by,
        resolvedAt: finding.resolved_at,
        updatedAt: finding.updated_at,
      },
    } satisfies MerkleLeaf));
    leaves.push(...findingLeaves);

    leaves.push(...actions.rows.map((action) => ({
      leafType: 'ACTION',
      sourceId: action.id,
      payload: {
        type: 'ACTION',
        id: action.id,
        actionType: action.action_type,
        findingId: action.finding_id,
        actorId: action.actor_id,
        comment: action.comment,
        payloadDigest: digest(action.payload ?? {}),
        idempotencyKey: action.idempotency_key,
        createdAt: action.created_at,
      },
    } satisfies MerkleLeaf)));

    leaves.push(...decisions.rows.map((decision) => ({
      leafType: 'DECISION',
      sourceId: decision.id,
      payload: {
        type: 'DECISION',
        id: decision.id,
        reportVersion: decision.report_version,
        decision: decision.decision,
        actorId: decision.actor_id,
        comment: decision.comment,
        decisionDigest: decision.decision_digest,
        createdAt: decision.created_at,
      },
    } satisfies MerkleLeaf)));

    const leafHashes = leaves.map((leaf) => digest(leaf.payload));
    const historyTree = merkleRootAndProofs(leafHashes);
    const findingTree = merkleRootAndProofs(findingLeaves.map((leaf) => digest(leaf.payload)));

    await client.query(
      `DELETE FROM compliance_report_history_leaves WHERE tenant_id = $1 AND report_id = $2`,
      [tenantId, reportId],
    );
    for (const [leafIndex, leaf] of leaves.entries()) {
      await client.query(
        `INSERT INTO compliance_report_history_leaves
          (tenant_id, report_id, report_version, leaf_index, leaf_type, source_id,
           leaf_hash, payload, merkle_proof, history_merkle_root, finding_state_root)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          tenantId,
          reportId,
          report.report_version,
          leafIndex,
          leaf.leafType,
          leaf.sourceId,
          leafHashes[leafIndex],
          JSON.stringify(leaf.payload),
          JSON.stringify(historyTree.proofs[leafIndex]),
          historyTree.root,
          findingTree.root,
        ],
      );
    }

    return {
      historyMerkleRoot: historyTree.root,
      findingStateRoot: findingTree.root,
      actionCount: actions.rowCount ?? 0,
      decisionCount: decisions.rowCount ?? 0,
      findingCount: findings.rowCount ?? 0,
    };
  }

  private assertSubmissionMatchesPreparedPayer(
    preparedPayerAccountId: string | null | undefined,
    transactionId: string,
    topicId: string,
  ) {
    const payer = String(preparedPayerAccountId ?? '').trim();
    const transactionPayer = String(transactionId ?? '').trim().match(/^(0\.0\.\d+)[@-]/)?.[1] ?? '';
    if (!payer) throw new ConflictException('Prepared attestation has no payerAccountId');
    if (!transactionPayer) throw new BadRequestException('transactionId must start with the Hedera payer account ID');
    if (transactionPayer !== payer) {
      throw new ConflictException(
        `Submitted transaction payer ${transactionPayer} does not match prepared payer ${payer}`,
      );
    }
    const configuredTopicId = hederaTopicId().trim();
    if (configuredTopicId && String(topicId ?? '').trim() !== configuredTopicId) {
      throw new ConflictException(`Submitted topic ${topicId} does not match configured topic ${configuredTopicId}`);
    }
  }

  private async lookupMirrorTransaction(transactionId: string): Promise<{ result?: string; consensus_timestamp?: string; entity_id?: string } | null> {
    const mirrorUrl = mirrorNodeUrl();
    if (!mirrorUrl) return null;
    const mirrorId = transactionId.replace('@', '-');
    try {
      const response = await fetch(`${mirrorUrl.replace(/\/$/, '')}/api/v1/transactions/${encodeURIComponent(mirrorId)}`);
      if (!response.ok) return null;
      const body = await response.json() as { transactions?: Array<{ result?: string; consensus_timestamp?: string; entity_id?: string }> };
      return body.transactions?.[0] ?? null;
    } catch {
      return null;
    }
  }

  private async lookupMirrorTopicMessage(
    topicId: string,
    sequenceNumber: string | null | undefined,
  ): Promise<string | null> {
    if (!topicId || !sequenceNumber) return null;
    const mirrorUrl = mirrorNodeUrl();
    if (!mirrorUrl) return null;
    try {
      const response = await fetch(
        `${mirrorUrl.replace(/\/$/, '')}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(sequenceNumber)}`,
      );
      if (!response.ok) return null;
      const body = await response.json() as { message?: string };
      if (typeof body.message !== 'string') return null;
      const decoded = Buffer.from(body.message, 'base64').toString('utf8');
      return decoded;
    } catch {
      return null;
    }
  }
}
