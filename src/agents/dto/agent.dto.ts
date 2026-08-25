import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ProviderDto } from '../../llm/dto/llm.dto';

export enum TriggerModeDto {
  MANUAL = 'MANUAL',
  SCHEDULED = 'SCHEDULED',
  BOTH = 'BOTH',
}

export class CreateAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsNotEmpty()
  expectedOutput!: string;

  @IsOptional()
  @IsEnum(TriggerModeDto)
  triggerMode?: TriggerModeDto;

  @IsUUID()
  llmConnectionId!: string;

  @IsEnum(ProviderDto)
  llmProvider!: ProviderDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  llmModel!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxIterations?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxToolCalls?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  executionTimeoutSeconds?: number;

  @IsOptional()
  @IsObject()
  defaultInput?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  allowedMcpServerIds!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  allowedMcpToolIds!: string[];
}

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  expectedOutput?: string;

  @IsOptional()
  @IsEnum(TriggerModeDto)
  triggerMode?: TriggerModeDto;

  @IsOptional()
  @IsUUID()
  llmConnectionId?: string;

  @IsOptional()
  @IsEnum(ProviderDto)
  llmProvider?: ProviderDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  llmModel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxIterations?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxToolCalls?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  executionTimeoutSeconds?: number;

  @IsOptional()
  @IsObject()
  defaultInput?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  allowedMcpServerIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  allowedMcpToolIds?: string[];
}

export class RunAgentDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  forceReplan?: boolean;
}
