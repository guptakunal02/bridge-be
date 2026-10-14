import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/**
 * Public — Meta's webhook sender has no auth header to show us. The
 * `@Public()` class decorator opts both GET + POST out of the global
 * JwtAuth / Approved guards; without it the global guard chain
 * returns 401 before our handler runs and Meta's verification fails
 * with "The callback URL or verify token couldn't be validated."
 * Signed requests (X-Hub-Signature-256) will be enforced before any
 * DB write happens; V1 just logs + 200s.
 *
 * Path kept URL-stable: Meta's webhook registration lives on the
 * subscription, not in Bridge's config, so moving this route would
 * break the live verification.
 */
@Public()
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
    @Res() res: Response,
  ): void {
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
    // NOT the standard Bridge SuccessEnvelope. @Res() + .send()
    // bypasses the ResponseEnvelopeInterceptor so we can write the
    // raw string directly. text/plain content-type keeps Meta's
    // parser from guessing JSON.
    res.status(HttpStatus.OK).type('text/plain').send(challenge);
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
