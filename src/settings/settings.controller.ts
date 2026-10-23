import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Roles } from '../auth/decorators/roles.decorator';
import type { EnvVars } from '../config/env.validation';
import { UserRole } from '../database/enums';
import { ReturnPrimeWebhooksService } from '../return-prime-webhooks/return-prime-webhooks.service';
import { ShopifyWebhooksService } from '../shopify-webhooks/shopify-webhooks.service';
import { AppSettingsService } from './app-settings.service';
import {
  GeneralSettingsResponse,
  UpdateGeneralSettingsDto,
} from './dto/general-settings.dto';

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
}

export type IntegrationPlatform = 'shopify' | 'returnprime';

export interface IntegrationEventRow {
  id: string;
  platform: IntegrationPlatform;
  topic: string;
  /** Shopify ships `shop_domain` per event; RP doesn't. Null for RP. */
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
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 50));
    const beforeDate = before ? new Date(before) : null;
    const safeBefore =
      beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : null;

    // Collect from every platform that matches the filter (or all if
    // the filter is unset). Each platform page-fetches limit + 1 so
    // we can tell whether its individual stream has more; after
    // merge-sorting we trim to the global limit.
    const wantShopify = !platform || platform === 'shopify';
    const wantReturnPrime = !platform || platform === 'returnprime';
    const [shopifyRows, rpRows] = await Promise.all([
      wantShopify
        ? this.shopify.listRecent({ before: safeBefore, limit: limit + 1 })
        : Promise.resolve([]),
      wantReturnPrime
        ? this.returnPrime.listRecent({ before: safeBefore, limit: limit + 1 })
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
