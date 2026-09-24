import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import {
  CustomerOrdersPage,
  CustomerOrdersService,
} from './customer-orders.service';
import { ListCustomerOrdersQuery } from './dto/list-customer-orders.dto';
import { ListTicketsQuery } from './dto/list-tickets.dto';
import { ReplyTicketDto } from './dto/reply-ticket.dto';
import { TicketDetail, TicketListItem } from './dto/ticket-response.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly orders: CustomerOrdersService,
  ) {}

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
   * Paginated list of orders belonging to the customer whose email
   * opened this ticket. Matches against three JSON paths in the
   * shopify export since the shape varies by source.
   */
  @Get(':id/customer-orders')
  customerOrders(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListCustomerOrdersQuery,
  ): Promise<CustomerOrdersPage> {
    return this.orders.listForTicket(String(id), query);
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

  /**
   * Upload one file for a pending reply. Returns the S3 metadata the
   * composer keeps in local state; the persisted attachment row is
   * only written when POST :id/reply succeeds. Multer holds bytes in
   * memory — capped at 25 MB per file, matching Gmail's max message
   * size headroom so we don't accept files that would bounce.
   */
  @Post(':id/attachments/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  uploadReplyAttachment(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{
    storageKey: string;
    storageUrl: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }> {
    if (!file) {
      throw new BadRequestException(
        'No file received. Use multipart/form-data with a "file" field.',
      );
    }
    return this.tickets.uploadReplyAttachment(String(id), file);
  }
}
