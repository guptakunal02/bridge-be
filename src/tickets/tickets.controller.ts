import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ListTicketsQuery } from './dto/list-tickets.dto';
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
}
