import { AgentRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, MaxLength } from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsEnum(AgentRole)
  role?: AgentRole;
}
