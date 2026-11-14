import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TicketStatus } from '../../database/enums';

/**
 * Which slice of the queue to show.
 *  - `mine`       → tickets assigned to the caller
 *  - `unassigned` → tickets still parked on the BOT user
 *  - `all`        → no assignee filter (default)
 */
export type TicketScope = 'mine' | 'unassigned' | 'all';

/**
 * How the list is ordered — the FE toggle picks between:
 *   `latest`  — most recent activity first (uses updatedAt, which
 *               bumps on any status/tag/assignee change AND on
 *               new-message ingest). Default; matches Gmail /
 *               Zendesk / LimeChat.
 *   `created` — most recently opened ticket first (uses createdAt).
 */
export type TicketSortBy = 'latest' | 'created';

/**
 * Query-string arrays arrive as either a single string (?statuses=OPEN)
 * or a comma-separated string (?statuses=OPEN,WAITING) or a
 * repeated key (?statuses=OPEN&statuses=WAITING). Normalise the
 * first two into an array so class-validator's array validators
 * do the right thing; the repeated-key case is already an array
 * by the time class-transformer hands us the value.
 */
const csvToArray = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return value;
};

export class ListTicketsQuery {
  /**
   * Legacy single-value filter kept for backward compat with any
   * external caller. The FE uses `statuses` instead.
   */
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  /**
   * Multi-status filter used by the admin filter panel. `OPEN`
   * alone reads as "just live"; `OPEN,WAITING,IN_FOLLOWUP` reads
   * as "everything not resolved."
   */
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMaxSize(4)
  @IsEnum(TicketStatus, { each: true })
  statuses?: TicketStatus[];

  @IsOptional()
  @IsEnum(['mine', 'unassigned', 'all'])
  scope?: TicketScope;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  /**
   * Multi-channel filter used by the admin filter panel. Empty /
   * missing means "all channels."
   */
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  channelIds?: string[];

  /**
   * Multi-assignee filter (admin panel). Empty / missing means
   * "any assignee". Pass the BOT user id to filter down to the
   * unassigned queue if you don't want to use `scope=unassigned`.
   */
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  /**
   * Case-insensitive substring match against any email_message on
   * the ticket — matches on sender address or subject line.
   * Length-capped to keep the ILIKE cheap.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsEnum(['latest', 'created'])
  sortBy?: TicketSortBy;

  /**
   * Open/Bot tab split on the server side.
   *   "true"   → only OPEN tickets with assignee=BOT user (Bot tab)
   *   "false"  → only OPEN tickets with assignee!=BOT user or NULL
   *              (Open tab + the unassigned queue)
   *   unset    → no filter (legacy)
   *
   * Declared as a literal string, NOT boolean, on purpose. The
   * ValidationPipe in main.ts runs with enableImplicitConversion
   * which coerces any non-empty string into `true` via Boolean(v)
   * for @IsBoolean fields — so `botActive=false` was arriving at
   * the service as `true` and the EXISTS branch was firing on the
   * Open tab, returning 100% BOT-assignee rows. The string shape
   * dodges that entirely; the service converts to boolean itself.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  botActive?: 'true' | 'false';

  /**
   * Multi-tag filter used by the admin filter panel. Case-sensitive
   * exact match on tag name (tags are normalised to lowercase at
   * write time, so the FE lower-cases the input before sending here).
   * Semantics are OR within the section: a ticket qualifies if it
   * carries ANY of the listed tags. Combines AND with the other
   * sections (status, channel, assignee, date) per the usual filter
   * UI pattern.
   */
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  /**
   * Inclusive calendar date in YYYY-MM-DD form, interpreted as midnight
   * IST that day. "Give me tickets created on or after this day in
   * IST." Omitted → no lower bound. Paired with `createdTo`; both can
   * be the same date to filter to a single day.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'createdFrom must be an ISO date (YYYY-MM-DD)',
  })
  createdFrom?: string;

  /**
   * Inclusive calendar date in YYYY-MM-DD form, IST. "Give me tickets
   * created on or before the END of this day in IST." Service converts
   * to `< (date+1 day) in IST` so the whole day is included even
   * though ticket.createdAt is a timestamptz.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'createdTo must be an ISO date (YYYY-MM-DD)',
  })
  createdTo?: string;
}
