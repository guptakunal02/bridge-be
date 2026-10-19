import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import type { EnvVars } from '../config/env.validation';
import {
  ChannelType,
  WhatsappTemplateCategory,
  WhatsappTemplateStatus,
} from '../database/enums';
import { WhatsappTemplate } from './entities/whatsapp-template.entity';

/**
 * Shape of one entry in Meta's GET /{waba_id}/message_templates
 * response. We only consume the fields we need; Meta adds more
 * (quality_score, previous_category, …) that aren't load-bearing
 * for V1.
 */
interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: Array<{
    type: string;
    text?: string;
    format?: string;
  }>;
  rejected_reason?: string | null;
}

interface MetaListResponse {
  data?: MetaTemplate[];
  paging?: { cursors?: { before?: string; after?: string } };
}

interface MetaCreateResponse {
  id: string;
  status: string;
  category: string;
}

interface MetaErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/**
 * Count distinct `{{n}}` placeholders in a template body. Returns the
 * highest-numbered placeholder seen so we match Meta's convention of
 * "variables are 1..N without gaps." Meta rejects templates with
 * gaps (e.g. {{1}} and {{3}} but no {{2}}) so we don't validate
 * gaps here — Meta will reject on create.
 */
function countVariables(body: string): number {
  const matches = body.match(/\{\{(\d+)\}\}/g) ?? [];
  if (matches.length === 0) return 0;
  return matches
    .map((m) => Number(m.slice(2, -2)))
    .reduce((max, n) => (n > max ? n : max), 0);
}

/**
 * Fill a Meta template body's `{{1}}`, `{{2}}`, … placeholders with
 * the matching value from `variables` (1-indexed → array[0]). Used
 * both when persisting the outbound WhatsappMessage row (so the
 * agent-side thread shows the actual filled text, not raw template
 * body) and when previewing in the FE picker.
 */
export function renderTemplateBody(body: string, variables: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, num: string) => {
    const idx = Number(num) - 1;
    const v = variables[idx];
    return v === undefined || v === null ? '' : String(v);
  });
}

@Injectable()
export class WhatsappTemplatesService {
  private readonly logger = new Logger(WhatsappTemplatesService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
  ) {}

  /**
   * Return all templates for a channel, newest first. Status filter
   * is applied at the SQL layer so the picker only sees APPROVED
   * rows without a FE-side filter.
   */
  async list(
    channelId: string,
    opts: { status?: WhatsappTemplateStatus } = {},
  ): Promise<WhatsappTemplate[]> {
    await this.assertWhatsappChannel(channelId);
    const where = opts.status
      ? { channelId, status: opts.status }
      : { channelId };
    return this.templates.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Fetch all templates from Meta for the WABA tied to this channel
   * and upsert into whatsapp_template. One row per (channel, name,
   * language) — if a template exists locally, its status / category /
   * body get overwritten from Meta's authoritative copy; otherwise a
   * new row lands (with createdBy = null since it was authored in
   * Meta BM, not Bridge).
   *
   * Returns the number of rows upserted so the FE can toast
   * "Synced 12 templates".
   */
  async sync(channelId: string): Promise<{ synced: number }> {
    await this.assertWhatsappChannel(channelId);
    const wabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });

