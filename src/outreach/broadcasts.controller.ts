import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { BroadcastRecipientStatus } from '../database/enums';
import { BroadcastsService, type BroadcastDetail } from './broadcasts.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';

/**
 * Admin-only CRUD + lifecycle on marketing broadcasts.
 *
 * Pricing / rate-limit knobs (`maxTries`, `retryWindowMinutes`,
 * `headerImageUrlOverride`) live on the create DTO so admins can
 * configure per-campaign without touching defaults — "flash sale"
 * might want 1 try, 10 min window + a custom hero image; "weekly
 * drop" might want the template's defaults.
 */
@Controller('broadcasts')
@AdminOnly()
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Post()
  async create(
    @Body() dto: CreateBroadcastDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string }> {
    const row = await this.broadcasts.create(user.id, {
      name: dto.name,
      segmentId: dto.segmentId,
      templateId: dto.templateId,
      scheduledFor: dto.scheduledFor,
      maxTries: dto.maxTries,
      retryWindowMinutes: dto.retryWindowMinutes,
      headerImageUrlOverride: dto.headerImageUrlOverride,
      perMessageBidMultiplier: dto.perMessageBidMultiplier,
    });
    return { id: row.id };
  }

  @Get()
  async list(): Promise<
    Array<{
      id: string;
      name: string;
      status: string;
      total_recipients: number;
      sent_count: number;
      delivered_count: number;
      read_count: number;
      failed_count: number;
      createdAt: Date;
      scheduled_for: Date | null;
      completed_at: Date | null;
    }>
  > {
    const rows = await this.broadcasts.list();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      total_recipients: r.total_recipients,
      sent_count: r.sent_count,
      delivered_count: r.delivered_count,
      read_count: r.read_count,
      failed_count: r.failed_count,
      createdAt: r.createdAt,
      scheduled_for: r.scheduled_for,
      completed_at: r.completed_at,
    }));
  }

  @Get(':id')
  async getDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BroadcastDetail> {
    return this.broadcasts.getDetail(id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string; status: string }> {
    const row = await this.broadcasts.start(id);
    return { id: row.id, status: row.status };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string; status: string }> {
    const row = await this.broadcasts.cancel(id);
    return { id: row.id, status: row.status };
  }

  @Get(':id/recipients')
  async listRecipients(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('status') statusRaw?: string,
  ): Promise<{
    rows: Array<{
      id: string;
      phone: string;
      status: BroadcastRecipientStatus;
      wam_id: string | null;
      attempts: number;
      last_error: string | null;
      sent_at: Date | null;
      delivered_at: Date | null;
      read_at: Date | null;
    }>;
    total: number;
  }> {
    const limit = Math.min(500, Math.max(1, Number(limitRaw) || 50));
    const offset = Math.max(0, Number(offsetRaw) || 0);
    const status = parseRecipientStatus(statusRaw);
    const { rows, total } = await this.broadcasts.listRecipients(
      id,
      limit,
      offset,
      status,
    );
    return {
      rows: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        status: r.status,
        wam_id: r.wam_id,
        attempts: r.attempts,
        last_error: r.last_error,
        sent_at: r.sent_at,
        delivered_at: r.delivered_at,
        read_at: r.read_at,
      })),
      total,
    };
  }
}

function parseRecipientStatus(
  v: string | undefined,
): BroadcastRecipientStatus | undefined {
  if (!v) return undefined;
  const upper = v.toUpperCase() as BroadcastRecipientStatus;
  const options = Object.values(BroadcastRecipientStatus) as string[];
  if (!options.includes(upper)) return undefined;
  return upper;
}
