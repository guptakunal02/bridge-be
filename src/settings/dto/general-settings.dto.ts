import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Wire shape for GET/PATCH /settings/general. Everything optional on
 * PATCH so the FE can ship a partial diff.
 *
 * Reopen window: now split per-channel. The legacy single field is
 * still returned (populated from the email window) for one deploy
 * cycle so an older FE build pointing at a newer BE keeps rendering
 * a sane value. Can be removed once every surface has moved to the
 * channel-specific fields.
 */
export interface GeneralSettingsResponse {
  /**
   * @deprecated use emailResolvedReopenWindowHours /
   * whatsappResolvedReopenWindowHours. Preserved for FE back-compat;
   * mirrors the email window on reads.
   */
  resolvedReopenWindowHours: number;
  emailResolvedReopenWindowHours: number;
  whatsappResolvedReopenWindowHours: number;
  /**
   * When true, RESOLVED transitions and WAITING-with-AUTO_RESOLVE
   * transitions require the ticket to carry at least one tag. Keeps
   * every closed ticket categorised for reporting.
   */
  requireTagToResolve: boolean;
}

export class UpdateGeneralSettingsDto {
  /**
   * @deprecated. If the client sends only this field (older FE), we
   * apply it to BOTH channel-specific windows so the admin's intent
   * — a single global cutoff — still takes effect.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 30)
  resolvedReopenWindowHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 30)
  emailResolvedReopenWindowHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 30)
  whatsappResolvedReopenWindowHours?: number;

  @IsOptional()
  @IsBoolean()
  requireTagToResolve?: boolean;
}
