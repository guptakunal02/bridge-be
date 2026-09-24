import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TicketStatus } from '../../database/enums';

/** Hard upper bound on ticket timers — 30 days feels comfortable
 * for followups/waiting; anything longer usually means "close it". */
export const RESUME_MAX_HOURS = 24 * 30;

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  /**
   * How many hours from now until the ticket's timer fires.
   * Required when `status` is WAITING or IN_FOLLOWUP; ignored
   * otherwise. Fractional values are allowed so the FE can send
   * a combined hrs+min picker as decimal hours (e.g. 1h 15m → 1.25).
   * Minimum ~1 minute so a fat-finger 0 is rejected; capped at
   * 30 days.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(1 / 60)
  @Max(RESUME_MAX_HOURS)
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
