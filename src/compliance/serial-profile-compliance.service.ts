import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantContext } from '../common/tenant-context';
import { DatabaseService } from '../database/database.service';
import { KeycloakAuthService } from '../pharmatrace/keycloak-auth.service';
import { McpServer } from '../mcp/mcp.types';
import { ComplianceService } from './compliance.service';
import { ComplianceResultStatusDto, ComplianceSeverityDto, ComplianceFindingDto } from './dto/compliance.dto';
import { getProfileRuleDefinitions, getProfileRules, ProfileRuleFamily } from './profile-rules';
import { Gs1ValidationResult, Gs1ValidationService } from './gs1-validation.service';

type Profile = Record<string, unknown>;

export interface SerialProfileRunInput {
  profiles?: Profile[];
  limit?: number;
  ruleSetVersion?: string;
  generateDemoNumbers?: boolean;
  demoNumberCount?: number;
  /** Test-only reset of stored reports for the selected source records. */
  resetReports?: boolean;
}

export type ComplianceProfileFamily =
  | 'SERIAL_NUMBER_PROFILE'
  | 'SSCC_PROFILE'
  | 'GDTI_PROFILE';

type ProfileAgentConfig = {
  agentType: string;
  sourceSystem: string;
  creatorName: string;
};

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerBigInt(value: unknown): bigint | null {
  const raw = text(value);
  if (!/^-?\d+$/.test(raw)) return null;
  try { return BigInt(raw); } catch { return null; }
}

function fingerprint(profile: Profile): string {
  const canonical = JSON.stringify(Object.keys(profile).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = profile[key];
    return out;
  }, {}));
  return createHash('sha256').update(canonical).digest('hex');
}

const PROFILE_REVIEW_GROUP_SIZE = 4;

function reviewField(finding: any): string | undefined {
  return typeof finding.field === 'string' && finding.field.length > 0
    ? finding.field
    : undefined;
}

function reviewGroupKey(finding: any): string {
  const ruleId = String(finding.rule_id ?? '');
  if (/PREFIX|DOC-|FILTER/.test(ruleId)) return 'identity';
  if (/NAME/.test(ruleId)) return 'presentation';
  if (/GENERATION|OUTPUT|GS1-ENGINE/.test(ruleId)) return 'generation';
  if (/INDEX|RANGE|REMAINING|THRESHOLD|STATUS/.test(ruleId)) return 'state';
  return 'other';
}

function buildProfileReviewGroups(
  report: any,
  ruleCatalog: ReturnType<typeof getProfileRuleDefinitions>,
) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const rules = new Map(ruleCatalog.map((rule) => [rule.ruleId, rule]));
  const ordered = [...findings].sort((left, right) => {
    const groupOrder = { identity: 0, presentation: 1, generation: 2, state: 3, other: 4 } as Record<string, number>;
    const groupDifference = groupOrder[reviewGroupKey(left)] - groupOrder[reviewGroupKey(right)];
    if (groupDifference !== 0) return groupDifference;
    const severity = { HIGH: 0, MEDIUM: 1, INFO: 2 } as Record<string, number>;
    return (severity[String(left.severity).toUpperCase()] ?? 3)
      - (severity[String(right.severity).toUpperCase()] ?? 3);
  });
  const groups: Array<Record<string, unknown>> = [];
  for (let index = 0; index < ordered.length; index += PROFILE_REVIEW_GROUP_SIZE) {
    const groupFindings = ordered.slice(index, index + PROFILE_REVIEW_GROUP_SIZE);
    const fields = [...new Set(groupFindings.flatMap((finding: any) => [
      reviewField(finding),
      ...Object.keys(finding.evidence?.values ?? {}),
    ]).filter(Boolean) as string[])];
    groups.push({
      groupNumber: groups.length + 1,
      totalGroups: Math.ceil(ordered.length / PROFILE_REVIEW_GROUP_SIZE),
      findings: groupFindings.map((finding: any) => {
        const ruleDefinition = rules.get(finding.rule_id);
        const findingFields = [...new Set([
          reviewField(finding),
          ...Object.keys(finding.evidence?.values ?? {}),
        ].filter(Boolean) as string[])];
        return {
          findingId: finding.id,
          rule: ruleDefinition ?? { ruleId: finding.rule_id, title: finding.title, field: finding.field, severity: finding.severity },
            deterministicAssessment: ruleDefinition?.validationType === 'CONTEXTUAL'
              ? 'CONTEXTUAL_REVIEW'
              : 'CONFIRMED',
          allowedAssessments: ruleDefinition?.ruleId === 'GDTI-FILTER-002'
            && !/travel/i.test(text(report.sourceProfile?.documentType))
            ? ['DISPUTED', 'NEEDS_CONTEXT']
            : ruleDefinition?.allowedAssessments ?? ['CONFIRMED'],
          // Keep evidence specific to this finding. Do not expose the union
          // of every group's fields to each finding.
          relevantProfile: Object.fromEntries(findingFields.map((field) => [field, report.sourceProfile?.[field]])),
          evidence: {
            field: finding.field,
            currentValue: finding.evidence?.values && Object.keys(finding.evidence.values).length
              ? Object.fromEntries(findingFields.map((field) => [field, finding.evidence.values[field]]))
              : finding.evidence?.currentValue,
            expectedValue: finding.evidence?.expectedValue,
            reason: finding.comment,
            validationSource: finding.evidence?.validationSource ?? 'DETERMINISTIC_VALIDATION',
            representativeSamples: finding.evidence?.representativeSamples,
          },
        };
      }),
      relevantProfile: Object.fromEntries(fields.map((field) => [field, report.sourceProfile?.[field]])),
      relatedFields: fields,
    });
  }
  return groups;
}

@Injectable()
export class SerialProfileComplianceService {
  private readonly logger = new Logger(SerialProfileComplianceService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly auth: KeycloakAuthService,
    private readonly gs1: Gs1ValidationService,
  ) {}

