import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { EmailTemplatesService } from '../../email-inbox/email-templates.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/**
 * send_email_template handler. Fires an email template on the
 * triggering ticket, resolving variables from the ticket + customer
 * DB and sending via SMTP with thread headers so the automation
 * message stitches into the recipient's existing visual thread.
 *
 * Delegates to EmailTemplatesService.sendOnTicket which owns the
 * variable resolution + render + SMTP + persist + activity log flow
 * (same path the composer slash picker will eventually use for
 * human-triggered template sends).
 *
 * Channel-type mismatch is caught early + skipped silently with a
 * log line — a rule's event trigger might match WhatsApp tickets
 * too (e.g. 'ticket.created') and we don't want to crash the
 * dispatcher on those.
 */
@Injectable()
export class SendEmailTemplateHandler
  implements ActionHandler<Extract<Action, { type: 'send_email_template' }>>
{
  readonly type = 'send_email_template' as const;
  private readonly logger = new Logger(SendEmailTemplateHandler.name);

  constructor(
    // forwardRef mirrors the WhatsApp handler — EmailInboxModule and
    // AutomationsModule reach into each other.
    @Inject(forwardRef(() => EmailTemplatesService))
    private readonly emailTemplates: EmailTemplatesService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'send_email_template' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    // Channel-type gating happens inside EmailTemplatesService.sendOnTicket
    // (throws BadRequest on non-email tickets). Dispatcher's try/catch
    // on handler errors turns that into a warn log so a mixed-channel
    // event trigger doesn't crash the engine.
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `send_email_template skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.emailTemplates.sendOnTicket(
        ctx.ticket.id,
        action.templateId,
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `send_email_template failed on ticket=${ctx.ticket.id} template=${action.templateId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
