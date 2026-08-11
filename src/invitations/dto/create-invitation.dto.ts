import { AgentRole } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsEnum(AgentRole)
  role?: AgentRole;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  channelIds?: string[];
}