  async run(tenant: TenantContext, input: SerialProfileRunInput, family: ComplianceProfileFamily = 'SERIAL_NUMBER_PROFILE') {
    const requestedLimit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    // Load the source collection before applying LIMIT. Otherwise LIMIT=1
    // repeatedly returns the first already-reported profile and never reaches
    // the next eligible profile.
    const sourceProfiles = input.profiles ?? await this.loadProfiles(tenant, 500, family);
    const config = this.agentConfig(family);
    const agentType = config.agentType;
    const recordType = family;
    if (input.resetReports) {
      const ids = sourceProfiles
        .map((profile) => text(profile.id || profile.profileId || profile.identifier))
        .filter(Boolean);
      await this.compliance.resetReportsForRecords(tenant.tenantId, agentType, recordType, ids);
    }
    const profiles = (input.resetReports
      ? sourceProfiles
      : await this.onlyEligibleProfiles(tenant.tenantId, sourceProfiles, agentType, family))
      .slice(0, requestedLimit);
    this.logger.log('Serial profile compliance selection', {
      tenantId: tenant.tenantId,
      family,
      requestedLimit,
      resetReports: input.resetReports === true,
      sourceRecordCount: sourceProfiles.length,
      selectedRecordCount: profiles.length,
      sourceRecordIds: sourceProfiles.map((profile) => text(profile.id || profile.profileId || profile.identifier)).filter(Boolean),
      selectedRecordIds: profiles.map((profile) => text(profile.id || profile.profileId || profile.identifier)).filter(Boolean),
    });
    const ruleSetVersion = input.ruleSetVersion ?? process.env.SERIAL_PROFILE_RULE_SET_VERSION ?? 'GS1-CONFIG-2026-01';
    const reports = [];

    for (const profile of profiles) {
      const recordId = text(profile.id || profile.profileId || profile.identifier);
      if (!recordId) {
        this.logger.warn('Skipping serial profile without a stable ID', { tenantId: tenant.tenantId });
        continue;
      }
      const generation = input.generateDemoNumbers !== false
        ? await this.generateDemoNumbers(tenant, profile, family, input.demoNumberCount ?? 2)
        : { serialNumbers: [], error: null };
      const gs1Input = this.gs1.buildValues(family, generation.serialNumbers, profile);
      const gs1Results = gs1Input.values.length
        ? await this.gs1.validateValues(gs1Input.values)
        : [];
      const evaluation = this.evaluate(profile, family, generation.serialNumbers, generation.error, input.generateDemoNumbers !== false, gs1Results, gs1Input.preparationErrors);
      // Preserve the exact values returned by the generator in the finding
      // evidence. A successful HTTP response can still contain an invalid GS1
      // value and must be reported as generated-but-invalid.
      for (const finding of evaluation.findings) {
        if (finding.field === 'generatedOutput' || finding.ruleId.includes('-GENERATION') || finding.ruleId.includes('-GS1-ENGINE')) {
          finding.evidence = {
            ...(finding.evidence ?? {}),
            currentValue: generation.serialNumbers,
            values: {
              ...((finding.evidence as any)?.values ?? {}),
              generatedOutput: generation.serialNumbers,
            },
            generatedValues: generation.serialNumbers,
            generationStatus: generation.error ? 'ERROR' : 'COMPLETED',
            gs1Validation: gs1Results,
            ...(generation.error ? { generationError: generation.error } : {}),
          };
        }
      }
      const encodingScheme = text(profile.encodingScheme || profile.encoding_scheme).toUpperCase() || 'GDTI_96';
      if (family === 'SERIAL_NUMBER_PROFILE') {
        const name = text(profile.name).trim().toLowerCase();
        const identifier = text(profile.identifier).trim().toLowerCase();
        const duplicateName = name && sourceProfiles.filter((item) => text(item.name).trim().toLowerCase() === name).length > 1;
        const duplicateIdentifier = identifier && sourceProfiles.filter((item) => text(item.identifier).trim().toLowerCase() === identifier).length > 1;
        if (duplicateName) evaluation.findings.push({ ruleId: 'UI-NAME-003', title: 'Duplicate active profile name', comment: 'An active profile already uses this name.', recommendation: 'Enter a different profile name.', requiresResolution: true, severity: ComplianceSeverityDto.HIGH, status: 'OPEN', phase: 'CREATE_OR_UPDATE', field: 'name', userCanFix: true, suggestedAction: 'Enter a different profile name.', evidence: {} });
        if (duplicateIdentifier) evaluation.findings.push({ ruleId: 'UI-ID-004', title: 'Duplicate active profile identifier', comment: 'An active profile already uses this identifier.', recommendation: 'Enter a different identifier.', requiresResolution: true, severity: ComplianceSeverityDto.HIGH, status: 'OPEN', phase: 'CREATE_OR_UPDATE', field: 'identifier', userCanFix: true, suggestedAction: 'Enter a different identifier.', evidence: {} });
        if (duplicateName || duplicateIdentifier) {
          evaluation.resultStatus = ComplianceResultStatusDto.FAIL;
          evaluation.severity = ComplianceSeverityDto.HIGH;
        }
      } else {
        const nameField = family === 'SSCC_PROFILE' ? 'ssccProfileName' : 'name';
        const normalizedName = text(profile[nameField]).trim().toLowerCase();
        const duplicateName = normalizedName && sourceProfiles.filter((item) => text(item[nameField]).trim().toLowerCase() === normalizedName).length > 1;
        if (duplicateName) {
          evaluation.findings.push({
            ruleId: `${family}-NAME-DUPLICATE`,
            title: `${family === 'SSCC_PROFILE' ? 'SSCC' : 'GDTI'} profile name is duplicated`,
            comment: 'Another active source profile uses the same normalized name.',
            recommendation: 'Use a unique profile name.',
            requiresResolution: true,
            severity: ComplianceSeverityDto.HIGH,
            status: 'OPEN',
            phase: 'CREATE_OR_UPDATE',
            field: nameField,
            userCanFix: true,
            suggestedAction: 'Use a unique profile name.',
            evidence: {},
          });
          evaluation.resultStatus = ComplianceResultStatusDto.FAIL;
          evaluation.severity = ComplianceSeverityDto.HIGH;
        }
      }
      const report = await this.compliance.createReport(tenant, {
        agentType,
        recordType: family,
        profileId: recordId,
        recordId,
        sourceSystem: config.sourceSystem,
        sourceVersion: text(profile.updatedOn || profile.updated_at || profile.createdOn || profile.created_at) || undefined,
        recordFingerprint: fingerprint(profile),
        resultStatus: evaluation.resultStatus,
        severity: evaluation.severity,
        ruleSetVersion,
        summary: evaluation.summary,
        findings: evaluation.findings,
        sourceData: this.sanitizeProfile(profile),
        report: {
          agent: agentType,
          ruleSetVersion,
        profileId: recordId,
          resultStatus: evaluation.resultStatus,
          profileCompliance: evaluation.profileCompliance,
          generationCompliance: evaluation.generationCompliance,
          generatedSerialNumbers: generation.serialNumbers,
          generatedSerialNumberCount: generation.serialNumbers.length,
          gs1Validation: gs1Results,
          gs1PreparationErrors: gs1Input.preparationErrors,
          processingStatus: 'COMPLETED',
          encodingScheme,
          generationStatus: input.generateDemoNumbers === false
            ? 'NOT_RUN'
            : generation.error ? 'ERROR' : 'COMPLETED',
          ...(generation.error ? { generationError: generation.error } : {}),
          ...(generation.diagnostics ? { generationDiagnostics: generation.diagnostics } : {}),
          checkedAt: new Date().toISOString(),
        },
        creatorName: config.creatorName,
        creatorPublicKey: process.env.AGENT_REPORT_CREATOR_PUBLIC_KEY,
        requiresApproval: true,
      });
      reports.push({ ...report, sourceProfile: this.sanitizeProfile(profile) });
    }

    this.logger.log('Serial profile compliance reports created', {
      tenantId: tenant.tenantId,
      family,
      reportCount: reports.length,
      reportIds: reports.map((report: any) => report.id).filter(Boolean),
      processedRecordIds: reports.map((report: any) => report.record_id ?? report.profile_id).filter(Boolean),
    });

    return {
      agentType,
      recordType: family,
      ruleSetVersion,
      ruleCatalog: getProfileRuleDefinitions(family),
      processingStatus: reports.length ? 'COMPLETED' : 'NO_DATA',
      agentReviewInstructions: {
        purpose: 'Verify only the initial findings against the supplied profile and rule catalog.',
        requiredFindingFields: ['findingId', 'assessment', 'comment'],
        assessments: ['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT'],
        remediation: 'The backend supplies the rule, target, action, current value, and expected value. Explain only why the assessment is correct and how to resolve it.',
      },
      agentReviewContext: reports.map((report: any) => ({
        reportId: report.id,
        profileId: report.record_id ?? report.profile_id,
        profile: report.sourceProfile ?? {},
        // Keep the complete report in PostgreSQL. The agent receives compact,
        // related groups so every finding is reviewed without repeating the
        // entire profile and rule catalog in every prompt.
        findingGroups: buildProfileReviewGroups(report, getProfileRuleDefinitions(family)),
        generation: {
          status: report.report_json?.generationStatus ?? 'NOT_RUN',
          compliance: report.report_json?.generationCompliance ?? 'NOT_TESTED',
          samples: report.report_json?.gs1Validation ?? [],
          diagnostics: report.report_json?.generationDiagnostics ?? null,
        },
        initialFindingCount: Array.isArray(report.findings) ? report.findings.length : 0,
        resultStatus: report.result_status,
        severity: report.severity,
      })),
      processed: reports.length,
      sourceRecords: sourceProfiles.length,
      skipped: sourceProfiles.length - profiles.length,
      pass: reports.filter((report: any) => report.result_status === 'PASS').length,
      fail: reports.filter((report: any) => report.result_status === 'FAIL').length,
      review: reports.filter((report: any) => report.result_status === 'REVIEW').length,
      reports,
    };
  }

