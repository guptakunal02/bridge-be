import { Injectable, Logger } from '@nestjs/common';
import type { OutboundMessage } from './types';

/**
 * The runtime's only door to the outside world. Every step that
 * needs to speak to the customer goes through `send()`.
 *
 * Interface + stub live together for MVP because there's only one
 * channel yet. When WhatsApp lands, split into an abstract token
 * (`CHANNEL_ADAPTER`) and provide the real implementation.
 */
export interface ChannelAdapter {
  send(input: {
    ticketId: string;
    channelId: string;
    message: OutboundMessage;
  }): Promise<void>;
}

/**
 * Logs everything to stdout. Good enough for FE demos and unit
 * tests. Swaps out for the WhatsApp adapter without any runtime
 * changes — same interface.
 */
@Injectable()
export class LoggingChannelAdapter implements ChannelAdapter {
  private readonly logger = new Logger('BotChannel');

  send(input: {
    ticketId: string;
    channelId: string;
    message: OutboundMessage;
  }): Promise<void> {
    const { ticketId, channelId, message } = input;
    const suffix = message.options?.length
      ? ` options=[${message.options.map((o) => o.label).join(' | ')}]`
      : '';
    this.logger.log(
      `[stub-send] channel=${channelId} ticket=${ticketId} text="${message.text}"${suffix}`,
    );
    return Promise.resolve();
  }
}
