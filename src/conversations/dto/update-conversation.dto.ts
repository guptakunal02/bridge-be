import { ConversationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateConversationDto {
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;
}

export class AssignConversationDto {
  // null unassigns; string userId assigns to that user (admin can pick anyone
  // on the channel; users can only self-assign).
  @IsOptional()
  userId?: string | null;
}
