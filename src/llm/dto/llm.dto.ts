import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export enum ProviderDto {
  ANTHROPIC = 'ANTHROPIC',
  OPENAI = 'OPENAI',
  OLLAMA = 'OLLAMA',
}

export class CreateLlmConnectionDto {
  @IsEnum(ProviderDto)
  provider!: ProviderDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ValidateIf((dto: CreateLlmConnectionDto) => !dto.apiKeySecretRef)
  @IsString()
  @IsNotEmpty()
  apiKey?: string;

  @ValidateIf((dto: CreateLlmConnectionDto) => !dto.apiKey)
  @IsString()
  @IsNotEmpty()
  apiKeySecretRef?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class UpdateLlmConnectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  apiKey?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  apiKeySecretRef?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class TestLlmConnectionDto {
  @IsString()
  @IsNotEmpty()
  model!: string;
}
