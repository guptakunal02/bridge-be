import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { TicketStatus } from '../../database/enums';

/**
 * Which slice of the queue to show.
 *  - `mine`       → tickets assigned to the caller
 *  - `unassigned` → tickets still parked on the BOT user
 *  - `all`        → no assignee filter (default)
 */
export type TicketScope = 'mine' | 'unassigned' | 'all';

export class ListTicketsQuery {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(['mine', 'unassigned', 'all'])
  scope?: TicketScope;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
