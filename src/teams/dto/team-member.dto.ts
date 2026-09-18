import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class AddMemberDto {
  @IsUUID()
  userId!: string;
}

/**
 * Both fields optional so the same PATCH accepts pause toggles,
 * cap edits, or both together. Empty body is rejected by the
 * service (nothing to do).
 */
export class UpdateMemberDto {
  @IsOptional()
  @IsBoolean()
  pausedInTeam?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxConcurrentTickets?: number;
}
