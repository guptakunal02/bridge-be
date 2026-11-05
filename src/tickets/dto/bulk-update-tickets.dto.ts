import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { TicketStatus } from '../../database/enums';
import { ListTicketsQuery } from './list-tickets.dto';

/**
 * Payload for POST /tickets/bulk. Applies the same patch to a
 * batch of tickets — reuses TicketsService.update() per ticket
 * so every side effect (activity logs, resolved_at stamping,
 * capacity backfill on freed assignees) fires just as it would
 * for a single PATCH.
 *
 * Only two status transitions are supported here on purpose:
 *   - OPEN   (e.g. bulk-reopen resolved tickets)
 *   - RESOLVED (e.g. bulk-close a load of newsletter spam)
 * WAITING / IN_FOLLOWUP need per-ticket resumeAtHours, so those
 * timed transitions don't make sense in a "one patch for all"
 * bulk shape. Agents can still fall back to per-ticket for those.
 *
 * Tags are set-with-union semantics: whatever is in `addTags`
 * gets added to each ticket's existing tags. Bulk-removing tags
 * would require a separate field and clutters the modal — punt
 * until asked.
 */
const BULK_STATUS_OPTIONS: TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.RESOLVED,
];

export class BulkUpdateTicketsDto {
  /**
   * Ticket ids to patch. Required unless `selectAll` is true. Cap
   * 100 — explicit multi-select from the inbox is a one-page batch,
   * anything bigger goes through the filter-based path below. Each
   * id is validated as a positive-integer string so ParseBigintId
   * Pipe-style precision loss can't sneak in via the body.
   */
  @ValidateIf((o: BulkUpdateTicketsDto) => o.selectAll !== true)
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[1-9]\d{0,18}$/, { each: true })
  ticketIds?: string[];

  /**
   * "Apply to every ticket matching `filter`, minus `excludeIds`."
   * Mutually exclusive with the explicit `ticketIds` path. Service
   * resolves the full id set via TicketsService.listIds (capped at
   * IDS_SAFETY_CAP = 10k) before fanning out the per-ticket patches.
   * Lets the inbox fire one bulk request for "all 573 bot tickets"
   * without transferring 573 ids over the wire.
   */
  @IsOptional()
  @IsBoolean()
  selectAll?: boolean;

  /**
   * Filter used to resolve the target id set when `selectAll=true`.
   * Shape matches GET /tickets — statuses/scope/channelIds/etc —
   * so the same validation logic applies to both read and write
   * paths. Required when selectAll is true, ignored otherwise.
   */
  @ValidateIf((o: BulkUpdateTicketsDto) => o.selectAll === true)
  @ValidateNested()
  @Type(() => ListTicketsQuery)
  filter?: ListTicketsQuery;

  /**
   * Ids to subtract from the filter-resolved set. Supports the
   * "select all 573, then uncheck a few" UX without the client
   * needing to send every id it actually wants modified. Cap matches
   * ticketIds so a pathological client can't abuse this path.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[1-9]\d{0,18}$/, { each: true })
  excludeIds?: string[];

  @IsOptional()
  @IsEnum(TicketStatus)
  @IsIn(BULK_STATUS_OPTIONS)
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  /**
   * Tag names to append to each ticket's existing tag set. Same
   * shape rules as the single-ticket update — lowercase letters,
   * digits, dashes; 1–40 chars.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  @Matches(/^[a-z0-9-]+$/, {
    each: true,
    message:
      'Tags must be lowercase letters, digits, or dashes (e.g. refund-request)',
  })
  addTags?: string[];
}

/**
 * One-ticket result inside the bulk response. `reason` is the
 * human-readable error surfaced in the FE toast when the individual
 * PATCH failed (validation, permission, no-op, etc.).
 */
export interface BulkUpdateResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
}
