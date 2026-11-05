import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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
   * Split OPEN tickets by bot-session membership. Matches the
   * client-side Open/Bot tab divide:
   *   true   → only OPEN tickets with an ACTIVE bot_session and
   *            assignee=BOT user (the "Bot" tab's set)
   *   false  → OPEN tickets WITHOUT an active bot session (the
   *            "Open" tab's set after the bot rows have moved aside)
   *   unset  → no bot-session filter (legacy behaviour; `list` does
   *            a client-side split on the response)
   * Primarily used by the inbox "Select all N matching" affordance
   * so the bulk endpoint resolves to the same slice the agent
   * actually sees.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  botActive?: boolean;
}
