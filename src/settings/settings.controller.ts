import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator';
import type { EnvVars } from '../config/env.validation';
import { UserRole } from '../database/enums';
import { ClickpostWebhooksService } from '../clickpost-webhooks/clickpost-webhooks.service';
import { LensWebhooksService } from '../lens-webhooks/lens-webhooks.service';
import { ReturnPrimeWebhooksService } from '../return-prime-webhooks/return-prime-webhooks.service';
import type { TopicStatRow } from '../shopify-webhooks/shopify-webhooks.service';
import { ShopifyWebhooksService } from '../shopify-webhooks/shopify-webhooks.service';
import { WhatsappMessage } from '../whatsapp-inbox/entities/whatsapp-message.entity';
import { AppSettingsService } from './app-settings.service';
import {
  GeneralSettingsResponse,
  UpdateGeneralSettingsDto,
} from './dto/general-settings.dto';
import {
  INTEGRATION_API_CALLS,
  INTEGRATION_WEBHOOK_TOPICS,
  type ApiCallCatalogEntry,
  type WebhookTopicCatalogEntry,
} from './integration-catalog';

export interface IntegrationsResponse {
  shopify: {
    /** True when both the secret and shop domain are set in env. */
    configured: boolean;
    /** Shop domain from env (non-secret), null when unconfigured. */
    shopDomain: string | null;
    /** Last webhook received_at for this shop, null when none seen. */
    lastEventAt: string | null;
  };
  returnPrime: {
    /** True when the access token env var is set. */
    configured: boolean;
    /** ISO timestamp of the most recent RP webhook, null when none seen. */
    lastEventAt: string | null;
  };
  clickpost: {
    /** True when the webhook API key env var is set. */
    configured: boolean;
    /** ISO timestamp of the most recent Clickpost webhook, null when none seen. */
    lastEventAt: string | null;
  };
  lens: {
    /** True when LENS_FORWARD_SECRET is set (same secret as RP forward). */
    configured: boolean;
    /** ISO timestamp of the most recent Lens-forwarded event (NDR / NPR). */
    lastEventAt: string | null;
  };
  whatsapp: {
    /** True when every required WHATSAPP_* env var is present. */
    configured: boolean;
    /** Phone number id displayed non-secret for grep-ability. */
    phoneNumberId: string | null;
    /** ISO timestamp of the most recent whatsapp_message row (any direction). */
    lastEventAt: string | null;
  };
}

export type IntegrationPlatform =
  | 'shopify'
  | 'returnprime'
  | 'clickpost'
  | 'lens'
  | 'whatsapp';

/**
 * Window shorthand accepted by the details endpoint. Kept small so the
 * UI's toggle maps 1:1 to the query param; no arbitrary ranges.
 */
export type IntegrationStatsWindow = '24h' | '7d' | '30d';

export interface IntegrationDetailsResponse {
  platform: IntegrationPlatform;
  window: IntegrationStatsWindow;
  /** Start of the lookback window as ISO. */
  since: string;
  /**
   * Observed webhook events for the window. For audited platforms
   * (shopify / returnprime / clickpost / lens) this comes from the
   * dedicated event tables. For whatsapp, where there's no dedicated
   * audit table, the array is empty — the FE renders the static
   * `webhookTopicsCatalog` instead.
   */
  webhookEvents: TopicStatRow[];
  /** Fallback catalog shown when webhookEvents is empty (whatsapp). */
  webhookTopicsCatalog: WebhookTopicCatalogEntry[];
  /** Static catalog of outbound HTTP calls Bridge makes to this platform. */
  apiCalls: ApiCallCatalogEntry[];
}

