import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ChannelAdapter } from '../bot/runtime/channel-adapter';
import type { OutboundMessage } from '../bot/runtime/types';
import { ChannelType } from '../database/enums';
import { Ticket } from '../tickets/entities/ticket.entity';
import { WhatsappSenderService } from './whatsapp-sender.service';

/**
 * The bot runtime's door out to WhatsApp. Looks up the ticket to
 * resolve the customer's `wa_id` from `thread_key` (`wa:${id}` or
 * `wa:${id}:archived:...`), then delegates to WhatsappSenderService:
 *
 *   zero options  → sendText
 *   1-3 options   → sendInteractiveButtons (Meta reply-button UI)
 *   4+ options    → fallback to sendText with a numbered enumeration
 *                   because Meta's button cap is 3; admin should
 *                   restructure the step but we don't lose the send
 *
 * Email tickets flow through this adapter today too (bot flows can
 * fire on email trigger). For now we skip-and-log on non-WHATSAPP
 * channels — the right fix is a channel-router adapter when the
 * email-side bot flow is scoped.
 *
 * All send failures from the sender are swallowed to a warn here;
 * surfacing them higher would mark the bot session FAILED, which is
 * usually overkill — a Meta 429 or a transient 500 shouldn't tombstone
 * the whole flow. Agents can still take over via handoff / manual
 * assign.
 */
@Injectable()
export class WhatsappChannelAdapter implements ChannelAdapter {
  private readonly logger = new Logger(WhatsappChannelAdapter.name);

  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly sender: WhatsappSenderService,
  ) {}

  async send(input: {
    ticketId: string;
    channelId: string;
    message: OutboundMessage;
  }): Promise<void> {
    const ticket = await this.tickets.findOne({
      where: { id: input.ticketId },
    });
    if (!ticket) {
      this.logger.warn(
        `send: ticket ${input.ticketId} not found; dropping message`,
      );
      return;
    }
    if (ticket.channel_type !== ChannelType.WHATSAPP) {
      this.logger.log(
        `send skip: ticket=${input.ticketId} channel_type=${ticket.channel_type} is not WHATSAPP`,
      );
      return;
    }
    const waId = parseWaIdFromThreadKey(ticket.thread_key);
    if (!waId) {
      this.logger.warn(
        `send: ticket ${input.ticketId} has unparseable thread_key=${ticket.thread_key}; dropping message`,
      );
      return;
    }

    const options = input.message.options ?? [];
    try {
      if (options.length === 0) {
        await this.sender.sendText(waId, input.message.text);
        return;
      }
      if (options.length <= 3) {
        // Meta caps button titles at 20 chars. Truncate rather than
        // reject so an admin's long label doesn't abort the send; the
        // match on inbound side normalises to lowercase+trim and will
        // see the truncated title.
        await this.sender.sendInteractiveButtons(
          waId,
          input.message.text,
          options.map((o, i) => ({
            id: `opt-${i}`,
            title: o.label.slice(0, 20),
          })),
        );
        return;
      }
      // >3 options: Meta's cap. Enumerate inline so the message still
      // reaches the customer. The ingest's option-match uses
      // trim+lowercase of the TEXT the customer types, so if they
      // reply "1" or the full label either way the current match
      // misses — admin needs to restructure. Warn so pm2 logs catch
      // flows that need splitting.
      this.logger.warn(
        `send: ticket=${input.ticketId} has ${options.length} options; falling back to text enumeration (Meta buttons max 3)`,
      );
      const enumerated =
        input.message.text +
        '\n\n' +
        options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      await this.sender.sendText(waId, enumerated);
    } catch (err) {
      this.logger.warn(
        `send failed for ticket=${input.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * thread_key is `wa:${waId}` on the live row and
 * `wa:${waId}:archived:${ts}` on past-window-archived rows. Split on
 * `:` and return the second segment — handles both shapes without
 * caring about the trailing archived suffix.
 */
function parseWaIdFromThreadKey(threadKey: string): string | null {
  if (!threadKey.startsWith('wa:')) return null;
  const parts = threadKey.split(':');
  if (parts.length < 2 || !parts[1]) return null;
  return parts[1];
}
