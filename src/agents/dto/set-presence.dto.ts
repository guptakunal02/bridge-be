import { AgentStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class SetPresenceDto {
  @IsEnum(AgentStatus)
  status!: AgentStatus;
}
