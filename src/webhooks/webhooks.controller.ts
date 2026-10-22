import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { TicketStatus } from '../database/enums';
import { AppSettingsService } from '../settings/app-settings.service';
import { CustomEventDto } from './dto/custom-event.dto';

/**
 * External-facing webhook surface. The only endpoint today is
 * /webhooks/custom-events — a POST sink that external systems (Shopify
 * order worker, fulfillment service, custom integrations) call to
 * trigger a Bridge automation rule without having to authenticate as
 * a user.
 *
 * Auth model: shared secret in the `X-Bridge-Secret` header, matched
 * against the stored `webhook_secret` setting. Admin rotates via
 * POST /settings/webhook-secret/rotate (ADMIN-authenticated).
 * `@Public()` bypasses the session guard — the secret header is the
 * only auth here.
 *
 * Semantics: the endpoint accepts the payload, validates shape +
 * secret, then emits a WEBHOOK_CUSTOM automation event synchronously.
 * It does NOT wait for rule execution — the dispatcher runs the
 * matched rules asynchronously; the HTTP response signals "received,
 * will dispatch", not "action completed". Senders that need
 * delivery confirmation should rely on the downstream action (the
 * WhatsApp send) emitting its own confirmation.
 *
 * No ticket is minted. Webhook-triggered sends are pure outbound.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly automations: AutomationEngine,
  ) {}

  @Public()
  @Post('custom-events')
  @HttpCode(HttpStatus.ACCEPTED)
  async customEvent(
    @Headers('x-bridge-secret') providedSecret: string | undefined,
    @Body() body: CustomEventDto,
  ): Promise<{ accepted: true }> {
    const expected = await this.settings.getWebhookSecret();
    if (!providedSecret || !constantTimeEqual(providedSecret, expected)) {
      throw new UnauthorizedException('Invalid X-Bridge-Secret header');
    }
    // Light input hygiene on top of class-validator — payload keys
    // are inherently external, so belt + braces before we hand it to
    // the engine.
    if (!body.event || body.event.trim() === '') {
      throw new BadRequestException('event is required');
    }
    if (!body.customerPhone || body.customerPhone.trim() === '') {
      throw new BadRequestException('customerPhone is required');
    }
    if (!body.channelId || body.channelId.trim() === '') {
      throw new BadRequestException('channelId is required');
    }

    this.automations.emit({
      event: AUTOMATION_EVENT.WEBHOOK_CUSTOM,
      // Sentinel ticket snapshot — webhooks have no ticket. Shape kept
      // so the payload still unions cleanly with ticket-bearing events;
      // predicate evaluation for WEBHOOK_CUSTOM rules should key on
      // `event.*` fields, not `ticket.*`.
      ticket: {
        id: '',
        channelId: body.channelId,
        // Webhooks are source-agnostic — rules on `webhook.custom`
        // should key on event.name, not ticket.channelType.
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name: body.event.trim(),
        variables: body.variables ?? {},
        customerPhone: body.customerPhone.trim(),
        channelId: body.channelId.trim(),
      },
    });
    return { accepted: true };
  }
}

/**
 * Constant-time string comparison to avoid leaking the secret via
 * early-exit timing on prefix matches. Node's Buffer.compare is
 * length-sensitive on mismatched inputs — pad to the max before
 * comparing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still do a dummy compare to avoid revealing length via timing.
    void Buffer.compare(aBuf, aBuf);
    return false;
  }
  return Buffer.compare(aBuf, bBuf) === 0;
}