    // Meta paginates — V1 just grabs the first page (limit=200, Meta's
    // default max). If a merchant has 200+ templates we'll iterate
    // next_cursor in V2.
    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=200`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (netErr) {
      this.logger.error(
        `Template sync network error: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw new BadRequestException(
        'Could not reach WhatsApp to sync templates — retry in a moment',
      );
    }

    if (!res.ok) {
      const body: MetaErrorEnvelope = await res.json().catch(() => ({}));
      const msg =
        body.error?.error_user_msg ??
        body.error?.message ??
        `Meta template list failed (HTTP ${res.status})`;
      this.logger.error(`Template sync failed: ${msg}`);
      throw new BadRequestException(msg);
    }

    const payload: MetaListResponse = await res.json();
    const items = payload.data ?? [];
    let synced = 0;
    for (const t of items) {
      // Only BODY-type components carry {{n}} + the main text; HEADER
      // can be text/image/video/document, FOOTER is a short tagline,
      // BUTTONS are quick-replies / URLs. V1 picker renders BODY only.
      const bodyComp = (t.components ?? []).find((c) => c.type === 'BODY');
      const body = bodyComp?.text?.trim();
      if (!body) {
        this.logger.debug(
          `Skipping template ${t.name}/${t.language} — no BODY component text`,
        );
        continue;
      }
      const category = this.mapMetaCategory(t.category);
      const status = this.mapMetaStatus(t.status);
      if (!category) {
        this.logger.debug(
          `Skipping template ${t.name}/${t.language} — unknown category ${t.category}`,
        );
        continue;
      }
      const existing = await this.templates.findOne({
        where: { channelId, name: t.name, language: t.language },
      });
      if (existing) {
        existing.category = category;
        existing.status = status;
        existing.body = body;
        existing.variableCount = countVariables(body);
        existing.metaTemplateId = t.id;
        existing.rejectionReason = t.rejected_reason ?? null;
        await this.templates.save(existing);
      } else {
        await this.templates.save(
          this.templates.create({
            channelId,
            name: t.name,
            language: t.language,
            category,
            status,
            body,
            variableCount: countVariables(body),
            metaTemplateId: t.id,
            rejectionReason: t.rejected_reason ?? null,
            createdBy: null,
          }),
        );
      }
      synced += 1;
    }
    this.logger.log(`Synced ${synced} templates for channel ${channelId}`);
    return { synced };
  }

  /**
   * Submit a new template to Meta + persist the local PENDING row.
   * Meta's review usually completes within a few hours; the FE
   * admin page shows PENDING → APPROVED / REJECTED after the next
   * sync pass.
   *
   * Throws CONFLICT if a (channel, name, language) row already exists
   * — Meta's own API returns 400 in that case too but we short-circuit
   * before even hitting Meta.
   */
  async create(
    channelId: string,
    createdBy: string,
    dto: {
      name: string;
      category: WhatsappTemplateCategory;
      language: string;
      body: string;
    },
  ): Promise<WhatsappTemplate> {
    await this.assertWhatsappChannel(channelId);
    const existing = await this.templates.findOne({
      where: { channelId, name: dto.name, language: dto.language },
    });
    if (existing) {
      throw new ConflictException(
        `A template named "${dto.name}" (${dto.language}) already exists for this channel`,
      );
    }

    const wabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

    const payload = {
      name: dto.name,
      language: dto.language,
      category: dto.category,
      components: [{ type: 'BODY', text: dto.body }],
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      this.logger.error(
        `Template create network error: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw new BadRequestException(
        'Could not reach WhatsApp to submit template — retry in a moment',
      );
    }

    if (!res.ok) {
      const body: MetaErrorEnvelope = await res.json().catch(() => ({}));
      const msg =
        body.error?.error_user_msg ??
        body.error?.message ??
        `Meta template create failed (HTTP ${res.status})`;
      this.logger.warn(`Template create rejected: ${msg}`);
      throw new BadRequestException(msg);
    }

    const metaResp: MetaCreateResponse = await res.json();
    const status = this.mapMetaStatus(metaResp.status);
    const category = this.mapMetaCategory(metaResp.category) ?? dto.category;

    const row = await this.templates.save(
      this.templates.create({
        channelId,
        name: dto.name,
        language: dto.language,
        category,
        status,
        body: dto.body,
        variableCount: countVariables(dto.body),
        metaTemplateId: metaResp.id,
        rejectionReason: null,
        createdBy,
      }),
    );
    this.logger.log(
      `Submitted template ${dto.name}/${dto.language} to Meta — id=${metaResp.id} status=${status}`,
    );
    return row;
  }

  /**
   * Fetch an APPROVED template by id — used by the ticket's
   * send-template path to resolve name + language + variableCount
   * before calling the sender. Throws 404 if not found, 400 if not
   * usable (status !== APPROVED).
   */
  async findSendable(id: string): Promise<WhatsappTemplate> {
    const row = await this.templates.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Template not found');
    if (row.status !== WhatsappTemplateStatus.APPROVED) {
      throw new BadRequestException(
        `Template "${row.name}" is ${row.status} — only APPROVED templates can be sent`,
      );
    }
    return row;
  }

  private async assertWhatsappChannel(channelId: string): Promise<void> {
    const channel = await this.channels.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.WHATSAPP) {
      throw new BadRequestException(
        'Templates are only available on WhatsApp channels',
      );
    }
  }

  private mapMetaCategory(input: string): WhatsappTemplateCategory | null {
    const normalized = input?.toUpperCase();
    if (normalized === 'UTILITY') return WhatsappTemplateCategory.UTILITY;
    if (normalized === 'MARKETING') return WhatsappTemplateCategory.MARKETING;
    if (normalized === 'AUTHENTICATION') {
      return WhatsappTemplateCategory.AUTHENTICATION;
    }
    return null;
  }

  private mapMetaStatus(input: string): WhatsappTemplateStatus {
    const normalized = input?.toUpperCase();
    switch (normalized) {
      case 'APPROVED':
        return WhatsappTemplateStatus.APPROVED;
      case 'REJECTED':
        return WhatsappTemplateStatus.REJECTED;
      case 'PAUSED':
        return WhatsappTemplateStatus.PAUSED;
      case 'DISABLED':
        return WhatsappTemplateStatus.DISABLED;
      case 'PENDING':
      case 'IN_APPEAL':
      case 'PENDING_DELETION':
      default:
        return WhatsappTemplateStatus.PENDING;
    }
  }
}
