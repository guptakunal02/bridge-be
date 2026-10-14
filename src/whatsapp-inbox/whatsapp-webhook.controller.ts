import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/**
 * Public — Meta's webhook sender has no auth header to show us. Signed
 * requests (X-Hub-Signature-256) will be enforced before any DB write
 * happens; V1 just logs + 200s.
 *
 * Path kept URL-stable: Meta's webhook registration lives on the
 * subscription, not in Bridge's config, so moving this route would
 * break the live verification.
 */
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  constructor(private readonly service: WhatsappWebhookService) {}

  /**
   * Meta sends this ONCE at subscription setup to prove we own the
   * URL. Query params use dotted names (`hub.mode`, etc.) so Nest's
   * @Query() decorator sees them with the dots preserved — read them
   * off the object by key rather than via @Query('hub.mode').
   */
  @Get()
  verify(
    @Query() query: Record<string, string | undefined>,
  ): string {
    const challenge = this.service.verify({
      mode: query['hub.mode'],
      token: query['hub.verify_token'],
      challenge: query['hub.challenge'],
    });
    if (challenge === null) {
      // 403 is what Meta's examples show for a failed verify —
      // triggers a clear "verification failed" message in their UI
      // instead of a generic "unexpected response" one.
      throw new ForbiddenException('Webhook verify failed');
    }
    // Meta expects the raw challenge string as the response body —
    // not JSON-wrapped. Returning a plain string from a Nest handler
    // sends it with text/html by default, which Meta accepts.
    return challenge;
  }

  /**
   * Inbound message delivery. 200 is REQUIRED within ~20s or Meta
   * marks the webhook as failing and starts exponential-backoff
   * retries. We ack immediately and process in-handler — the V1
   * payload-logger is fast enough for a direct call; once ticket
   * minting lands it'll move to an enqueue+background-worker pattern.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Body() payload: unknown): Promise<{ received: true }> {
    await this.service.handleInbound(payload);
    return { received: true };
  }
}
