import { ConversationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateConversationDto {
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;
}

export class AssignConversationDto {
  // null unassigns; string agentId assigns to that agent (admin can pick anyone
  // on the channel; agents can only self-assign).
  @IsOptional()
  agentId?: string | null;
}
