import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { MessageDirection } from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { CustomerOrdersService } from '../tickets/customer-orders.service';
import { WhatsappMessage } from './entities/whatsapp-message.entity';

/**
 * Resolves the registry's named variables against a given ticket's
 * live state. Returns a `{ name: value | null }` map; callers (the
 * send-template flow + the FE preview endpoint) decide what to do
 * with nulls (fallback vs leave blank).
 *
 * Why a dedicated service: we need to read from THREE DBs' worth of
 * state — our own ticket + channel, the inbound messages for the
 * customer identifier, and the ops DB for order / shipping-address
 * data. Keeping the orchestration in one place keeps the templates
 * service / tickets service focused on their own concerns.
 */
@Injectable()
export class TemplateVariableResolverService {
  private readonly logger = new Logger(TemplateVariableResolverService.name);

  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    @InjectRepository(WhatsappMessage)
    private readonly whatsapps: Repository<WhatsappMessage>,
    @InjectRepository(EmailMessage)
    private readonly emails: Repository<EmailMessage>,
    private readonly orders: CustomerOrdersService,
  ) {}

  /**
   * Resolve every registry variable for a given ticket. `names`
   * narrows the resolution — pass only the variables actually
   * referenced by the template to skip the (expensive) customer-
   * orders lookup when it isn't needed.
   */
  async resolveForTicket(
    ticketId: string,
    names: string[],
  ): Promise<Record<string, string | null>> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }
    const channel = await this.channels.findOne({
      where: { id: ticket.channel_id },
    });

    const out: Record<string, string | null> = {};
    const need = new Set(names);

    // --- Ticket-side (cheap) --------------------------------
    if (need.has('ticket_id')) out.ticket_id = String(ticket.id);
    if (need.has('inbox')) out.inbox = channel?.displayName ?? null;
    if (need.has('customer_id')) out.customer_id = ticket.thread_key ?? null;

    // --- Customer identifier (inbound sender) ---------------
    //
    // phone_number is reliably present on WhatsApp tickets (ingest
    // writes the wa_id into whatsapp_message.sender). email is
    // reliably present on EMAIL tickets (email_message.sender). We
    // cross-fill when possible: a WA ticket might have an email on
    // the Shopify order; an email ticket might have a phone there.
    let waSender: string | null = null;
    let emailSender: string | null = null;
    if (need.has('phone_number') || need.has('customer_id')) {
      const wa = await this.whatsapps.findOne({
        where: { ticket_id: ticket.id, type: MessageDirection.RECEIVED },
        order: { createdAt: 'ASC' },
      });
      waSender = wa?.sender ?? null;
    }
    if (need.has('email') || need.has('customer_id')) {
      const em = await this.emails.findOne({
        where: { ticket_id: ticket.id, type: MessageDirection.RECEIVED },
        order: { createdAt: 'ASC' },
      });
      emailSender = em?.sender ?? null;
    }

    if (need.has('phone_number')) {
      out.phone_number = waSender ?? null;
    }
    if (need.has('email')) {
      out.email = emailSender ?? null;
    }

    // --- Order / name variables (ops-DB lookup) -------------
    //
    // Only fire the ops query when the template actually needs it —
    // this hits the Shopify-mirror DB which is a cross-service call.
    const needsOrderOrName =
      need.has('order_id') ||
      need.has('first_name') ||
      need.has('last_name');
    if (needsOrderOrName) {
      try {
        const page = await this.orders.listForTicket(ticket.id, { limit: 1 });
        const latest = page.orders[0];
        if (need.has('order_id')) {
          out.order_id = latest?.orderName ?? null;
        }
        if (need.has('first_name') || need.has('last_name')) {
          // CustomerOrder exposes an `invoiceName` string ("Mohit Gupta")
          // or null. We split on the first space — crude but fine for
          // template fallbacks; a real name directory lives on the
          // customer entity that doesn't exist yet.
          const name = latest?.invoiceName ?? null;
          const [first, ...rest] = name ? name.split(' ') : [];
          if (need.has('first_name')) out.first_name = first ?? null;
          if (need.has('last_name')) {
            out.last_name = rest.length > 0 ? rest.join(' ') : null;
          }
        }
      } catch (err) {
        // Ops DB unreachable or query timeout — resolver returns null
        // for ALL order-sourced vars so the fallback kicks in. Better
        // than failing the whole send.
        this.logger.warn(
          `Order lookup failed for ticket=${ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (need.has('order_id')) out.order_id = null;
        if (need.has('first_name')) out.first_name = null;
        if (need.has('last_name')) out.last_name = null;
      }
    }

    return out;
  }

  /**
   * Phone-first resolver used by the test-send flow — no ticket, no
   * channel inbox, just a phone number from the admin. We can still
   * fill the customer variables (first_name, last_name, phone_number,
   * email) and order_id by looking up the latest Shopify order
   * attached to that phone. Ticket-side variables (ticket_id, inbox,
   * customer_id) are intentionally returned as null because there's
   * no ticket context — admin's expected to use fallbacks there, or
   * these variables shouldn't show up in templates meant for direct
   * sends.
   */
  async resolveForPhone(
    phoneDigits: string,
    names: string[],
  ): Promise<Record<string, string | null>> {
    const need = new Set(names);
    const out: Record<string, string | null> = {};

    if (need.has('ticket_id')) out.ticket_id = null;
    if (need.has('inbox')) out.inbox = null;
    if (need.has('customer_id')) out.customer_id = phoneDigits || null;
    if (need.has('phone_number')) {
      out.phone_number = phoneDigits || null;
    }

    const needsOrder =
      need.has('order_id') ||
      need.has('first_name') ||
      need.has('last_name') ||
      need.has('email');
    if (!needsOrder) return out;

    try {
      const order = await this.orders.findLatestOrderByPhone(phoneDigits);
      if (need.has('order_id')) out.order_id = order?.orderName ?? null;
      if (need.has('first_name') || need.has('last_name')) {
        const name = order?.invoiceName ?? null;
        const [first, ...rest] = name ? name.split(' ') : [];
        if (need.has('first_name')) out.first_name = first ?? null;
        if (need.has('last_name')) {
          out.last_name = rest.length > 0 ? rest.join(' ') : null;
        }
      }
      if (need.has('email')) {
        // Shopify stores customer email on raw_shopify_response.customer.email
        // or shippingAddress.email. CustomerOrder doesn't expose it today;
        // return null so the fallback kicks in. Tracked for V2.
        out.email = null;
      }
    } catch (err) {
      this.logger.warn(
        `Phone-based order lookup failed phone=${phoneDigits}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (need.has('order_id')) out.order_id = null;
      if (need.has('first_name')) out.first_name = null;
      if (need.has('last_name')) out.last_name = null;
      if (need.has('email')) out.email = null;
    }
    return out;
  }
}
