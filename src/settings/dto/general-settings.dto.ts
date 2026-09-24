import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Wire shape for GET/PATCH /settings/general. Only one knob today —
 * more will follow. Everything optional on PATCH so the FE can
 * ship a partial diff.
 */
export interface GeneralSettingsResponse {
  /**
   * Hours after MARKED_RESOLVED during which a fresh customer reply
   * reopens the same ticket rather than opening a new one. 0 would
   * effectively disable auto-reopen; capped at 30 days to keep the
   * "same ticket" behaviour from swallowing genuinely unrelated
   * threads that reuse a References chain.
   */
  resolvedReopenWindowHours: number;
}

export class UpdateGeneralSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 30)
  resolvedReopenWindowHours?: number;
}
