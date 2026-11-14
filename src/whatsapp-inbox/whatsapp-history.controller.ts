import { Controller, Get, Param, Query } from '@nestjs/common';
import { WhatsappHistoryService } from './whatsapp-history.service';

/**
 * Cross-ticket WhatsApp message lookup by customer phone. Lets
 * admins + agents answer questions like "did order_confirmation
 * reach this customer?" without needing a live ticket. Backs the
 * FE `/history/<phone>` page.
 *
 * Auth: inherited from the global JwtAuthGuard — no special per-
 * route guard, same auth model as the rest of /tickets.
 */
@Controller('whatsapp/history')
export class WhatsappHistoryController {
  constructor(private readonly service: WhatsappHistoryService) {}

  @Get('by-phone/:phone')
  async byPhone(
    @Param('phone') phone: string,
    // Optional UUID — when provided, filters results to a single
    // WhatsApp channel. Powers the FE's inbox picker that defaults
    // to the new WhatsApp number during the migration.
    @Query('channelId') channelId?: string,
  ) {
    return this.service.byPhone(phone, channelId);
  }
}
