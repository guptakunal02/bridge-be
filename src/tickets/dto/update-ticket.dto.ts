import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TicketStatus } from '../../database/enums';

/** Values allowed in the resumeAtHours dropdown. Keep in sync with FE. */
export const RESUME_HOUR_OPTIONS = [1, 2, 4, 8, 24] as const;

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  /**
   * How many hours from now until the ticket's timer fires.
   * Required when `status` is WAITING or IN_FOLLOWUP; ignored
   * otherwise. Values match the FE dropdown.
   */
  @IsOptional()
  @IsIn(RESUME_HOUR_OPTIONS as unknown as number[])
  resumeAtHours?: number;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  /**
   * Force-move the ticket to a different team. Bypasses the routing
   * rules that would normally decide team_id at ingest — this is
   * how an admin drops a mis-routed thread into the right queue.
   */
  @IsOptional()
  @IsUUID()
  teamId?: string;

  /**
   * The full set of tags this ticket should carry after the update.
   * Set-semantics (not add/remove): whatever you send replaces what
   * was there. Keeps the API idempotent and the wire format simple.
   *
   * Each tag: 1-40 chars, lowercase letters / digits / dashes only —
   * so `refund-request` is fine, `Refund Request!` is not. Enforcing
   * a stable shape here means routing-rule matches never fail on
   * whitespace or casing quirks.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(40, { each: true })
  @Matches(/^[a-z0-9-]+$/, {
    each: true,
    message:
      'Tags must be lowercase letters, digits, or dashes (e.g. refund-request)',
  })
  tags?: string[];
}
