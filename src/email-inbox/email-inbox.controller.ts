import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { IngestEmailInbox } from './dto/req.dto';
import { EmailInboxService } from './email-inbox.service';

@Controller('email-inbox')
export class EmailInboxController {
  constructor(private readonly svc: EmailInboxService) {}

  /**
   * Called by the IMAP worker (or a webhook) when a fresh inbound email
   * needs to land in Bridge as a Ticket + EmailMessage row.
   *
   * @Public because the caller is an internal worker, not a signed-in
   * user. Add an API-key check here if you expose this over the internet.
   */
  @Public()
  @Post('channels/:channelId/ingest')
  ingest(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: IngestEmailInbox,
  ) {
    return this.svc.ingestInbound(channelId, body);
  }
}
