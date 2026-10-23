import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ClickpostWebhooksService } from './clickpost-webhooks.service';
import { ClickpostApiKeyGuard } from './guards/clickpost-api-key.guard';

/**
 * POST /webhooks/clickpost. Clickpost's dashboard-configured endpoint —
 * one URL, selected-status checkpoints, X-Api-Key authentication.
 *
 * Clickpost's docs say payloads may add new keys over time, so the
 * controller treats the body as `Record<string, unknown>` and defers
 * all field reading to the service (which is defensive about missing
 * fields). Only required contract: 200/202 return + idempotent
 * repeats (Clickpost retries on non-200).
 */
@Public()
@Controller('webhooks/clickpost')
@UseGuards(ClickpostApiKeyGuard)
export class ClickpostWebhooksController {
  constructor(private readonly service: ClickpostWebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Body() body: Record<string, unknown>,
  ): Promise<{ accepted: true; deduped: boolean }> {
    const result = await this.service.handle(body);
    return { accepted: true, deduped: result.deduped };
  }
}
