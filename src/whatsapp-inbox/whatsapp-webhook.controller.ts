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
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { WhatsappIngestService } from './whatsapp-ingest.service';
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
  constructor(
    private readonly service: WhatsappWebhookService,
    private readonly ingest: WhatsappIngestService,
  ) {}

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
  /**
   * V2 — signature-verified ingest. @UseGuards runs the HMAC check
   * against the raw body + APP_SECRET BEFORE the handler, so a forged
   * payload at our public URL never reaches ingest. 200s immediately
   * (Meta retries if we don't ack in ~20s); ingest runs in-handler
   * for simplicity, since it's bounded by payload size and transaction
   * duration.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Body() payload: unknown): Promise<{ received: true }> {
    // Still log the payload shape (helps debug the next time Meta
    // changes the shape or we add a new field subscription).
    await this.service.handleInbound(payload);
    try {
      await this.ingest.ingest(payload as never);
    } catch (err) {
      // Any ingest failure is logged but doesn't 500 the webhook —
      // Meta would retry forever otherwise, DOSing the ingest path
      // on a bug. Admins see the warn and fix forward.
      // (Known limitation: individual message failures are swallowed
      // inside ingest.ingestOne, so this catch is a top-level net.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.service as any).logger?.warn?.(
        `WhatsApp ingest crashed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { received: true };
  }
}
