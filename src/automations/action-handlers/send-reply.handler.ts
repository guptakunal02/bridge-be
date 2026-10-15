import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';
import { customerName, expand } from './send-reply-template';

/**
 * send_reply handler. Routes an automation-authored message to the
 * customer through the ticket's channel-appropriate sender — EMAIL
 * via SMTP, WHATSAPP via Meta Graph — by delegating to
 * TicketsService.reply. That reuses every policy already in place
 * (24h window, thread stitching, per-channel persistence, activity
 * log) so an automated reply reads exactly like an agent reply in
 * the thread.
 *
 * The body supports two tokens expanded at send time:
 *   {customerName} — derived from the sender in the dispatched event
 *   {ticketId}     — the Bridge ticket id
 * See customerName() + expand() below for details.
 *
 * Loop safety: send_reply writes a SENT message, which does NOT
 * emit MESSAGE_RECEIVED. The only emit from an outbound reply is
 * AGENT_REPLIED (not an automation trigger). So this handler cannot
 * cascade back into itself.
 */
@Injectable()
export class SendReplyHandler
  implements ActionHandler<Extract<Action, { type: 'send_reply' }>>
{
  readonly type = 'send_reply' as const;
  private readonly logger = new Logger(SendReplyHandler.name);

  constructor(
    // forwardRef because AutomationsModule and TicketsModule are
    // mutually-dependent — TicketsService.reply is what we delegate to.
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'send_reply' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const raw = (action.body ?? '').trim();
    if (!raw) {
      this.logger.warn(
        `send_reply skipped on ticket=${ctx.ticket.id}: empty body`,
      );
      return;
    }
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `send_reply skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    const senderInPayload =
      ctx.event === 'message.received' || ctx.event === 'ticket.created'
        ? (ctx.payload as { sender?: string | null }).sender ?? null
        : null;
    const body = expand(raw, {
      customerName: customerName(senderInPayload),
      ticketId: String(ctx.ticket.id),
    });
    try {
      await this.tickets.reply(ctx.ticket.id, { body }, sys);
    } catch (err) {
      // Swallow + warn. Any send error (24h window closed, Meta
      // reject, SMTP transient failure) is logged here instead of
      // crashing the dispatcher — one bad action must never stop
      // the rest of the rule's actions from firing.
      this.logger.warn(
        `send_reply failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

