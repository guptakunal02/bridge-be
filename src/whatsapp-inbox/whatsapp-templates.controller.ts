import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappTemplateStatus } from '../database/enums';
import { CreateWhatsappTemplateDto } from './dto/create-whatsapp-template.dto';
import { TestSendTemplateDto } from './dto/test-send-template.dto';
import {
  toTemplateResponse,
  type WhatsappTemplateResponse,
} from './dto/whatsapp-template-response.dto';
import { WhatsappTemplate } from './entities/whatsapp-template.entity';
import { WhatsappMediaUploadService } from './whatsapp-media-upload.service';
import {
  WhatsappReachEstimateService,
  type ReachEstimateDateInterval,
  type ReachEstimateResponse,
} from './whatsapp-reach-estimate.service';
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
    private readonly mediaUpload: WhatsappMediaUploadService,
    private readonly reachEstimate: WhatsappReachEstimateService,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
  ) {}

  /**
   * Marketing Messages Lite reach-estimate proxy. Returns Meta's
   * bid-vs-delivery curve for the given country + lookback window.
   * The admin UI uses this to render the max-price slider in
   * template authoring and in broadcast creation.
   *
   * The route is auth-protected (any logged-in member) because it
   * exposes the WABA token's pricing surface implicitly; keeping it
   * out of public reach prevents an outsider from scraping Meta's
   * pricing curve via Bridge.
   */
  @Get('reach-estimate')
  async getReachEstimate(
    @Query('country') country?: string,
    @Query('dateInterval') dateInterval?: string,
  ): Promise<ReachEstimateResponse> {
    const normCountry = (country ?? 'IN').toUpperCase();
    const INTERVAL_OPTIONS: ReachEstimateDateInterval[] = [
      'L1D',
      'L7D',
      'L14D',
      'L28D',
    ];
    const normInterval = INTERVAL_OPTIONS.includes(
      (dateInterval ?? 'L7D') as ReachEstimateDateInterval,
    )
      ? ((dateInterval ?? 'L7D') as ReachEstimateDateInterval)
      : 'L7D';
    return this.reachEstimate.estimate({
      country: normCountry,
      dateInterval: normInterval,
    });
  }

  /**
   * Upload a header image for template authoring. Two-sided
   * handshake under the hood (S3 + Meta's Resumable Upload) — see
   * WhatsappMediaUploadService. The returned handle is required
   * when later submitting a template with headerType=IMAGE; the
   * URL is stored on the template row for admin preview + the
   * send-time image.link parameter.
   *
   * Memory storage (not disk) because the max image is 5MB and
   * the service streams the buffer straight to S3 + Meta — no
   * reason to touch /tmp.
   */
  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadMedia(
    @Param('channelId', ParseUUIDPipe) _channelId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ url: string; handle: string }> {
    if (!file) throw new BadRequestException('file field is required');
    return this.mediaUpload.uploadImageForTemplateHeader(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
  }

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
   * Fetch a single template by its short integer `number` (not UUID).
   * Backs the FE's detail-page route /outreach/whatsapp/templates/:n.
   * Scoped to the given channel so the URL stays self-describing.
   */
  @Get('by-number/:n')
  async byNumber(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('n') nParam: string,
  ): Promise<WhatsappTemplateResponse> {
    const n = Number(nParam);
    if (!Number.isInteger(n) || n <= 0) {
      throw new NotFoundException('Template not found');
    }
    const row = await this.templates.findOne({
      where: { channelId, number: String(n) },
      relations: { creator: true },
    });
    if (!row) throw new NotFoundException('Template not found');
    return toTemplateResponse(row);
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

  /**
   * Fire a one-off test send of this APPROVED template to a specific
   * phone number — surfaces no ticket, no DB row, no activity log.
   * Lets admins verify template content + variable substitution
   * before using it on real customers.
   */
  @Post(':templateId/test')
  @HttpCode(HttpStatus.OK)
  async testSend(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TestSendTemplateDto,
  ): Promise<{ wamid: string }> {
    return this.templatesService.testSend(
      templateId,
      channelId,
      user.id,
      dto.phoneNumber,
      dto.variableOverrides ?? {},
    );
  }

  private parseStatus(raw?: string): WhatsappTemplateStatus | undefined {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    const options = Object.values(WhatsappTemplateStatus) as string[];
    if (!options.includes(upper)) return undefined;
    return upper as WhatsappTemplateStatus;
  }
}
