import { ConversationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export type AssigneeFilter = 'me' | 'unassigned' | 'all';

export class ListConversationsDto {
  @IsOptional()
  @IsIn(['me', 'unassigned', 'all'])
  assignee?: AssigneeFilter;

  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown => {
    if (Array.isArray(value)) return value as string[];
    if (typeof value === 'string') return value.split(',').filter(Boolean);
    return value;
  })
  @IsArray()
  @IsEnum(ConversationStatus, { each: true })
  status?: ConversationStatus[];

  @IsOptional()
  @IsUUID('4')
  channelId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
