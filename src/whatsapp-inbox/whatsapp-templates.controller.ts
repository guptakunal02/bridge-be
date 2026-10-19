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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappTemplateStatus } from '../database/enums';
import { CreateWhatsappTemplateDto } from './dto/create-whatsapp-template.dto';
import {
  toTemplateResponse,
  type WhatsappTemplateResponse,
} from './dto/whatsapp-template-response.dto';
import { WhatsappTemplate } from './entities/whatsapp-template.entity';
import { WhatsappTemplatesService } from './whatsapp-templates.service';

/**
 * HTTP surface for WhatsApp template management. All routes mounted
 * under /channels/:channelId/whatsapp-templates so the FE can scope
 * reads/writes to the right WhatsApp channel (the only kind of
 * channel that has templates).
 *
 * Auth: no explicit role guard. Any signed-in member can list, sync,
 * and create templates — the user explicitly chose "global templates
 * any member can author." If this needs to tighten later (admin-only
 * create), add @Roles(UserRole.ADMIN) on `create`.
 */
@Controller('channels/:channelId/whatsapp-templates')
export class WhatsappTemplatesController {
  constructor(
    private readonly templatesService: WhatsappTemplatesService,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
  ) {}

  /**
   * List templates for a channel. `status` filter is optional —
   * composer picker passes `?status=APPROVED` so only usable templates
   * are returned; settings page omits it to show the full inventory
   * including PENDING / REJECTED rows.
   */
  @Get()
  async list(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query('status') statusRaw?: string,
  ): Promise<WhatsappTemplateResponse[]> {
    const status = this.parseStatus(statusRaw);
    const rows = await this.templatesService.list(channelId, { status });
    // creator relation isn't eager-loaded by the service's list()
    // call — re-fetch with the relation when we need the display
    // name. V1 keeps this simple with a second query; could flip to
    // leftJoinAndSelect later if load warrants.
    const withCreators = await this.templates.find({
      where: { channelId, ...(status ? { status } : {}) },
      relations: { creator: true },
      order: { updatedAt: 'DESC' },
    });
    return withCreators.map(toTemplateResponse);
  }

  /**
   * Pull-from-Meta sync. Idempotent: upserts by (channel, name,
   * language). Returns the number of rows touched so the FE can
   * toast the count.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<{ synced: number }> {
    return this.templatesService.sync(channelId);
  }

  /**
   * Submit a new template to Meta + persist local PENDING row. The
   * FE polls / refreshes to see status flip to APPROVED/REJECTED
   * once Meta's review completes (usually within a few hours).
   */
  @Post()
  async create(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWhatsappTemplateDto,
  ): Promise<WhatsappTemplateResponse> {
    const row = await this.templatesService.create(channelId, user.id, dto);
    const withCreator = await this.templates.findOne({
      where: { id: row.id },
      relations: { creator: true },
    });
    return toTemplateResponse(withCreator ?? row);
  }

  private parseStatus(raw?: string): WhatsappTemplateStatus | undefined {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    const options = Object.values(WhatsappTemplateStatus) as string[];
    if (!options.includes(upper)) return undefined;
    return upper as WhatsappTemplateStatus;
  }
}
