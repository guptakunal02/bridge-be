import { AgentRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(500)
  avatarUrl?: string;

  // Admin-only field; enforced in the service, not by the DTO.
  @IsOptional()
  @IsEnum(AgentRole)
  role?: AgentRole;
}
