import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation';

/**
 * V1 webhook handling — defensive: just log the payload shape and
 * acknowledge Meta's verification handshake. No DB writes, no ticket
 * creation. That stays off until we've seen a few real payloads in
 * pm2 logs and know what Meta actually sends.
 *
 * Meta's webhook contract (Cloud API):
 *   * GET /webhooks/whatsapp
 *       Query: hub.mode=subscribe, hub.verify_token=<ours>, hub.challenge=<random>
 *       We echo back `hub.challenge` iff `hub.verify_token` matches
 *       the WHATSAPP_WEBHOOK_VERIFY_TOKEN we hand to Meta. Returning
 *       anything else fails verification and Meta will not activate
 *       the subscription.
 *   * POST /webhooks/whatsapp
 *       Body: WhatsApp Business Account payload (messages, status
 *       updates, etc). We log it and 200 immediately — Meta retries
 *       with exponential backoff if we don't ack in <20s.
 *
 * Signature verification (X-Hub-Signature-256) is deliberately not
 * enforced in V1. It becomes required before we start minting tickets
 * because a leaked webhook URL would otherwise let anyone inject
 * synthetic "customer messages" into Bridge. V2 will HMAC-SHA256 the
 * raw body with WHATSAPP_APP_SECRET and compare against the header.
 */
@Injectable()
export class WhatsappWebhookService {
  private readonly logger = new Logger(WhatsappWebhookService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  /**
   * Meta's one-time subscription verification. Returns the challenge
   * value on success so the controller can echo it back as the HTTP
   * body; returns `null` on verify-token mismatch so the controller
   * can respond 403.
   */
  verify(params: {
    mode: string | undefined;
    token: string | undefined;
    challenge: string | undefined;
  }): string | null {
    const expected = this.config.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN', {
      infer: true,
    });
    if (params.mode !== 'subscribe') {
      this.logger.warn(
        `Webhook verify rejected: mode=${params.mode ?? 'missing'}`,
      );
      return null;
    }
    if (params.token !== expected) {
      // Don't log the received token — could help an attacker guess.
      this.logger.warn('Webhook verify rejected: verify token mismatch');
      return null;
    }
    if (!params.challenge) {
      this.logger.warn('Webhook verify rejected: no challenge provided');
      return null;
    }
    this.logger.log('Webhook verify succeeded — subscription active');
    return params.challenge;
  }

  /**
   * V1 ingest. Just log the whole payload (payload-shaped logging so
   * grep works) and acknowledge. Future revisions will:
   *   1. Verify X-Hub-Signature-256 against the raw body.
   *   2. Walk payload.entry[].changes[].value.messages[] and mint
   *      tickets per sender wa_id.
   *   3. Walk payload.entry[].changes[].value.statuses[] to update
   *      delivery / read receipts on previously-sent messages.
   */
  async handleInbound(payload: unknown): Promise<void> {
    // Keep the log line single-string so pm2 timestamp + Nest level
    // prefixes stay intact for grep/jq. 10 KB cap on the stringified
    // payload so a wildly oversized body can't flood the log file.
    const raw = JSON.stringify(payload);
    const safe = raw.length > 10_000 ? `${raw.slice(0, 10_000)}…[truncated]` : raw;
    this.logger.log(`whatsapp.webhook.payload: ${safe}`);
  }
}
