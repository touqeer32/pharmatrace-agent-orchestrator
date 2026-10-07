import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum ComplianceResultStatusDto {
  PASS = 'PASS',
  FAIL = 'FAIL',
  REVIEW = 'REVIEW',
}

export enum ComplianceSeverityDto {
  INFO = 'INFO',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export class ComplianceFindingDto {
  @IsString()
  @MaxLength(160)
  ruleId!: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsBoolean()
  requiresResolution?: boolean;

  @IsOptional()
  @IsEnum(ComplianceSeverityDto)
  severity?: ComplianceSeverityDto;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsString()
  phase?: string;

  @IsOptional()
  @IsString()
  field?: string;

  @IsOptional()
  @IsBoolean()
  userCanFix?: boolean;

  @IsOptional()
  @IsString()
  suggestedAction?: string;

  @IsOptional()
  @IsString()
  recommendation?: string;

  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class CreateComplianceReportDto {
  @IsString()
  @MaxLength(120)
  agentType!: string;

  @IsOptional()
  @IsUUID()
  sourceRunId?: string;

  @IsOptional()
  @IsUUID()
  supersedesReportId?: string;

  @IsOptional()
  @IsString()
  revisionReason?: string;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  recordType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  recordId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  sourceSystem?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  sourceVersion?: string;

  @IsOptional()
  @IsString()
  @IsISO8601()
  sourceUpdatedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  recordFingerprint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  creatorName?: string;

  @IsOptional()
  @IsString()
  creatorPublicKey?: string;

  @IsEnum(ComplianceResultStatusDto)
  resultStatus!: ComplianceResultStatusDto;

  @IsOptional()
  @IsEnum(ComplianceSeverityDto)
  severity?: ComplianceSeverityDto;

  @IsString()
  @MaxLength(80)
  ruleSetVersion!: string;

  @IsString()
  summary!: string;

  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  report?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  findings?: ComplianceFindingDto[];

  @IsOptional()
  @IsObject()
  sourceData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  sourceDataDigest?: string;

  @IsOptional()
  @IsString()
  evidenceDigest?: string;

  @IsOptional()
  @IsString()
  issueFingerprint?: string;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  /** Internal workflow status used when an agent review itself fails. */
  @IsOptional()
  @IsString()
  reportStatus?: string;
}

export class DemoSeedDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  count?: number;
}


export class ReportCommentDto {
  @IsString()
  comment!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class FindingResolutionDto {
  @IsString()
  comment!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ReportDecisionDto {
  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class AgentReviewDto {
  @IsIn(['AGREE', 'DISAGREE'])
  decision!: 'AGREE' | 'DISAGREE';

  @IsString()
  comment!: string;

  @IsOptional()
  @IsString()
  revisionReason?: string;

  @IsOptional()
  @IsEnum(ComplianceResultStatusDto)
  resultStatus?: ComplianceResultStatusDto;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  findings?: ComplianceFindingDto[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class WalletPrepareDto {
  @IsString()
  @IsNotEmpty()
  payerAccountId!: string;
}

export class AttestationSubmittedDto {
  @IsOptional()
  @IsUUID()
  attestationId?: string;

  @IsString()
  transactionId!: string;

  @IsString()
  topicId!: string;

  @IsString()
  sequenceNumber!: string;

  @IsString()
  consensusTimestamp!: string;
}
