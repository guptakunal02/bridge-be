import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageDirection } from '../database/enums';
import { WhatsappMessage } from './entities/whatsapp-message.entity';

export interface HistoryMessage {
  id: string;
  direction: 'SENT' | 'RECEIVED';
  content: string | null;
  templateName: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  createdAt: string;
  ticketId: string | null;
  channelId: string;
  wamid: string;
}

export interface HistoryResponse {
  wa_id: string;
  total: number;
  messages: HistoryMessage[];
}

/**
 * Message history lookup across tickets (and across no-ticket) for a
 * single customer phone. Answers the admin's "did this customer
 * actually receive the order_confirmation template we auto-fired?"
 * — which in a ticket-centric inbox was previously only answerable
 * via a DB query. All WhatsApp messages (inbound + outbound) for a
 * wa_id come back as one flat chronological list; the FE groups by
 * day for display.
 *
 * Match strategy — covers both sides of the conversation:
 *   * Inbound rows: `sender` holds the customer's wa_id directly.
 *   * Outbound rows: `sender` holds the business phone_number_id (no
 *     link to the customer there). We reach the customer wa_id via
 *     the ticket.thread_key column, which encodes it as `wa:<digits>`
 *     (or `wa:<digits>:archived:<ts>` for older archived threads).
 *
 * All matches are OR'd so a wa_id that has ever either sent or
 * received a message surfaces, regardless of ticket state.
 */
@Injectable()
export class WhatsappHistoryService {
  constructor(
    @InjectRepository(WhatsappMessage)
    private readonly messages: Repository<WhatsappMessage>,
  ) {}

  async byPhone(rawPhone: string): Promise<HistoryResponse> {
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 6) {
      // Guard against overly-broad queries ("91" would match millions
      // of Indian customer messages). 6 digits is enough for a
      // realistic last-6 phone search while still bounding blast
      // radius.
      throw new BadRequestException(
        'Phone query must contain at least 6 digits',
      );
    }

    // Single query returns BOTH inbound (sender = customer wa_id)
    // AND outbound (joined via ticket.thread_key = `wa:<digits>...`).
    // Union-via-OR keeps it one plan; createdAt sort orders them
    // across both branches in a single result set.
    const rows = (await this.messages
      .createQueryBuilder('m')
      .leftJoin('ticket', 't', 't.id = m.ticket_id')
      .where(
        '(m.sender = :digits OR t.thread_key LIKE :waKey OR t.thread_key = :waKeyExact)',
        {
          digits,
          waKey: `wa:${digits}:%`,
          waKeyExact: `wa:${digits}`,
        },
      )
      .orderBy('m."createdAt"', 'DESC')
      .limit(500)
      .getMany()) as WhatsappMessage[];

    return {
      wa_id: digits,
      total: rows.length,
      messages: rows.map((r) => this.toHistoryMessage(r)),
    };
  }

  private toHistoryMessage(row: WhatsappMessage): HistoryMessage {
    // Template name lives in raw_payload.template.name on outbound
    // template sends; absent on text sends and on all inbound rows.
    // Defensive JSON walking — raw_payload is `unknown`.
    let templateName: string | null = null;
    const raw = row.raw_payload;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const template = (raw as Record<string, unknown>).template;
      if (template && typeof template === 'object' && !Array.isArray(template)) {
        const name = (template as Record<string, unknown>).name;
        if (typeof name === 'string') templateName = name;
      }
    }

    return {
      id: row.id,
      direction:
        row.type === MessageDirection.SENT ? 'SENT' : 'RECEIVED',
      content: row.content,
      templateName,
      mediaUrl: row.media_url,
      mediaMimeType: row.media_mime_type,
      createdAt: row.createdAt.toISOString(),
      ticketId: row.ticket_id != null ? String(row.ticket_id) : null,
      channelId: row.channelId,
      wamid: row.external_message_id,
    };
  }
}
