import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ChannelAdapter } from '../bot/runtime/channel-adapter';
import type { OutboundMessage } from '../bot/runtime/types';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelType, MessageDirection } from '../database/enums';
import { Ticket } from '../tickets/entities/ticket.entity';
import { WhatsappMessage } from './entities/whatsapp-message.entity';
import type { WhatsappSendResult } from './whatsapp-sender.service';
import { WhatsappSenderService } from './whatsapp-sender.service';

/**
 * The bot runtime's door out to WhatsApp. Looks up the ticket to
 * resolve the customer's `wa_id` from `thread_key` (`wa:${id}` or
 * `wa:${id}:archived:...`), then delegates to WhatsappSenderService:
 *
 *   zero options  → sendText
 *   1-3 options   → sendInteractiveButtons (Meta reply-button UI)
 *   4-10 options  → sendInteractiveList (bottom-sheet menu)
 *   11+ options   → fallback to sendText with a numbered enumeration
 *                   because Meta's list cap is 10; admin should
 *                   restructure the step but we don't lose the send
 *
 * After every successful Meta Graph send, a SENT whatsapp_message
 * row is persisted so Bridge's ticket UI shows the bot's outbound
 * alongside the customer's inbound. Prior to this the agent view
 * saw only one side of the conversation, which looked like the
 * bot wasn't responding.
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
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    @InjectRepository(WhatsappMessage)
    private readonly messages: Repository<WhatsappMessage>,
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

    // Load channel once so the persisted SENT row has the business
    // wa_id in `sender` (mirrors agent-reply persistence). Missing
    // channel is theoretically impossible (ticket.channel_id is a
    // FK) but defend defensively — fallback to empty string so the
    // NOT NULL column still gets written.
    const channel = await this.channels.findOne({
      where: { id: ticket.channel_id },
    });
    const businessWaId = channel?.inbox_contact ?? '';

    const options = input.message.options ?? [];
    // Meta caps button titles at 20 chars but list rows at 24. If any
    // option exceeds the button cap, use list send even when 1-3
    // options are present — preserving the admin's label fully (24
    // chars) beats keeping the 1-tap UX while silently chopping
    // characters ("Return/Exchange" → "Return/Exchan" was the
    // reported case). Admin trades one extra tap for correctness.
    const anyLabelOverButtonCap = options.some((o) => o.label.length > 20);
    // The content persisted on the SENT whatsapp_message row drives
    // Bridge's own UI rendering. The customer sees interactive
    // buttons / list rows in WhatsApp itself; agents reviewing the
    // thread need to see what was offered, so append the options as
    // a numbered list under the body. Matches the LimeChat-style
    // "1. New Order / 2. Existing Order" display.
    const displayContent =
      options.length === 0
        ? input.message.text
        : `${input.message.text}\n\n${options
            .map((o, i) => `${i + 1}. ${o.label}`)
            .join('\n')}`;
    try {
      if (options.length === 0) {
        const result = await this.sender.sendText(waId, input.message.text);
        await this.persistSent({
          ticket,
          businessWaId,
          content: displayContent,
          messageType: 'text',
          result,
        });
        return;
      }
      if (options.length <= 3 && !anyLabelOverButtonCap) {
        const result = await this.sender.sendInteractiveButtons(
          waId,
          input.message.text,
          options.map((o, i) => ({
            // Runtime encodes id as `${stepId}:${index}`; forward as-is
            // so Meta returns it on button-tap and the ingest can
            // decode step+option without searching for labels. Falls
            // back to `opt-${i}` for callers that don't set optionId.
            id: o.optionId ?? `opt-${i}`,
            title: o.label,
          })),
        );
        await this.persistSent({
          ticket,
          businessWaId,
          content: displayContent,
          messageType: 'interactive',
          result,
        });
        return;
      }
      if (options.length <= 10) {
        // 4-10 options: use Meta's list payload (bottom-sheet menu).
        // Row titles are capped at 24 chars; truncation is silent for
        // the same reason as buttons.
        const result = await this.sender.sendInteractiveList(
          waId,
          input.message.text,
          options.map((o, i) => ({
            id: o.optionId ?? `opt-${i}`,
            title: o.label.slice(0, 24),
          })),
        );
        await this.persistSent({
          ticket,
          businessWaId,
          content: displayContent,
          messageType: 'interactive',
          result,
        });
        return;
      }
      // >10 options: Meta's hard cap for list rows. Enumerate inline
      // so the message still reaches the customer. The ingest's
      // option-match uses trim+lowercase of the TEXT the customer
      // types, so a reply of "1" or the full label will miss —
      // admin needs to restructure. Warn so pm2 logs catch flows
      // that need splitting.
      this.logger.warn(
        `send: ticket=${input.ticketId} has ${options.length} options; falling back to text enumeration (Meta list cap is 10)`,
      );
      const enumerated =
        input.message.text +
        '\n\n' +
        options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      const result = await this.sender.sendText(waId, enumerated);
      await this.persistSent({
        ticket,
        businessWaId,
        content: enumerated,
        messageType: 'text',
        result,
      });
    } catch (err) {
      this.logger.warn(
        `send failed for ticket=${input.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Record the outbound as a SENT whatsapp_message so the ticket UI
   * surfaces it. Deliberately swallows DB errors to warn — the Meta
   * Graph send has already succeeded (customer has the message) and
   * failing the whole adapter would mark the bot session FAILED,
   * which is overkill. The side effect: a divergence where the
   * customer saw a message Bridge's UI doesn't show. Pm2 log is the
   * forensic trail if that ever matters.
   */
  private async persistSent(input: {
    ticket: Ticket;
    businessWaId: string;
    content: string;
    messageType: 'text' | 'interactive';
    result: WhatsappSendResult;
  }): Promise<void> {
    try {
      await this.messages.save(
        this.messages.create({
          channelId: input.ticket.channel_id,
          ticket_id: input.ticket.id,
          type: MessageDirection.SENT,
          sender: input.businessWaId,
          content: input.content,
          external_message_id: input.result.wamid,
          message_type: input.messageType,
          raw_payload: input.result.raw ?? null,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `persistSent failed for ticket=${input.ticket.id} wamid=${input.result.wamid}: ${
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
