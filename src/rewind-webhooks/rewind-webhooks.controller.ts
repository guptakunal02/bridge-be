import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { RewindEventDto } from './dto/rewind-event.dto';
import { RewindSecretGuard } from './guards/rewind-secret.guard';
import { RewindWebhooksService } from './rewind-webhooks.service';

/**
 * POST /webhooks/rewind — receive Rewind events, persist them, emit a
 * typed `rewind.webhook` automation event. @Public bypasses the
 * workspace JWT since Rewind doesn't carry one; auth is the
 * RewindSecretGuard's `X-Bridge-Secret` header check (same token the
 * generic /webhooks/custom-events uses — one admin-rotatable secret
 * across all external webhook callers).
 *
 * Body contract matches CustomEventDto's shape (event / customerPhone
 * / channelId / variables? / rawPayload?) — the Rewind integration
 * email went out with this exact shape. The dedicated URL exists so
 * Rewind traffic gets its own audit table + its own typed trigger,
 * not because the body differs.
 *
 * Returns 202 Accepted whether or not the event was deduped — Rewind
 * treats non-2xx as a failure and retries, and a dedup is a success
 * from their perspective (we already processed it).
 */
@Controller('webhooks/rewind')
export class RewindWebhooksController {
  constructor(private readonly service: RewindWebhooksService) {}

  @Public()
  @Post()
  @UseGuards(RewindSecretGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Body() dto: RewindEventDto,
  ): Promise<{ accepted: true; deduped: boolean }> {
    const result = await this.service.handle(dto);
    return { accepted: true, deduped: result.deduped };
  }
}