  private async generateDemoNumbers(
    tenant: TenantContext,
    profile: Profile,
    family: ComplianceProfileFamily,
    count: number,
  ): Promise<{ serialNumbers: string[]; error: string | null; diagnostics?: Record<string, unknown> }> {
    const server: McpServer = {
      id: `serial-number-generation:${tenant.tenantId}`,
      tenant_id: tenant.tenantId,
      name: 'Serial Number Generation API',
      description: null,
      transport: 'STREAMABLE_HTTP',
      endpoint: process.env.SERIAL_NUMBER_GENERATION_API_URL ?? 'https://ser-snm.k8s.pharmatrace.io/downloadSerialNumbers',
      auth_config: {
        tokenUrl: process.env.KEYCLOAK_TOKEN_URL,
        clientId: process.env.KEYCLOAK_CLIENT_ID,
        grantType: process.env.KEYCLOAK_GRANT_TYPE ?? 'password',
        clientSecretRef: process.env.KEYCLOAK_CLIENT_SECRET ? 'env:KEYCLOAK_CLIENT_SECRET' : undefined,
        usernameRef: process.env.KEYCLOAK_USERNAME ? 'env:KEYCLOAK_USERNAME' : undefined,
        passwordRef: process.env.KEYCLOAK_PASSWORD ? 'env:KEYCLOAK_PASSWORD' : undefined,
      },
      metadata: { serverType: 'SERIAL_NUMBER_GENERATION_API' },
      enabled: true,
    };
    try {
      const accessToken = await this.auth.getAccessToken(server);
      const systemId = process.env.SERIAL_PROFILE_SENDING_SYSTEM ?? '388e3401-8cbd-42b4-8d9e-a196fc8e5cc6';
      const idType = family === 'GDTI_PROFILE' ? 'GDTI' : family === 'SSCC_PROFILE' ? 'SSCC' : 'GTIN';
      const objectKeyValue = family === 'SERIAL_NUMBER_PROFILE'
        // The serial-number generator resolves random profiles by profile
        // name (for example, RS-03), not by the profile UUID or identifier.
        ? text(profile.name)
        : text(profile.id || profile.profileId || profile.identifier);
      const requestPayload = {
        id: '',
        sendingSystem: systemId,
        receivingSystem: process.env.SERIAL_PROFILE_RECEIVING_SYSTEM ?? systemId,
        idType,
        objectKey: { name: idType, value: objectKeyValue },
        size: String(Math.min(Math.max(Math.trunc(count), 1), 10)),
      };
      this.logger.log('Serial number generation API request', {
        tenantId: tenant.tenantId,
        actorId: tenant.userId,
        profileId: text(profile.id || profile.profileId || profile.identifier),
        family,
        endpoint: new URL(server.endpoint).pathname,
        request: requestPayload,
      });
      const response = await fetch(server.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          tenantid: tenant.tenantId,
          'x-tenant-id': tenant.tenantId,
          'x-user-id': tenant.userId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
      });
      if (response.status === 401 || response.status === 403) {
        this.auth.invalidate(server.id);
      }
      if (!response.ok) {
        const rawBody = await response.text();
        let parsedBody: any = null;
        try { parsedBody = JSON.parse(rawBody); } catch { /* non-JSON upstream response */ }
        const diagnostics = {
          httpStatus: response.status,
          endpoint: new URL(server.endpoint).pathname,
          responseCode: typeof parsedBody?.code === 'string' ? parsedBody.code : undefined,
          responseMessage: typeof parsedBody?.message === 'string' ? parsedBody.message : rawBody.slice(0, 1000),
          responseBody: rawBody.slice(0, 2000),
          requestCorrelationId: response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? undefined,
          attemptedSampleCount: Math.min(Math.max(Math.trunc(count), 1), 10),
        };
        this.logger.error('Serial number generation API failed', {
          tenantId: tenant.tenantId,
          actorId: tenant.userId,
          profileId: text(profile.id || profile.profileId || profile.identifier),
          family,
          ...diagnostics,
        });
        return { serialNumbers: [], error: `Serial number generation API returned HTTP ${response.status}`, diagnostics };
      }
      const rawBody = await response.text();
      let payload: any = null;
      try { payload = JSON.parse(rawBody); } catch {
        const diagnostics = {
          httpStatus: response.status,
          endpoint: new URL(server.endpoint).pathname,
          responseCode: 'INVALID_JSON_RESPONSE',
          responseMessage: 'Generation API returned a non-JSON response',
          responseBody: rawBody.slice(0, 2000),
          attemptedSampleCount: Math.min(Math.max(Math.trunc(count), 1), 10),
        };
        this.logger.error('Serial number generation API returned invalid JSON', { tenantId: tenant.tenantId, actorId: tenant.userId, family, ...diagnostics });
        return { serialNumbers: [], error: 'Generation API returned invalid JSON', diagnostics };
      }
      const serialNumbers = Array.isArray(payload?.randomizedNumberList?.serialNo)
        ? payload.randomizedNumberList.serialNo.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      this.logger.log('Serial number generation API response', {
        tenantId: tenant.tenantId,
        actorId: tenant.userId,
        profileId: text(profile.id || profile.profileId || profile.identifier),
        family,
        httpStatus: response.status,
        response: payload,
        serialNumberCount: serialNumbers.length,
      });
      const responseObjectKey = payload?.objectKey;
      const responseMismatch = payload?.idType !== idType
        || responseObjectKey?.name !== idType
        || String(responseObjectKey?.value ?? '') !== objectKeyValue
        || payload?.sendingSystem !== requestPayload.sendingSystem
        || payload?.receivingSystem !== requestPayload.receivingSystem;
      if (responseMismatch) {
        const diagnostics = {
          httpStatus: response.status,
          endpoint: new URL(server.endpoint).pathname,
          responseCode: 'RESPONSE_REQUEST_MISMATCH',
          responseMessage: 'Generation response does not match the requested profile or systems',
          responseBody: rawBody.slice(0, 2000),
          attemptedSampleCount: Number(requestPayload.size),
        };
        this.logger.error('Serial number generation response mismatch', { tenantId: tenant.tenantId, actorId: tenant.userId, family, request: requestPayload, ...diagnostics });
        return { serialNumbers: [], error: 'Generation API response did not match the request', diagnostics };
      }
      const diagnostics = serialNumbers.length ? undefined : {
        httpStatus: response.status,
        endpoint: new URL(server.endpoint).pathname,
        responseCode: 'EMPTY_SERIAL_NUMBER_LIST',
        responseMessage: 'Generation API returned no serial numbers',
        responseBody: rawBody.slice(0, 2000),
        attemptedSampleCount: Math.min(Math.max(Math.trunc(count), 1), 10),
      };
      if (diagnostics) this.logger.error('Serial number generation API returned no serial numbers', { tenantId: tenant.tenantId, actorId: tenant.userId, family, ...diagnostics });
      return { serialNumbers, error: serialNumbers.length ? null : 'Generation API returned no serial numbers', diagnostics };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Serial number generation call failed', {
        tenantId: tenant.tenantId,
        actorId: tenant.userId,
        profileId: text(profile.id || profile.profileId || profile.identifier),
        family,
        endpoint: new URL(server.endpoint).pathname,
        error: message,
      });
      return { serialNumbers: [], error: message, diagnostics: {
        endpoint: new URL(server.endpoint).pathname,
        responseCode: 'REQUEST_FAILED',
        responseMessage: message.slice(0, 1000),
        attemptedSampleCount: Math.min(Math.max(Math.trunc(count), 1), 10),
      } };
    }
  }

  private sanitizeProfile(profile: Profile): Profile {
    return Object.fromEntries(
      Object.entries(profile).filter(([key]) => !/(api.?key|client.?secret|password|token|private.?key)/i.test(key)),
    );
  }

  private async onlyEligibleProfiles(tenantId: string, profiles: Profile[], agentType: string, recordType: string): Promise<Profile[]> {
    if (!profiles.length) return [];
    const ids = profiles
      .map((profile) => text(profile.id || profile.profileId || profile.identifier))
      .filter(Boolean);
    if (!ids.length) return [];
    const result = await this.database.query<{
      record_id: string;
      record_fingerprint: string | null;
      status: string;
    }>(
      `SELECT DISTINCT ON (record_id) record_id, record_fingerprint, status
       FROM compliance_reports
       WHERE tenant_id = $1 AND agent_type = $3
         AND record_type = $4
         AND record_id = ANY($2::text[])
       ORDER BY record_id, report_version DESC, created_at DESC`,
      [tenantId, ids, agentType, recordType],
    );
    const existing = new Map(result.rows.map((row) => [row.record_id, row]));
    // A profile stays out of the queue while its current report is pending
    // human review, approved, rejected, or otherwise active. Only a report
    // explicitly returned to AGENT_REVIEW is eligible for another agent pass.
    // Use resetReports=true only for a deliberate test rerun.
    return profiles.filter((profile) => {
      const id = text(profile.id || profile.profileId || profile.identifier);
      const report = existing.get(id);
      if (!report) return true;
      return report.status === 'AGENT_REVIEW';
    });
  }

  private async loadProfiles(tenant: TenantContext, limit: number, family: ComplianceProfileFamily): Promise<Profile[]> {
    const tenantId = tenant.tenantId;
    const server: McpServer = {
      id: `serial-profile-source:${tenantId}`,
      tenant_id: tenantId,
      name: 'Serial Number Management Profiles',
      description: null,
      transport: 'STREAMABLE_HTTP',
      endpoint: family === 'SERIAL_NUMBER_PROFILE'
        ? (process.env.SERIAL_PROFILE_API_URL ?? 'https://ser-snm.k8s.pharmatrace.io/getAllProfiles')
        : (process.env.SERIAL_PROFILE_GDTI_API_URL ?? 'https://pt-snm-gdti.k8s.pharmatrace.io/graphql'),
      auth_config: {
        tokenUrl: process.env.KEYCLOAK_TOKEN_URL,
        clientId: process.env.KEYCLOAK_CLIENT_ID,
        grantType: process.env.KEYCLOAK_GRANT_TYPE ?? 'password',
        clientSecretRef: process.env.KEYCLOAK_CLIENT_SECRET ? 'env:KEYCLOAK_CLIENT_SECRET' : undefined,
        usernameRef: process.env.KEYCLOAK_USERNAME ? 'env:KEYCLOAK_USERNAME' : undefined,
        passwordRef: process.env.KEYCLOAK_PASSWORD ? 'env:KEYCLOAK_PASSWORD' : undefined,
      },
      metadata: { serverType: 'SERIAL_PROFILE_API' },
      enabled: true,
    };
    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken(server);
    } catch (error) {
      this.logger.error('Serial profile authentication failed', {
        tenantId,
        family,
        endpoint: new URL(server.endpoint).pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      tenantid: tenantId,
      'x-tenant-id': tenantId,
      'x-user-id': tenant.userId,
      Accept: 'application/json',
    };
    const queries: Record<string, string> = {
      SSCC_PROFILE: 'query { allSsccProfiles { id ssccProfileName startNumber incrementBy numberRangeSize thresholdPercentage externalSystem status index companyPrefix metadata epcFilterValue extensionDigit remaining currentNumber createdOn } }',
      GDTI_PROFILE: 'query { allGdtiProfiles { id name incrementBy currentNumber startNumber numberRangeSize thresholdPercentage externalSystem status index remaining metadata companyPrefix epcFilterValue documentType isDelete realmName createdOn } }',
    };
    this.logger.log('Loading serial profiles', {
      tenantId,
      actorId: tenant.userId,
      family,
      endpoint: new URL(server.endpoint).pathname,
      limit,
    });
    let response: Response;
    try {
      response = await fetch(server.endpoint, {
        method: family === 'SERIAL_NUMBER_PROFILE' ? 'GET' : 'POST',
        headers: family === 'SERIAL_NUMBER_PROFILE' ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: family === 'SERIAL_NUMBER_PROFILE' ? undefined : JSON.stringify({ query: queries[family] }),
        signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
      });
    } catch (error) {
      this.logger.error('Serial profile API request failed', {
        tenantId,
        actorId: tenant.userId,
        family,
        endpoint: new URL(server.endpoint).pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      this.auth.invalidate(server.id);
      throw new BadRequestException(`Serial profile API rejected the authenticated request with HTTP ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text();
      this.logger.error('Serial profile API failed', {
        tenantId,
        actorId: tenant.userId,
        family,
        endpoint: new URL(server.endpoint).pathname,
        status: response.status,
        response: body.slice(0, 1000),
      });
      throw new BadRequestException(`Serial profile API returned HTTP ${response.status}`);
    }
    const payload = await response.json() as any;
    const profiles: unknown[] = family === 'SERIAL_NUMBER_PROFILE'
      ? (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [])
      : (Array.isArray(payload?.data?.allSsccProfiles) ? payload.data.allSsccProfiles
          : Array.isArray(payload?.data?.allGdtiProfiles) ? payload.data.allGdtiProfiles : []);
    const selectedProfiles = profiles
      .filter((profile): profile is Profile => Boolean(profile && typeof profile === 'object' && !Array.isArray(profile)))
      .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 500));
    this.logger.log('Serial profile API response', {
      tenantId,
      actorId: tenant.userId,
      family,
      endpoint: new URL(server.endpoint).pathname,
      httpStatus: response.status,
      sourceRecordCount: profiles.length,
      selectedRecordCount: selectedProfiles.length,
    });
    return selectedProfiles;
  }

  private evaluate(
    profile: Profile,
    family: ComplianceProfileFamily,
    generatedSerialNumbers: string[] = [],
    generationError: string | null = null,
    generationEnabled = true,
    gs1Results: Gs1ValidationResult[] = [],
    gs1PreparationErrors: string[] = [],
  ): {
    resultStatus: ComplianceResultStatusDto;
    profileCompliance: ComplianceResultStatusDto;
    generationCompliance: 'PASS' | 'FAIL' | 'NOT_TESTED';
    severity: ComplianceSeverityDto;
    summary: string;
    findings: ComplianceFindingDto[];
  } {
    const findings: ComplianceFindingDto[] = [];
    const add = (ruleId: string, title: string, comment: string, requiresResolution = true, severity: ComplianceSeverityDto = ComplianceSeverityDto.HIGH, field?: string, userCanFix = true, suggestedAction?: string) => {
      findings.push({
        ruleId,
        title,
        comment,
        recommendation: 'Correct the profile configuration and rerun the Serial Profile Compliance Agent.',
        requiresResolution,
        severity,
        status: 'OPEN',
        phase: 'CREATE_OR_UPDATE',
        field: field ?? this.fieldForRule(ruleId),
        userCanFix,
        suggestedAction: suggestedAction ?? comment,
        evidence: (() => {
          const ruleFields = this.fieldsForRule(ruleId);
          const values = Object.fromEntries(ruleFields.map((key) => [key, profile[key]]));
          return {
            field: field ?? this.fieldForRule(ruleId),
            currentValue: ruleFields.length > 1 ? values : field ? profile[field] : undefined,
            values,
            expectedValue: this.expectedValueForRule(ruleId, profile),
            reason: comment,
            validationSource: 'DETERMINISTIC_VALIDATION',
          };
        })(),
      });
    };

    for (const profileRule of getProfileRules(family as ProfileRuleFamily)) {
      const comment = profileRule.check(profile);
      if (comment) {
        add(profileRule.ruleId, profileRule.title, comment,
          profileRule.ruleId === 'SSCC-EPC-FILTER-001' && !this.isRfidEncodingEnabled(profile)
            ? false
            : profileRule.requiresResolution,
          profileRule.ruleId === 'SSCC-EPC-FILTER-001' && !this.isRfidEncodingEnabled(profile)
            ? ComplianceSeverityDto.INFO
            : profileRule.severity === 'HIGH' ? ComplianceSeverityDto.HIGH : profileRule.severity === 'MEDIUM' ? ComplianceSeverityDto.MEDIUM : ComplianceSeverityDto.INFO,
          profileRule.field, profileRule.userCanFix);
      }
    }

    let generationCompliance: 'PASS' | 'FAIL' | 'NOT_TESTED' = generationEnabled ? 'PASS' : 'NOT_TESTED';
    if (generationEnabled && ['SERIAL_NUMBER_PROFILE', 'SSCC_PROFILE', 'GDTI_PROFILE'].includes(family)) {
      if (generationError) {
        generationCompliance = 'NOT_TESTED';
        add(`${family}-GENERATION`, `${family} number generation could not be verified`, generationError, false, ComplianceSeverityDto.MEDIUM, undefined, false, 'Retry the generation service and investigate the returned API error.');
      } else if (!generatedSerialNumbers.length) {
        generationCompliance = 'FAIL';
        add(`${family}-GENERATION-EMPTY`, `No demo ${family} values were generated`, 'The generation API must return at least one generated value.', false, ComplianceSeverityDto.MEDIUM, undefined, false, 'Retry the generation service and verify its response.');
      } else if (gs1PreparationErrors.length || gs1Results.some((result) => !result.valid)) {
        const failed = gs1Results.filter((result) => !result.valid);
        const reasons = [...gs1PreparationErrors, ...failed.map((result) => result.error ?? 'GS1 validation failed')];
        add(`${family}-GS1-ENGINE`, 'Generated value failed complete GS1 validation', `${reasons[0] ?? 'One or more complete generated GS1 values are invalid.'} ${failed.length} of ${generatedSerialNumbers.length} generated sample(s) failed.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the responsible profile field, product master data, or generator formatter identified by the validation evidence.');
      } else if (family === 'SERIAL_NUMBER_PROFILE') {
        const bodyLength = number(profile.serialNumberLength ?? profile.serial_number_length);
        const chars = text(profile.serialNumChars ?? profile.serial_num_chars);
        const prefix = text(profile.prepandData ?? profile.prepand_data ?? profile.frontPrepandData ?? profile.prefix);
        const suffix = text(profile.appendData ?? profile.append_data ?? profile.suffix);
        const expectedLength = bodyLength === null ? null : prefix.length + bodyLength + suffix.length;
        for (const serial of generatedSerialNumbers) {
          if (expectedLength !== null && serial.length !== expectedLength) {
            add('SERIAL-GENERATED-LENGTH', 'Generated serial number has the wrong length', `${serial} has length ${serial.length}; expected ${expectedLength}.`);
          }
          if (prefix && !serial.startsWith(prefix)) {
            add('SERIAL-GENERATED-PREFIX', 'Generated serial number has the wrong prefix', `${serial} does not start with ${prefix}.`);
          }
          if (suffix && !serial.endsWith(suffix)) {
            add('SERIAL-GENERATED-SUFFIX', 'Generated serial number has the wrong suffix', `${serial} does not end with ${suffix}.`);
          }
          if (chars && [...serial].some((character) => !chars.includes(character))) {
            add('SERIAL-GENERATED-CHARSET', 'Generated serial number contains a disallowed character', `${serial} contains characters outside the configured profile character set.`);
          }
        }
        const scheme = text(profile.encodingScheme || profile.encoding_scheme).toUpperCase();
        if (scheme === 'SGTIN_96' || scheme === 'SGTIN-96') {
          for (const serial of generatedSerialNumbers) {
            if (!/^\d+$/.test(serial) || (serial.length > 1 && serial.startsWith('0')) || BigInt(serial || '0') > 274_877_906_943n) {
              add('RANDOM-EPC-SCHEME-001', 'Generated serial is incompatible with SGTIN-96', `${serial} is not a numeric, no-leading-zero serial within the SGTIN-96 range 0 through 274,877,906,943.`, true, ComplianceSeverityDto.HIGH, 'format', false, 'Use a numeric serial within the SGTIN-96 range, or select an EPC encoding scheme such as SGTIN-198 that supports the configured alphanumeric serial.');
            }
          }
        }
      } else if (family === 'SSCC_PROFILE') {
        for (const generated of generatedSerialNumbers) {
          const value = generated.trim();
          if (/253|GDTI|\[|\]/i.test(value)) {
            add('SSCC-OUTPUT-001', 'Generated output uses the wrong GS1 application identifier', 'SSCC must use AI (00), not AI (253), which is used for GDTI.', true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the SSCC formatter to emit AI (00).');
          }
          const digits = value.replace(/^\(00\)/, '');
          if (!/^\d{18}$/.test(digits)) {
            add('SSCC-OUTPUT-002', 'Generated value is not an 18-digit SSCC', `${value} must contain exactly 18 numeric SSCC digits.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the SSCC generator output.');
            continue;
          }
          const body = digits.slice(0, -1);
          const expectedCheckDigit = [...body].reverse().reduce((sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 3 : 1), 0);
          if (String((10 - (expectedCheckDigit % 10)) % 10) !== digits.at(-1)) {
            add('SSCC-OUTPUT-005', 'Generated SSCC has an invalid check digit', `${value} does not pass the GS1 Mod-10 check-digit calculation.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the SSCC check-digit calculation.');
          }
        }
      } else if (family === 'GDTI_PROFILE') {
        const scheme = text(profile.encodingScheme || profile.encoding_scheme).toUpperCase() || 'GDTI_96';
        for (const generated of generatedSerialNumbers) {
          const value = generated.trim();
          const normalized = this.parseGdtiOutput(value);
          if (!normalized) {
            add('GDTI-OUTPUT-001', 'Generated value has an invalid GDTI representation', `${value} must use a supported AI (253) representation or an unwrapped GDTI payload.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the GDTI formatter to emit a valid AI (253) value.');
            continue;
          }
          const { payload } = normalized;
          if (scheme === 'GENERIC_GDTI') {
            if (!/^\d{13}[0-9A-Za-z!%&()*+,\-./\\":;<=>?]{0,17}$/.test(payload)) {
              add('GDTI-OUTPUT-003', 'Generated generic GDTI payload is invalid', `${value} must contain a 13-digit numeric GDTI base followed by up to 17 GS1 characters.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the generic GDTI formatter and character set.');
              continue;
            }
          } else {
            if (!/^\d{14,26}$/.test(payload)) {
              add('GDTI-OUTPUT-004', 'Generated GDTI-96 payload has an invalid length', `${value} must contain a 13-digit base plus a 1–13 digit numeric serial.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the GDTI-96 formatter to emit a 14–26 digit payload.');
              continue;
            }
            const serial = integerBigInt(payload.slice(13));
            if (serial === null || serial < 0n || serial > 2_199_023_255_551n) {
              add('GDTI-OUTPUT-005', 'Generated GDTI-96 serial exceeds its 41-bit range', `${value} contains a serial outside 0 through 2,199,023,255,551.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the GDTI-96 serial allocator to stay within the 41-bit range.');
              continue;
            }
          }
          const base = payload.slice(0, 13);
          const body = base.slice(0, -1);
          const checkSum = [...body].reverse().reduce((sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 3 : 1), 0);
          if (String((10 - (checkSum % 10)) % 10) !== base.at(-1)) {
            add('GDTI-OUTPUT-002', 'Generated GDTI has an invalid check digit', `${value} does not pass the GS1 Mod-10 check-digit calculation.`, true, ComplianceSeverityDto.HIGH, 'generatedOutput', false, 'Fix the GDTI check-digit calculation.');
          }
        }
      }
    }

    if (!text(profile.id || profile.profileId || profile.identifier)) {
      add('GS1-PROFILE-ID', 'Profile has no stable identifier', 'A serial profile must have a stable identifier for traceability.');
    }
    if (family !== 'SERIAL_NUMBER_PROFILE') {
      const required = findings.filter((finding) => finding.requiresResolution !== false);
      const profileFindings = findings.filter((finding) => !finding.ruleId.startsWith(`${family}-GENERATION`));
      const profileRequired = profileFindings.filter((finding) => finding.requiresResolution !== false);
      const profileCompliance = profileRequired.length ? ComplianceResultStatusDto.FAIL : profileFindings.length ? ComplianceResultStatusDto.REVIEW : ComplianceResultStatusDto.PASS;
      const resultStatus = profileCompliance === ComplianceResultStatusDto.FAIL
        ? ComplianceResultStatusDto.FAIL
        : generationCompliance === 'FAIL'
          ? ComplianceResultStatusDto.REVIEW
          : profileCompliance;
      const severity = required.some((finding) => finding.severity === 'HIGH') ? ComplianceSeverityDto.HIGH : ComplianceSeverityDto.INFO;
      const label = family === 'GDTI_PROFILE' ? 'GDTI' : 'SSCC';
      return {
        resultStatus,
        profileCompliance,
        generationCompliance,
        severity,
        summary: resultStatus === 'PASS'
          ? `${label} profile passed the configured GS1 validation rules.`
          : resultStatus === 'REVIEW'
            ? `${label} profile passed blocking checks but requires review of informational findings.`
            : `${label} profile failed one or more required GS1 validation rules.`,
        findings,
      };
    }
    if (!text(profile.name) && !text(profile.identifier)) {
      add('GS1-PROFILE-NAME', 'Profile has no name or identifier', 'A profile name or identifier is required for operational ownership.');
    }
    const profileName = text(profile.name).trim();
    if (profileName.length > 100) {
      add('UI-NAME-002', 'Profile name is too long', 'Profile name must be 100 characters or fewer.', true, ComplianceSeverityDto.HIGH, 'name');
    }
    const identifier = text(profile.identifier).trim();
    if (identifier.length > 100) {
      add('UI-ID-002', 'Profile identifier is too long', 'Identifier must be 100 characters or fewer.', true, ComplianceSeverityDto.HIGH, 'identifier');
    }
    if (identifier && !/^[A-Za-z0-9_-]+$/.test(identifier)) {
      add('UI-ID-003', 'Profile identifier contains unsupported characters', 'Use only letters, numbers, hyphens, and underscores.', true, ComplianceSeverityDto.HIGH, 'identifier');
    }
    if (family === 'SERIAL_NUMBER_PROFILE' && !text(profile.product)) {
      add('UI-PRODUCT-001', 'Product is missing', 'Select a product before activating this profile.', true, ComplianceSeverityDto.HIGH, 'product');
    }

    const length = number(profile.serialNumberLength ?? profile.serial_number_length);
    const maxRequestSize = number(profile.maxRequestSize ?? profile.max_request_size);
    if (length === null || length < 12 || length > 20 || !Number.isInteger(length)) {
      add('UI-LENGTH-002', 'Serial number length is invalid', 'serialNumberLength must be an integer from 12 through 20.', true, ComplianceSeverityDto.HIGH, 'serialNumberLength');
    }
    if (maxRequestSize !== null && (maxRequestSize <= 0 || !Number.isInteger(maxRequestSize))) {
      add('UI-REQUEST-001', 'Maximum request size is invalid', 'maxRequestSize must be an integer from 1 through 99,999.', true, ComplianceSeverityDto.HIGH, 'maxRequestSize');
    }
    if (maxRequestSize !== null && (maxRequestSize < 1 || maxRequestSize > 99999)) {
      add('UI-REQUEST-002', 'Maximum request size is outside the allowed range', 'Use a value from 1 through 99,999.', true, ComplianceSeverityDto.HIGH, 'maxRequestSize');
    }

    const chars = text(profile.serialNumChars ?? profile.serial_num_chars);
    const format = text(profile.format);
    if (!format || !['Numeric', 'Alphabetic', 'AlphaNumeric'].includes(format)) {
      add('UI-FORMAT-001', 'Format is invalid', 'Select Numeric, Alphabetic, or AlphaNumeric.', true, ComplianceSeverityDto.HIGH, 'format');
    }
    if (!chars && !format) {
      add('BACKEND-CHARACTER-SET', 'Character policy is not defined', 'The profile must define an allowed character set or a supported format.', true, ComplianceSeverityDto.HIGH, 'serialNumChars', false, 'Recalculate the backend character set.');
    }
    const pre = text(profile.prepandData ?? profile.prepand_data ?? profile.frontPrepandData ?? profile.prefix);
    const append = text(profile.appendData ?? profile.append_data ?? profile.suffix);
    if (/\s|[\u0000-\u001f\u007f]/.test(pre)) {
      add('UI-PREFIX-002', 'Prefix contains whitespace or control characters', 'Remove whitespace and control characters from the prefix.', true, ComplianceSeverityDto.HIGH, 'prepandData');
    }
    if (!/^[A-Za-z0-9]*$/.test(pre)) {
      add('UI-PREFIX-003', 'Prefix contains unsupported characters', 'Use letters and numbers only.', true, ComplianceSeverityDto.HIGH, 'prepandData');
    }
    if (/\s|[\u0000-\u001f\u007f]/.test(append)) {
      add('UI-SUFFIX-002', 'Suffix contains whitespace or control characters', 'Remove whitespace and control characters from the suffix.', true, ComplianceSeverityDto.HIGH, 'appendData');
    }
    if (!/^[A-Za-z0-9]*$/.test(append)) {
      add('UI-SUFFIX-001', 'Suffix contains unsupported characters', 'Use letters and numbers only.', true, ComplianceSeverityDto.HIGH, 'appendData');
    }
    if (length !== null && pre.length + length + append.length > 20) {
      add('UI-LENGTH-003', 'Final serial number exceeds the GS1 length limit', 'Prefix plus serial body plus suffix must be 20 characters or fewer.', true, ComplianceSeverityDto.HIGH, 'serialNumberLength');
    }
    if (format === 'Numeric' && /[A-Za-z]/.test(`${pre}${append}`)) {
      add('UI-PREFIX-004', 'Numeric format conflicts with alphabetic prefix or suffix', 'The final serial is alphanumeric because the prefix or suffix contains letters.', true, ComplianceSeverityDto.HIGH, 'format');
    }
    if (format === 'Numeric' && profile.numericValues !== true) {
      add('UI-NUMERIC-001', 'Numeric Values is disabled for Numeric format', 'Enable Numeric Values.', true, ComplianceSeverityDto.HIGH, 'numericValues');
    }
    if (format === 'AlphaNumeric' && profile.numericValues === false) {
      add('UI-NUMERIC-002', 'Numeric Values is disabled for AlphaNumeric format', 'Enable Numeric Values.', true, ComplianceSeverityDto.HIGH, 'numericValues');
    }
    if (format === 'Alphabetic' && profile.numericValues === true) {
      add('UI-NUMERIC-003', 'Numeric Values is ignored for Alphabetic format', 'Disable Numeric Values or select a numeric format.', false, ComplianceSeverityDto.MEDIUM, 'numericValues');
    }

    const excludedNumbers = text(profile.excludeNumericValues ?? profile.exclude_numeric_values);
    if (!/^[0-9]*$/.test(excludedNumbers) || new Set(excludedNumbers).size !== excludedNumbers.length) {
      add('UI-EXNUM-001', 'Excluded numeric values are invalid', 'Use unique digits only.', true, ComplianceSeverityDto.HIGH, 'excludeNumericValues');
    }
    if (excludedNumbers.length === 10) {
      add('UI-EXNUM-003', 'All numeric characters are excluded', 'At least one numeric character must remain available.', true, ComplianceSeverityDto.HIGH, 'excludeNumericValues');
    }
    const padLength = number(profile.padLength ?? profile.pad_length);
    const padCharacter = text(profile.padCharacter ?? profile.pad_character);
    if (padLength !== null && (padLength < 1 || padLength > 9999 || !Number.isInteger(padLength))) {
      add('UI-PAD-002', 'Pad length is invalid', 'Use a pad length from 1 through 9,999.', true, ComplianceSeverityDto.HIGH, 'padLength');
    }
    if (padCharacter.length > 1 || /\s|[\u0000-\u001f\u007f]/.test(padCharacter)) {
      add('UI-PADCHAR-001', 'Pad character is invalid', 'Pad character must be one non-whitespace character.', true, ComplianceSeverityDto.HIGH, 'padCharacter');
    }
    if (padCharacter && excludedNumbers.includes(padCharacter)) {
      add('UI-PADCHAR-004', 'Pad character is excluded', 'Choose a pad character that is not excluded.', true, ComplianceSeverityDto.HIGH, 'padCharacter');
    }

    const minimum = text(profile.minimumValue ?? profile.minimum_value);
    const maximum = text(profile.maximumValue ?? profile.maximum_value);
    if (minimum && maximum && minimum.length !== maximum.length) {
      add('BACKEND-RANGE', 'Stored minimum and maximum values have different lengths', 'The backend serial range is inconsistent.', true, ComplianceSeverityDto.MEDIUM, undefined, false, 'Recalculate the backend range values.');
    }
    const active = profile.active ?? profile.status;
    if (active === false || String(active).toLowerCase() === 'inactive') {
      add('PROFILE-INACTIVE', 'Profile is inactive', 'The profile is not active for generation.', false, ComplianceSeverityDto.INFO);
    }

    const required = findings.filter((finding) => finding.requiresResolution !== false);
    const resultStatus = required.length ? ComplianceResultStatusDto.FAIL : findings.length ? ComplianceResultStatusDto.REVIEW : ComplianceResultStatusDto.PASS;
    const severity = required.some((finding) => finding.severity === 'HIGH') ? ComplianceSeverityDto.HIGH : findings.length ? ComplianceSeverityDto.INFO : ComplianceSeverityDto.INFO;
    return {
      resultStatus,
      profileCompliance: resultStatus,
      generationCompliance,
      severity,
      summary: resultStatus === 'PASS'
        ? 'Serial number profile passed the configured GS1-oriented validation rules.'
        : resultStatus === 'REVIEW'
          ? 'Serial number profile passed blocking checks but requires review of informational findings.'
          : 'Serial number profile failed one or more required GS1-oriented validation rules.',
      findings,
    };
  }

  private parseGdtiOutput(value: string): { payload: string; ai: '253' | null } | null {
    const wrapped = value.match(/^\(253\)(\d[0-9A-Za-z!%&()*+,\-./\\":;<=>?]*)$/);
    if (wrapped) return { ai: '253', payload: wrapped[1] };
    if (/^253\d/.test(value)) return { ai: '253', payload: value.slice(3) };
    if (/^\d[0-9A-Za-z!%&()*+,\-./\\":;<=>?]*$/.test(value)) return { ai: null, payload: value };
    return null;
  }

  private isRfidEncodingEnabled(profile: Profile): boolean {
    if (profile.rfidEnabled === true || profile.epcEncodingEnabled === true) return true;
    const scheme = text(profile.encodingScheme || profile.encoding_scheme).toUpperCase();
    return /^(SSCC|SGTIN|EPC|RFID)/.test(scheme);
  }

  private fieldForRule(ruleId: string): string | undefined {
    const fields: Record<string, string> = {
      'UI-NAME-001': 'name',
      'UI-NAME-002': 'name',
      'UI-ID-001': 'identifier',
      'UI-ID-002': 'identifier',
      'UI-ID-003': 'identifier',
      'UI-PREFIX-002': 'prepandData',
      'UI-PREFIX-003': 'prepandData',
      'UI-SUFFIX-001': 'appendData',
      'UI-SUFFIX-002': 'appendData',
      'UI-FORMAT-001': 'format',
      'UI-NUMERIC-001': 'numericValues',
      'UI-NUMERIC-002': 'numericValues',
      'UI-NUMERIC-003': 'numericValues',
      'UI-REQUEST-001': 'maxRequestSize',
      'UI-REQUEST-002': 'maxRequestSize',
      'UI-LENGTH-002': 'serialNumberLength',
      'UI-LENGTH-003': 'serialNumberLength',
      'UI-PAD-002': 'padLength',
      'UI-PADCHAR-001': 'padCharacter',
      'UI-PADCHAR-004': 'padCharacter',
      'UI-EXNUM-001': 'excludeNumericValues',
      'UI-EXNUM-003': 'excludeNumericValues',
    };
    return fields[ruleId];
  }

  private fieldsForRule(ruleId: string): string[] {
    const fields: Record<string, string[]> = {
      'GDTI-INDEX-003': ['index', 'currentNumber', 'startNumber', 'incrementBy'],
      'SSCC-INDEX-003': ['index', 'currentNumber', 'startNumber', 'incrementBy'],
      'SSCC-INDEX-004': ['index', 'remaining', 'numberRangeSize'],
      'GDTI-THRESHOLD-003': ['remaining', 'numberRangeSize', 'thresholdPercentage'],
      'SSCC-THRESHOLD-004': ['remaining', 'numberRangeSize', 'thresholdPercentage'],
      'GDTI-STATUS-002': ['status', 'remaining'],
      'SSCC-STATUS-002': ['status', 'remaining'],
      'GDTI-DOC-003': ['companyPrefix', 'documentType'],
      'GDTI-FILTER-002': ['epcFilterValue', 'documentType'],
      'SSCC-RANGE-003': ['companyPrefix', 'startNumber', 'incrementBy', 'numberRangeSize'],
      'GDTI-INCREMENT-003': ['startNumber', 'incrementBy', 'numberRangeSize'],
      'GDTI-GS1-ENGINE': ['companyPrefix', 'documentType', 'generatedOutput'],
      'SSCC-GS1-ENGINE': ['companyPrefix', 'extensionDigit', 'generatedOutput'],
      'SERIAL_NUMBER_PROFILE-GS1-ENGINE': ['product', 'generatedOutput'],
    };
    const primary = this.fieldForRule(ruleId);
    return fields[ruleId] ?? (primary ? [primary] : []);
  }

  private expectedValueForRule(ruleId: string, profile: Profile): unknown {
    const expected: Record<string, unknown> = {
      'GDTI-NAME-003': text(profile.name).trim(),
      'GDTI-PREFIX-002': 'Assigned numeric GS1 Company Prefix',
      'GDTI-PREFIX-005': '6 through 12 numeric digits',
      'GDTI-DOC-002': 'Numeric document reference',
      'GDTI-DOC-003': 'Numeric company prefix plus document reference with a 12-digit combined base',
      'GDTI-FILTER-002': 'Verified travel-document context for filter 1, otherwise filter 0',
      'GDTI-INDEX-003': 'currentNumber = startNumber + index * incrementBy, or the supported one-based equivalent',
      'GDTI-THRESHOLD-003': 'remaining capacity above the configured threshold',
      'GDTI-STATUS-002': 'Active profile with remaining capacity greater than zero',
    };
    return expected[ruleId];
  }

  private agentConfig(family: ComplianceProfileFamily): ProfileAgentConfig {
    return {
      SERIAL_NUMBER_PROFILE: { agentType: 'SERIAL_PROFILE', sourceSystem: 'ser-snm', creatorName: 'Serial Number Profile Compliance Agent' },
      SSCC_PROFILE: { agentType: 'SSCC_PROFILE', sourceSystem: 'pt-snm-gdti', creatorName: 'SSCC Profile Compliance Agent' },
      GDTI_PROFILE: { agentType: 'GDTI_PROFILE', sourceSystem: 'pt-snm-gdti', creatorName: 'GDTI Profile Compliance Agent' },
    }[family];
  }
}
