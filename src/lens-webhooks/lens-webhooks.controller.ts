import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { LensForwardSecretGuard } from '../return-prime-webhooks/guards/lens-forward-secret.guard';
import { LensEventDto } from './dto/lens-event.dto';
import { LensWebhooksService } from './lens-webhooks.service';

/**
 * External-facing receiver for Lens's NDR / NPR forwards. See the
 * surma-ops handoff doc for the contract. Auth = same shared secret
 * (`X-Lens-Secret`) used by the Return Prime forwarder, enforced by
 * LensForwardSecretGuard reused here.
 *
 * 202 Accepted on first-time receipt, 202 on dedup — Lens doesn't
 * retry on 2xx, so there's no observable difference to the sender.
 */
@Controller('webhooks')
export class LensWebhooksController {
  constructor(private readonly service: LensWebhooksService) {}

  @Public()
  @UseGuards(LensForwardSecretGuard)
  @Post('lens')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(@Body() body: LensEventDto): Promise<{ accepted: true }> {
    await this.service.handle({
      topic: body.topic,
      event_id: body.event_id,
      received_at: body.received_at,
      payload: body.payload,
    });
    return { accepted: true };
  }
}
