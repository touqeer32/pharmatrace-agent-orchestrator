import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantContext } from '../common/tenant-context';
import { KeycloakAuthService } from '../pharmatrace/keycloak-auth.service';
import { McpServer } from '../mcp/mcp.types';
import { ComplianceService } from './compliance.service';
import { ComplianceResultStatusDto, ComplianceSeverityDto } from './dto/compliance.dto';

type PatternFamily = 'RECALL_PATTERN' | 'SHORTAGE_PATTERN';
type RecordValue = Record<string, unknown>;

export interface PatternComplianceRunInput {
  limit?: number;
  minEvents?: number;
  windowDays?: number;
  resetReports?: boolean;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, Object.keys(value as object).sort())).digest('hex');
}

function normalizeRecords(payload: any, family: PatternFamily): RecordValue[] {
  const key = family === 'RECALL_PATTERN' ? 'allProductRecallRequests' : 'allProductShortages';
  const records = payload?.data?.[key];
  return Array.isArray(records) ? records.filter((item): item is RecordValue => Boolean(item && typeof item === 'object')) : [];
}

@Injectable()
export class PatternComplianceService {
  private readonly logger = new Logger(PatternComplianceService.name);

  constructor(
    private readonly auth: KeycloakAuthService,
    private readonly compliance: ComplianceService,
  ) {}

