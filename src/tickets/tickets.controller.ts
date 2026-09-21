import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ListTicketsQuery } from './dto/list-tickets.dto';
import { ReplyTicketDto } from './dto/reply-ticket.dto';
import { TicketDetail, TicketListItem } from './dto/ticket-response.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(
    @Query() query: ListTicketsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TicketListItem[]> {
    return this.tickets.list(query, user);
  }

  /**
   * Numbers for the member top strip. Cheap read — three COUNTs.
   */
  @Get('me/stats')
  myStats(@CurrentUser() user: AuthenticatedUser): Promise<{
    teamQueueCount: number;
    activeOnMe: number;
    resolvedTodayByMe: number;
  }> {
    return this.tickets.myStats(user);
  }

  /**
   * Per-status counts respecting the same scope/channel filters as
   * GET /tickets. Backs the "N behind each filter" counts on the
   * inbox UI so agents (and admins) can see workload distribution at
   * a glance before switching tabs.
   */
  @Get('counts')
  counts(
    @Query() query: ListTicketsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    all: number;
    open: number;
    in_followup: number;
    waiting: number;
    resolved: number;
  }> {
    return this.tickets.counts(query, user);
  }

  /**
   * Every distinct tag ever attached to a ticket — powers the
   * autocomplete in the tag chip editor.
   */
  @Get('tags/all')
  listTags(): Promise<string[]> {
    return this.tickets.listTags();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<TicketDetail> {
    return this.tickets.get(String(id));
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TicketDetail> {
    return this.tickets.update(String(id), dto, user);
  }

  /**
   * Outbound reply from an agent. Sends via the channel's SMTP,
   * threads on the last inbound message, and persists an SENT
   * EmailMessage row + AGENT_REPLIED activity in the same shot.
   */
  @Post(':id/reply')
  reply(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReplyTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TicketDetail> {
    return this.tickets.reply(String(id), dto, user);
  }
}