export interface IntegrationEventRow {
  id: string;
  platform: IntegrationPlatform;
  topic: string;
  /** Shopify ships `shop_domain` per event; others don't. Null elsewhere. */
  shopDomain: string | null;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface IntegrationEventsResponse {
  events: IntegrationEventRow[];
  /** ISO timestamp cursor to pass as `before` on the next page. Null when the list is exhausted. */
  nextBefore: string | null;
}

/**
 * Workspace-wide knobs. Reads are open to every authenticated user
 * (the FE surfaces some values contextually — e.g. showing the
 * reopen window when explaining ticket behaviour). Writes are
 * admin-only.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly shopify: ShopifyWebhooksService,
    private readonly returnPrime: ReturnPrimeWebhooksService,
    private readonly clickpost: ClickpostWebhooksService,
    private readonly lens: LensWebhooksService,
    @InjectRepository(WhatsappMessage)
    private readonly whatsappMessages: Repository<WhatsappMessage>,
  ) {}

  /**
   * Admin-facing view of every external integration Bridge talks to.
   * Returns ONLY metadata (configured yes/no, non-secret identifiers,
   * last-event timestamps) — the actual secrets live in `.env` and
   * are never exposed over the API, deliberately. Rotation requires
   * a redeploy, which is both the security guarantee and the audit
   * trail.
   */
  @Get('integrations')
  @Roles(UserRole.ADMIN)
  async getIntegrations(): Promise<IntegrationsResponse> {
    const shopifySecret = this.config.get('SHOPIFY_WEBHOOK_SECRET', {
      infer: true,
    });
    const shopifyDomain = this.config.get('SHOPIFY_SHOP_DOMAIN', {
      infer: true,
    });
    const configured = Boolean(shopifySecret && shopifyDomain);
    const lastEventAt = shopifyDomain
      ? await this.shopify.lastEventAt(shopifyDomain)
      : null;
    const rpToken = this.config.get('RETURN_PRIME_XRP_TOKEN', {
      infer: true,
    });
    const rpLastEventAt = await this.returnPrime.lastEventAt();
    const clickpostKey = this.config.get('CLICKPOST_WEBHOOK_API_KEY', {
      infer: true,
    });
    const clickpostLastEventAt = await this.clickpost.lastEventAt();
    const lensSecret = this.config.get('LENS_FORWARD_SECRET', {
      infer: true,
    });
    const lensLastEventAt = await this.lens.lastEventAt();
    // WhatsApp configured = every required WA env var present. We only
    // check the three that are REQUIRED (per EnvVars validators); the
    // others are either optional or already covered.
    const waPhoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', {
      infer: true,
    });
    const waAccessToken = this.config.get('WHATSAPP_ACCESS_TOKEN', {
      infer: true,
    });
    const waWabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const waConfigured = Boolean(waPhoneNumberId && waAccessToken && waWabaId);
    const waLastRow = await this.whatsappMessages.findOne({
      where: {},
      order: { createdAt: 'DESC' },
      select: { createdAt: true },
    });
    return {
      shopify: {
        configured,
        shopDomain: shopifyDomain ?? null,
        lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      },
      returnPrime: {
        configured: Boolean(rpToken),
        lastEventAt: rpLastEventAt ? rpLastEventAt.toISOString() : null,
      },
      clickpost: {
        configured: Boolean(clickpostKey),
        lastEventAt: clickpostLastEventAt
          ? clickpostLastEventAt.toISOString()
          : null,
      },
      lens: {
        configured: Boolean(lensSecret),
        lastEventAt: lensLastEventAt ? lensLastEventAt.toISOString() : null,
      },
      whatsapp: {
        configured: waConfigured,
        phoneNumberId: waPhoneNumberId ?? null,
        lastEventAt: waLastRow?.createdAt
          ? waLastRow.createdAt.toISOString()
          : null,
      },
    };
  }

  /**
   * Per-platform detail view — the data behind the expand-inline card
   * on the Integrations page. Returns observed webhook topic stats for
   * the chosen window (24h / 7d / 30d) plus the static catalog of
   * outbound API calls Bridge makes to this platform.
   *
   * For platforms without a dedicated webhook audit table (whatsapp),
   * `webhookEvents` is empty and the FE renders `webhookTopicsCatalog`
   * instead — the static list of topics Bridge handles.
   */
  @Get('integrations/:platform/details')
  @Roles(UserRole.ADMIN)
  async getIntegrationDetails(
    @Param('platform') platform: string,
    @Query('window') windowRaw?: string,
  ): Promise<IntegrationDetailsResponse> {
    const platforms: IntegrationPlatform[] = [
      'shopify',
      'returnprime',
      'clickpost',
      'lens',
      'whatsapp',
    ];
    if (!platforms.includes(platform as IntegrationPlatform)) {
      throw new NotFoundException(`Unknown platform "${platform}"`);
    }
    const windows: IntegrationStatsWindow[] = ['24h', '7d', '30d'];
    const window: IntegrationStatsWindow = windows.includes(
      windowRaw as IntegrationStatsWindow,
    )
      ? (windowRaw as IntegrationStatsWindow)
      : '7d';
    const hours = window === '24h' ? 24 : window === '7d' ? 24 * 7 : 24 * 30;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const platformTyped = platform as IntegrationPlatform;

    const webhookEvents: TopicStatRow[] = await (async () => {
      switch (platformTyped) {
        case 'shopify':
          return this.shopify.topicStats({ since });
        case 'returnprime':
          return this.returnPrime.topicStats({ since });
        case 'clickpost':
          return this.clickpost.topicStats({ since });
        case 'lens':
          return this.lens.topicStats({ since });
        case 'whatsapp':
          // Meta webhooks aren't audited to a dedicated table — the
          // FE renders the static catalog as a fallback.
          return [];
      }
    })();

    return {
      platform: platformTyped,
      window,
      since: since.toISOString(),
      webhookEvents,
      webhookTopicsCatalog: INTEGRATION_WEBHOOK_TOPICS[platformTyped],
      apiCalls: INTEGRATION_API_CALLS[platformTyped],
    };
  }

  /**
   * Inspector feed for inbound webhook events. Paginated by (received_at
   * < before). Platform filter is optional — today the only backing
   * table is Shopify, but the response shape carries `platform` so
   * the FE can render multi-platform the moment we start persisting
   * custom webhook events too.
   */
  @Get('integrations/events')
  @Roles(UserRole.ADMIN)
  async getIntegrationEvents(
    @Query('platform') platform?: string,
    @Query('before') before?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<IntegrationEventsResponse> {
    // Cap at 1000 so the authoring UI's "pick a recent sample" dropdown
    // surfaces rarer topics (orders/fulfilled fires 6k/wk vs
    // fulfillments/update 33k/wk — at cap=100 the entire window was
    // dominated by fulfillments/update + orders/create and admins
    // couldn't author against orders/fulfilled). Four jsonb cols × 1000
    // rows is still a cheap keyset scan with the (received_at) index.
    const limit = Math.min(1000, Math.max(1, Number(limitRaw) || 50));
    const beforeDate = before ? new Date(before) : null;
    const safeBefore =
      beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : null;

    // Collect from every platform that matches the filter (or all if
    // the filter is unset). Each platform page-fetches limit + 1 so
    // we can tell whether its individual stream has more; after
    // merge-sorting we trim to the global limit.
    const wantShopify = !platform || platform === 'shopify';
    const wantReturnPrime = !platform || platform === 'returnprime';
    const wantClickpost = !platform || platform === 'clickpost';
    const wantLens = !platform || platform === 'lens';
    const [shopifyRows, rpRows, clickpostRows, lensRows] = await Promise.all([
      wantShopify
        ? this.shopify.listRecent({ before: safeBefore, limit: limit + 1 })
        : Promise.resolve([]),
      wantReturnPrime
        ? this.returnPrime.listRecent({ before: safeBefore, limit: limit + 1 })
        : Promise.resolve([]),
      wantClickpost
        ? this.clickpost.listRecent({ before: safeBefore, limit: limit + 1 })
        : Promise.resolve([]),
      wantLens
        ? this.lens.listRecent({ before: safeBefore, limit: limit + 1 })
        : Promise.resolve([]),
    ]);
    const merged: IntegrationEventRow[] = [
      ...shopifyRows.map(
        (r): IntegrationEventRow => ({
          id: r.id,
          platform: 'shopify',
          topic: r.topic,
          shopDomain: r.shop_domain,
          receivedAt: r.received_at.toISOString(),
          payload: r.payload ?? {},
        }),
      ),
      ...rpRows.map(
        (r): IntegrationEventRow => ({
          id: r.id,
          platform: 'returnprime',
          topic: r.topic,
          shopDomain: null,
          receivedAt: r.received_at.toISOString(),
          payload: r.payload ?? {},
        }),
      ),
      ...clickpostRows.map(
        (r): IntegrationEventRow => ({
          id: r.id,
          // Clickpost events use `status` as the topic surface since
          // there's no explicit "topic" string in their payload — the
          // status field (OFD / Delivered / etc.) is the natural
          // event-type analogue.
          platform: 'clickpost',
          topic: r.status,
          shopDomain: null,
          receivedAt: r.received_at.toISOString(),
          payload: r.payload ?? {},
        }),
      ),
      ...lensRows.map(
        (r): IntegrationEventRow => ({
          id: r.id,
          platform: 'lens',
          // Lens's forwarder carries an explicit `topic` field (ndr / npr);
          // we store it on the row directly, no derivation needed.
          topic: r.topic,
          shopDomain: null,
          receivedAt: r.received_at.toISOString(),
          payload: r.payload ?? {},
        }),
      ),
    ];
    merged.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    const nextBefore =
      merged.length > limit && last ? last.receivedAt : null;
    return { events: page, nextBefore };
  }

  @Get('general')
  async getGeneral(): Promise<GeneralSettingsResponse> {
    const [
      emailResolvedReopenWindowHours,
      whatsappResolvedReopenWindowHours,
      requireTagToResolve,
    ] = await Promise.all([
      this.settings.getEmailResolvedReopenWindowHours(),
      this.settings.getWhatsappResolvedReopenWindowHours(),
      this.settings.getRequireTagToResolve(),
    ]);
    return {
      // Legacy field mirrors the email window so older FEs that still
      // read this stay sensible until they move to the per-channel keys.
      resolvedReopenWindowHours: emailResolvedReopenWindowHours,
      emailResolvedReopenWindowHours,
      whatsappResolvedReopenWindowHours,
      requireTagToResolve,
    };
  }

  @Patch('general')
  @Roles(UserRole.ADMIN)
  async updateGeneral(
    @Body() dto: UpdateGeneralSettingsDto,
  ): Promise<GeneralSettingsResponse> {
    // Legacy single field: an older FE that only knows the global
    // window still sends this. Apply to both channel-specific windows
    // so the admin's intent — one cutoff for everything — holds.
    // New FE sends the per-channel fields explicitly; those take
    // precedence if they're also set in the same payload.
    if (dto.resolvedReopenWindowHours !== undefined) {
      await Promise.all([
        this.settings.setEmailResolvedReopenWindowHours(
          dto.resolvedReopenWindowHours,
        ),
        this.settings.setWhatsappResolvedReopenWindowHours(
          dto.resolvedReopenWindowHours,
        ),
      ]);
    }
    if (dto.emailResolvedReopenWindowHours !== undefined) {
      await this.settings.setEmailResolvedReopenWindowHours(
        dto.emailResolvedReopenWindowHours,
      );
    }
    if (dto.whatsappResolvedReopenWindowHours !== undefined) {
      await this.settings.setWhatsappResolvedReopenWindowHours(
        dto.whatsappResolvedReopenWindowHours,
      );
    }
    if (dto.requireTagToResolve !== undefined) {
      await this.settings.setRequireTagToResolve(dto.requireTagToResolve);
    }
    return this.getGeneral();
  }

  /**
   * Webhook secret display — ADMIN only. Returns the current token
   * (hex string). Reading auto-mints the row on first access so a
   * fresh install doesn't require an explicit seed step.
   */
  @Get('webhook-secret')
  @Roles(UserRole.ADMIN)
  async getWebhookSecret(): Promise<{ secret: string }> {
    const secret = await this.settings.getWebhookSecret();
    return { secret };
  }

  /**
   * Rotate the webhook secret. ADMIN only. Returns the new value.
   * The old value stops working immediately — rotation is a hard
   * cut, coordinate with the sender before calling.
   */
  @Post('webhook-secret/rotate')
  @Roles(UserRole.ADMIN)
  async rotateWebhookSecret(): Promise<{ secret: string }> {
    const secret = await this.settings.rotateWebhookSecret();
    return { secret };
  }
}
