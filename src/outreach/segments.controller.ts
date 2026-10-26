import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { SegmentsService, type SegmentDetail } from './segments.service';

/**
 * Admin-only CRUD on the Segment aggregate. The upload sub-
 * resource lives on CustomerUploadsController to keep the route
 * trees tidy, but the two share this module's services via DI.
 *
 * Members pagination defaults to 50/page — the admin UI's
 * segment-detail table shows the first page by default and loads
 * more on scroll. Hard-capped at 500/page so a mischievous query
 * string doesn't melt the DB.
 */
@Controller('segments')
@AdminOnly()
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Post()
  async create(
    @Body() body: CreateSegmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string }> {
    const seg = await this.segments.create({
      name: body.name.trim(),
      description: body.description?.trim() ?? null,
      created_by: user.id,
    });
    return { id: seg.id };
  }

  @Get()
  async list(): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      createdAt: Date;
    }>
  > {
    const rows = await this.segments.list();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.createdAt,
    }));
  }

  @Get(':id')
  async getDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SegmentDetail> {
    try {
      return await this.segments.getDetail(id);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw err;
    }
  }

  @Get(':id/members')
  async members(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ): Promise<{
    rows: Array<{
      id: string;
      phone: string;
      countryCode: string | null;
      phoneNumber: string | null;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      marketing_opted_out: boolean;
    }>;
    total: number;
  }> {
    const limit = Math.min(500, Math.max(1, Number(limitRaw) || 50));
    const offset = Math.max(0, Number(offsetRaw) || 0);
    const { rows, total } = await this.segments.listMembers(
      id,
      limit,
      offset,
    );
    return {
      rows: rows.map((c) => ({
        id: c.id,
        phone: c.phone,
        countryCode: c.countryCode,
        phoneNumber: c.phoneNumber,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        marketing_opted_out: c.marketing_opted_out,
      })),
      total,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.segments.remove(id);
  }
}