  async run(tenant: TenantContext, input: PatternComplianceRunInput, family: PatternFamily) {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 500), 1), 500);
    const minEvents = Math.min(Math.max(Math.trunc(input.minEvents ?? 2), 2), 100);
    const windowDays = Math.min(Math.max(Math.trunc(input.windowDays ?? 365), 1), 3650);
    const endpoint = process.env.SERIAL_PROFILE_GDTI_API_URL ?? 'https://pt-snm-gdti.k8s.pharmatrace.io/graphql';
    const server: McpServer = {
      id: `pattern-source:${tenant.tenantId}`,
      tenant_id: tenant.tenantId,
      name: 'PharmaTrace Recall and Shortage Source',
      description: null,
      transport: 'STREAMABLE_HTTP',
      endpoint,
      auth_config: {
        tokenUrl: process.env.KEYCLOAK_TOKEN_URL,
        clientId: process.env.KEYCLOAK_CLIENT_ID,
        grantType: process.env.KEYCLOAK_GRANT_TYPE ?? 'password',
        clientSecretRef: process.env.KEYCLOAK_CLIENT_SECRET ? 'env:KEYCLOAK_CLIENT_SECRET' : undefined,
        usernameRef: process.env.KEYCLOAK_USERNAME ? 'env:KEYCLOAK_USERNAME' : undefined,
        passwordRef: process.env.KEYCLOAK_PASSWORD ? 'env:KEYCLOAK_PASSWORD' : undefined,
      },
      metadata: { serverType: 'PHARMATRACE_PATTERN_SOURCE' },
      enabled: true,
    };
    const token = await this.auth.getAccessToken(server);
    const query = family === 'RECALL_PATTERN'
      ? `query { allProductRecallRequests { id drug product lot gdtiProfileId gdtiProfile prnNumber prnStatusCode prnTitle incidentRiskLevelCode productRecallImpactedRecipient productRecallReasonCode productRecallMarketDetail recallInitiator recallRecipient summaryOfInvestigation competentAuthority eventsIdentified proposedDepthOfRecall copaom descriptionOfRootCause status createdOn updatedOn } }`
      : `query { allProductShortages { id drug product gdtiProfile productShortageNumber psnStatusCode psnTitle shortageRiskLevelCode productShortageImpactedRecipient productShortageMarketDetail productShortageReasonCode sourceOfInformation planToMitigateIssue actionOwner dateOfTheBeginningOfShortage expectedEndDateOfTheShortage reasonForShortage impactedCountries riskAssessmentOfImpactOfShortage createdOn updatedOn } }`;

    this.logger.log('Pattern source request', { tenantId: tenant.tenantId, family, endpoint, limit, minEvents, windowDays });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant.tenantId, 'x-user-id': tenant.userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new BadRequestException(`${family} source returned HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const payload = JSON.parse(raw);
    if (Array.isArray(payload.errors) && payload.errors.length) throw new BadRequestException(`${family} source GraphQL error: ${payload.errors[0]?.message ?? 'unknown error'}`);
    const sourceRecords = await this.enrichRecords(
      normalizeRecords(payload, family).slice(0, 500),
      token,
      tenant,
    );
    const allGroups = this.group(sourceRecords, family, minEvents, windowDays);
    const groups = await this.onlyEligibleGroups(tenant.tenantId, family, allGroups, input.resetReports === true);
    const selectedGroups = groups.slice(0, limit);
    const reports: unknown[] = [];

    this.logger.log('Pattern source response', { tenantId: tenant.tenantId, family, sourceRecordCount: sourceRecords.length, candidatePatternCount: allGroups.length, eligiblePatternCount: groups.length, selectedPatternCount: selectedGroups.length, limit });
    for (const group of selectedGroups) {
      const reportId = `${family}:${group.key}`;
      const sourceRecordRefs = group.records.map((record) => this.sourceRecordRef(record, family));
      if (input.resetReports) await this.compliance.resetReportsForRecords(tenant.tenantId, family, family, [reportId]);
      const missing = family === 'RECALL_PATTERN'
        ? group.records.filter((record) => !text(record.summaryOfInvestigation) || !text(record.descriptionOfRootCause)).length
        : group.records.filter((record) => !text(record.planToMitigateIssue) || text(record.expectedEndDateOfTheShortage).toLowerCase() === 'nan').length;
      const finding = {
        ruleId: `${family}-PATTERN-001`,
        title: group.title,
        severity: missing > 0 ? ComplianceSeverityDto.HIGH : ComplianceSeverityDto.MEDIUM,
        requiresResolution: missing > 0,
        comment: `${group.records.length} related ${family === 'RECALL_PATTERN' ? 'recall' : 'shortage'} records were found for ${group.dimension.toLowerCase()} ${group.displayValue}.`,
        recommendation: missing > 0 ? `Investigate the grouped records and complete the missing ${family === 'RECALL_PATTERN' ? 'root cause/investigation' : 'mitigation/end-date'} information.` : 'Review the pattern and confirm that monitoring or preventive action is appropriate.',
        evidence: { sourceRecordIds: group.records.map((record) => text(record.id)).filter(Boolean), sourceRecordRefs, dimension: group.dimension, value: group.value, displayValue: group.displayValue, eventCount: group.records.length },
      };
      const resultStatus = missing > 0 ? ComplianceResultStatusDto.REVIEW : ComplianceResultStatusDto.PASS;
      reports.push(await this.compliance.createReport(tenant, {
        agentType: family,
        recordType: family,
        recordId: reportId,
        sourceSystem: 'pt-snm-gdti',
        recordFingerprint: digest(group.records.map((record) => record.id)),
        issueFingerprint: digest({ family, key: group.key, windowDays }),
        sourceData: { dimension: group.dimension, value: group.value, displayValue: group.displayValue, sourceRecordRefs, records: group.records.slice(0, 25) },
        resultStatus,
        severity: missing > 0 ? ComplianceSeverityDto.HIGH : ComplianceSeverityDto.MEDIUM,
        ruleSetVersion: process.env.PATTERN_RULE_SET_VERSION ?? 'PATTERN-CONFIG-2026-01',
        summary: `${group.records.length} related records indicate a ${family === 'RECALL_PATTERN' ? 'recall' : 'shortage'} pattern for ${group.dimension.toLowerCase()} ${group.displayValue} (ID: ${group.value}).`,
        report: { agent: family, patternType: group.dimension, patternKey: group.key, displayValue: group.displayValue, windowDays, sourceRecordIds: group.records.map((record) => record.id), sourceRecordRefs, eventCount: group.records.length },
        findings: [finding],
        requiresApproval: true,
        creatorName: `${family === 'RECALL_PATTERN' ? 'Recall' : 'Shortage'} Pattern Compliance Agent`,
        creatorPublicKey: process.env.AGENT_REPORT_CREATOR_PUBLIC_KEY,
      }));
    }
    return { agentType: family, processingStatus: reports.length ? 'COMPLETED' : 'NO_DATA', sourceRecords: sourceRecords.length, candidatePatterns: allGroups.length, eligiblePatterns: groups.length, processed: reports.length, skipped: allGroups.length - groups.length, minEvents, windowDays, reports };
  }

  private async onlyEligibleGroups(
    tenantId: string,
    family: PatternFamily,
    groups: Array<{
      key: string;
      dimension: string;
      value: string;
      displayValue: string;
      title: string;
      records: RecordValue[];
    }>,
    resetReports: boolean,
  ) {
    if (resetReports || !groups.length) return groups;
    const ids = groups.map((group) => `${family}:${group.key}`);
    const statuses = await this.compliance.findLatestReportStatuses(tenantId, family, family, ids);
    return groups.filter((group) => {
      const status = statuses.get(`${family}:${group.key}`);
      return !status || status === 'AGENT_REVIEW';
    });
  }

  private group(records: RecordValue[], family: PatternFamily, minEvents: number, windowDays: number) {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const grouped = new Map<string, { dimension: string; value: string; displayValue: string; records: RecordValue[] }>();
    for (const record of records) {
      const eventTime = Date.parse(text(record.updatedOn || record.createdOn));
      if (Number.isFinite(eventTime) && eventTime < cutoff) continue;
      for (const [dimension, field] of [['PRODUCT', 'product'], ['DRUG', 'drug']] as const) {
        const value = text(record[field]);
        if (!value) continue;
        const key = `${dimension}:${value}`;
        const displayValue = text(record[`${field}Name`]) || value;
        const group = grouped.get(key) ?? { dimension, value, displayValue, records: [] };
        group.records.push(record);
        grouped.set(key, group);
      }
    }
    return [...grouped.entries()]
      .filter(([, group]) => group.records.length >= minEvents)
      .map(([key, group]) => ({ ...group, key, title: `${family} pattern detected` }));
  }

  private async enrichRecords(records: RecordValue[], token: string, tenant: TenantContext): Promise<RecordValue[]> {
    const gateway = process.env.PHARMATRACE_GRAPHQL_URL ?? 'https://apigateway.k8s.pharmatrace.io/graphql';
    const headers = {
      Authorization: `Bearer ${token}`,
      'x-tenant-id': tenant.tenantId,
      'x-user-id': tenant.userId,
      'Content-Type': 'application/json',
    };
    const productIds = [...new Set(records.map((record) => text(record.product)).filter(Boolean))];
    const drugIds = [...new Set(records.map((record) => text(record.drug)).filter(Boolean))];
    const productNames = await this.lookupNames(gateway, headers, productIds, 'product');
    const drugNames = await this.lookupNames(gateway, headers, drugIds, 'drug');
    this.logger.log('Pattern record enrichment', {
      tenantId: tenant.tenantId,
      productIds: productIds.length,
      productNames: productNames.size,
      drugIds: drugIds.length,
      drugNames: drugNames.size,
    });
    return records.map((record) => ({
      ...record,
      ...(productNames.get(text(record.product)) ? { productName: productNames.get(text(record.product)) } : {}),
      ...(drugNames.get(text(record.drug)) ? { drugName: drugNames.get(text(record.drug)) } : {}),
    }));
  }

  private sourceRecordRef(record: RecordValue, family: PatternFamily) {
    const recall = family === 'RECALL_PATTERN';
    return {
      id: text(record.id),
      label: text(recall ? record.prnNumber : record.productShortageNumber)
        || text(recall ? record.prnTitle : record.psnTitle)
        || text(record.id),
      title: text(recall ? record.prnTitle : record.psnTitle) || null,
      status: text(recall ? record.status || record.prnStatusCode : record.status || record.psnStatusCode) || null,
      reason: text(recall ? record.productRecallReasonCode : record.productShortageReasonCode) || null,
      product: text(record.productName) || text(record.product) || null,
      drug: text(record.drugName) || text(record.drug) || null,
      lot: recall ? text(record.lot) || null : undefined,
      createdOn: text(record.createdOn) || null,
    };
  }

  private async lookupNames(
    endpoint: string,
    headers: Record<string, string>,
    ids: string[],
    kind: 'product' | 'drug',
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    await Promise.all(ids.map(async (id) => {
      const query = kind === 'product'
        ? `query { getAllProducts(page: { page: 1, search: "${id}", size: 1, sortBy: "" }) { data { id name identifier drug { name } } } }`
        : `query { getAllDrugs(page: { page: 1, search: "${id}", size: 1, sortBy: "" }) { data { id name } } }`;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000)),
        });
        if (!response.ok) return;
        const payload = await response.json() as any;
        const rows = kind === 'product' ? payload?.data?.getAllProducts?.data : payload?.data?.getAllDrugs?.data;
        const match = Array.isArray(rows) ? rows.find((row) => text(row.id) === id) ?? rows[0] : null;
        if (match && text(match.name)) names.set(id, text(match.name));
      } catch (error) {
        this.logger.warn('Pattern record name lookup failed', { kind, id, error: error instanceof Error ? error.message : String(error) });
      }
    }));
    return names;
  }
}
