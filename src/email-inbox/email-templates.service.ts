import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { EmailSenderService } from '../channels/email/email-sender.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelType,
  EmailTemplateCategory,
  EmailTemplateKind,
  MessageDirection,
  TicketActivity,
} from '../database/enums';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { TemplateVariableResolverService } from '../whatsapp-inbox/template-variable-resolver.service';
import {
  extractVariableReferences,
  isNullableFor,
  renderNamedBody,
  TEMPLATE_VARIABLES_BY_NAME,
  type VariableMappingEntry,
} from '../whatsapp-inbox/template-variables';
import { EmailMessage } from './entities/email-message.entity';
import { EmailTemplate } from './entities/email-template.entity';

/**
 * Strips HTML tags → plain text for the SMTP `text` part. Not a full
 * HTML-to-text converter — just enough so plain-text email clients
 * see something readable instead of the raw markup. Replaces common
 * block tags with newlines first so paragraph breaks survive.
 */
/**
 * Convert a plain-text body (what authors naturally type into the
 * textarea) into valid HTML that email clients + the preview iframe
 * will render with paragraph breaks + line breaks intact.
 *
 * The problem: HTML collapses whitespace by default. An author who
 * types
 *   Hi {{first_name}},
 *
 *   Thank you for reaching out.
 * expects to see two paragraphs. Rendered as HTML, that collapses to
 * one line because newlines are just whitespace.
 *
 * Strategy:
 *   * If the body contains block-level HTML tags (<p>, <div>, <br>,
 *     <h1-6>, <table>, <ul>, <ol>), trust the author — they wrote
 *     HTML on purpose; don't touch it.
 *   * Otherwise, split on blank lines (\n\n+) → wrap each chunk in
 *     <p>...</p>, and replace single \n inside each chunk with <br>.
 *     Preserves the author's visual intent exactly.
 *
 * Idempotent: running this on already-normalized HTML is a no-op
 * because the first branch's regex catches the <p> tags we would
 * have inserted. Safe to call multiple times in the pipeline.
 */
export function normalizeBodyHtml(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Crude HTML-presence check: any block-level opening tag means
  // the author is working in HTML and we shouldn't touch their
  // whitespace semantics.
  if (/<(p|div|br|h[1-6]|table|ul|ol|section|article)\b/i.test(trimmed)) {
    return input;
  }
  // Collapse Windows line endings so the paragraph split works
  // consistently across OS clipboards.
  const normalised = trimmed.replace(/\r\n/g, '\n');
  const paragraphs = normalised.split(/\n{2,}/);
  return paragraphs
    .map((p) => {
      const inner = p
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('<br>');
      // Inline Markdown pass — bold only, applied AFTER paragraph +
      // <br> wrapping so the regex doesn't have to understand
      // newlines. `**text**` → `<strong>text</strong>`; the capture
      // group is HTML-escaped as a precaution against someone
      // slipping a tag between the asterisks. Non-greedy match
      // avoids collapsing distant pairs across unrelated text.
      // Italics (`*…*`, `_…_`) deliberately skipped — too many
      // false positives on prices, product names, URL paths.
      const withBold = inner.replace(
        /\*\*([\s\S]+?)\*\*/g,
        (_, body: string) => `<strong>${escapeHtml(body)}</strong>`,
      );
      return `<p>${withBold}</p>`;
    })
    .filter((p) => p.length > 7)
    .join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build an email-reply subject off an original subject. Collapses
 * any existing "Re:" / "re:" prefix so repeated replies don't
 * accumulate "Re: Re: Re: ..." — matches Gmail / Outlook behaviour.
 */
function toReplySubject(original: string): string {
  const trimmed = (original ?? '').trim();
  if (!trimmed) return 'Re:';
  const stripped = trimmed.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  return `Re: ${stripped}`;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

@Injectable()
export class EmailTemplatesService {
  private readonly logger = new Logger(EmailTemplatesService.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(EmailMessage)
    private readonly emails: Repository<EmailMessage>,
    private readonly sender: EmailSenderService,
    private readonly resolver: TemplateVariableResolverService,
    private readonly dataSource: DataSource,
  ) {}

  async list(
    channelId: string,
    opts: { category?: EmailTemplateCategory } = {},
  ): Promise<EmailTemplate[]> {
    await this.assertEmailChannel(channelId);
    const where = opts.category
      ? { channelId, category: opts.category }
      : { channelId };
    return this.templates.find({
      where,
      relations: { creator: true },
      order: { updatedAt: 'DESC' },
    });
  }

  async findByNumber(
    channelId: string,
    number: number,
  ): Promise<EmailTemplate> {
    await this.assertEmailChannel(channelId);
    const row = await this.templates.findOne({
      where: { channelId, number: String(number) },
      relations: { creator: true },
    });
    if (!row) throw new NotFoundException('Template not found');
    return row;
  }

  async findById(id: string): Promise<EmailTemplate> {
    const row = await this.templates.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Template not found');
    return row;
  }

  async create(
    channelId: string,
    createdBy: string,
    dto: {
      name: string;
      category: EmailTemplateCategory;
      kind: EmailTemplateKind;
      subject?: string | null;
      bodyHtml: string;
      variableMapping?: Array<{ name: string; fallback?: string | null }>;
    },
  ): Promise<EmailTemplate> {
    await this.assertEmailChannel(channelId);
    const existing = await this.templates.findOne({
      where: { channelId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(
        `A template named "${dto.name}" already exists on this channel`,
      );
    }

    // Enforce the kind ↔ subject invariant that the DTO can't express:
    //   OUTREACH requires a non-empty subject (fresh email needs one).
    //   REPLY must NOT carry a subject (it inherits "Re: <original>"
    //     from the thread at send time).
    const trimmedSubject = (dto.subject ?? '').trim();
    if (dto.kind === EmailTemplateKind.OUTREACH && trimmedSubject.length === 0) {
      throw new BadRequestException(
        'Outreach templates require a subject line.',
      );
    }
    const persistedSubject =
      dto.kind === EmailTemplateKind.OUTREACH ? trimmedSubject : null;

    // Variable references — REPLY templates only scan the body
    // (subject doesn't exist); OUTREACH scans subject + body.
    const refs = Array.from(
      new Set([
        ...(persistedSubject ? extractVariableReferences(persistedSubject) : []),
        ...extractVariableReferences(dto.bodyHtml),
      ]),
    );

    for (const name of refs) {
      if (!TEMPLATE_VARIABLES_BY_NAME[name]) {
        throw new BadRequestException(
          `Unknown variable "{{${name}}}". Use the picker on {{ to insert a known variable.`,
        );
      }
    }

    const providedByName = new Map(
      (dto.variableMapping ?? []).map((m) => [m.name, m.fallback ?? null]),
    );
    const orderedMapping: VariableMappingEntry[] = refs.map((name) => {
      const v = TEMPLATE_VARIABLES_BY_NAME[name]!;
      const nullable = isNullableFor(v, 'EMAIL');
      const providedFallback = providedByName.get(name) ?? null;
      if (nullable && (!providedFallback || !providedFallback.trim())) {
        throw new BadRequestException(
          `Variable {{${name}}} may be null on some tickets — a fallback is required.`,
        );
      }
      return {
        name,
        fallback: nullable ? providedFallback!.trim() : null,
      };
    });

    // Normalize once at save so the stored row is already proper HTML.
    // Future renders (preview, send) can use the column verbatim.
    const normalisedHtml = normalizeBodyHtml(dto.bodyHtml);

    return this.templates.save(
      this.templates.create({
        channelId,
        name: dto.name,
        category: dto.category,
        kind: dto.kind,
        subject: persistedSubject,
        bodyHtml: normalisedHtml,
        bodyText: htmlToPlainText(normalisedHtml),
        variableCount: orderedMapping.length,
        variableMapping: orderedMapping.length > 0 ? orderedMapping : null,
        createdBy,
      }),
    );
  }

  /**
   * Direct test send — resolves variables for the given recipient
   * email, renders subject + body, fires through SMTP. No ticket
   * created, no email_message row persisted.
   *
   * Resolution order per variable (same model as the WhatsApp
   * test-send so both channels behave identically for admins):
   *   1. Admin-supplied override (non-empty)
   *   2. Phone-equivalent: resolveForEmail looks up the latest
   *      Shopify order on the recipient's email, pulls name/order_id
   *   3. Template fallback
   *   4. Reject if a non-nullable variable still has no value
   */
  async testSend(
    templateId: string,
    channelId: string,
    actorId: string,
    recipientEmail: string,
    overrides: Record<string, string>,
  ): Promise<{ externalMessageId: string }> {
    const template = await this.findById(templateId);
    if (template.channelId !== channelId) {
      throw new BadRequestException(
        'Template belongs to a different email channel',
      );
    }
    const channel = await this.channels.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'Email templates can only be sent on email channels',
      );
    }

    const to = recipientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException('Recipient email looks invalid');
    }

    // Resolve the variable → value map once; use it for both subject
    // and body renders so a value only lands once per send.
    let replacementMap: Record<string, string> = {};
    if (template.variableMapping && template.variableMapping.length > 0) {
      const needingResolve = template.variableMapping
        .filter((m) => {
          const o = overrides[m.name];
          return !(o !== undefined && o.trim().length > 0);
        })
        .map((m) => m.name);
      const resolved =
        needingResolve.length > 0
          ? await this.resolver.resolveForEmail(to, needingResolve)
          : {};
      for (const m of template.variableMapping) {
        const o = overrides[m.name];
        if (o !== undefined && o.trim().length > 0) {
          replacementMap[m.name] = o;
          continue;
        }
        const r = resolved[m.name];
        if (r !== undefined && r !== null && r !== '') {
          replacementMap[m.name] = r;
          continue;
        }
        if (m.fallback !== null) {
          replacementMap[m.name] = m.fallback;
          continue;
        }
        throw new BadRequestException(
          `Variable "${m.name}" is non-nullable — provide an override for the test send`,
        );
      }
    }

    // REPLY templates don't carry a subject (they inherit "Re: ..."
    // from the thread they reply to at ticket send time). The test
    // flow has no thread to inherit from, so we fake a lightweight
    // "Test reply" subject just so SMTP has something to put in the
    // header. The admin's testing the body, not the subject.
    const subjectSource =
      template.kind === EmailTemplateKind.REPLY
        ? '(test) Re: template preview'
        : (template.subject ?? '');
    const subject = renderNamedBody(subjectSource, replacementMap);
    const bodyHtml = normalizeBodyHtml(
      renderNamedBody(template.bodyHtml, replacementMap),
    );
    const bodyText = htmlToPlainText(bodyHtml);

    this.logger.log(
      `Test email template actor=${actorId} template=${template.name} kind=${template.kind} to=${to}`,
    );

    const result = await this.sender.sendSystem({
      channel,
      to: [to],
      subject,
      body: bodyText,
      bodyHtml,
    });
    return { externalMessageId: result.externalMessageId };
  }

  /**
   * Resolve + render a template against a specific ticket WITHOUT
   * sending. Powers the composer's slash picker — the agent picks a
   * template, we inject the rendered subject + body into their
   * composer so they can read / tweak / send via the standard reply
   * path.
   *
   * Resolution semantics mirror sendOnTicket exactly:
   *   * REPLY templates → subject = "Re: <firstInbound.subject>"
   *   * OUTREACH templates → template's own subject rendered with
   *                           variables filled from ticket context
   *   * Non-nullable variables that resolve to null still raise
   *     BadRequest so the preview matches what sendOnTicket would
   *     do — don't want a preview that would fail at send time.
   */
  async previewOnTicket(
    ticketId: string,
    templateId: string,
  ): Promise<{ subject: string; bodyHtml: string; bodyText: string }> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const channel = await this.channels.findOne({
      where: { id: ticket.channel_id },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'Email templates can only be previewed on email tickets',
      );
    }

    const template = await this.findById(templateId);
    if (template.channelId !== channel.id) {
      throw new BadRequestException(
        'Template is bound to a different email inbox',
      );
    }

    const firstInbound = await this.emails.findOne({
      where: { ticket_id: ticket.id, type: MessageDirection.RECEIVED },
      order: { createdAt: 'ASC' },
    });

    let replacementMap: Record<string, string> = {};
    if (template.variableMapping && template.variableMapping.length > 0) {
      const names = template.variableMapping.map((m) => m.name);
      const resolved = await this.resolver.resolveForTicket(ticket.id, names);
      for (const m of template.variableMapping) {
        const r = resolved[m.name];
        if (r !== undefined && r !== null && r !== '') {
          replacementMap[m.name] = r;
          continue;
        }
        if (m.fallback !== null) {
          replacementMap[m.name] = m.fallback;
          continue;
        }
        throw new BadRequestException(
          `Variable "${m.name}" is non-nullable and resolved to null on this ticket`,
        );
      }
    }

    const subjectSource =
      template.kind === EmailTemplateKind.REPLY
        ? toReplySubject(firstInbound?.subject ?? '')
        : renderNamedBody(template.subject ?? '', replacementMap);
    const subject = (subjectSource || '').trim() || '(no subject)';
    const bodyHtml = normalizeBodyHtml(
      renderNamedBody(template.bodyHtml, replacementMap),
    );
    const bodyText = htmlToPlainText(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }

  /**
   * Send a template on a specific ticket as if a human agent had
   * fired it from the composer. Mirrors TicketsService.sendTemplate
   * (WhatsApp) but for email, including:
   *   * Variable resolution via the shared resolver (ticket + customer
   *     DB), with per-variable fallbacks for null slots.
   *   * Rendering of subject + body against the resolved values.
   *   * SMTP send with In-Reply-To + References headers off the LAST
   *     inbound message so the recipient's MUA stitches the automation
   *     send into the existing visual thread.
   *   * Transactional persist of a SENT email_message row + an
   *     AGENT_REPLIED activity log line, so the audit trail reads
   *     identically to a human-sent email.
   *
   * Used by:
   *   * The send_email_template automation action (today)
   *   * The composer slash picker on email tickets (future slice)
   *   * Direct bot-driven outbound (future)
   *
   * Non-email ticket → BadRequest. Cross-channel template (template
   * bound to a different inbox) → BadRequest. Missing inbound anchor
   * → BadRequest (can't thread without one; automation shouldn't
   * initiate cold mail from a ticket).
   */
  async sendOnTicket(
    ticketId: string,
    templateId: string,
    actingUser: AuthenticatedUser,
  ): Promise<void> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const channel = await this.channels.findOne({
      where: { id: ticket.channel_id },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'Email templates can only be sent on email tickets',
      );
    }

    const template = await this.findById(templateId);
    if (template.channelId !== channel.id) {
      throw new BadRequestException(
        'Template is bound to a different email inbox',
      );
    }

    // Both kinds need to know who to send to. The ticket's thread_key
    // is the customer's email in the EMAIL channel — but we prefer
    // the actual sender column from the first inbound as a defence
    // against mangled thread_keys. Only reach for thread_key if we
    // literally have no inbound (edge case; tickets usually originate
    // from inbound).
    const firstInbound = await this.emails.findOne({
      where: { ticket_id: ticket.id, type: MessageDirection.RECEIVED },
      order: { createdAt: 'ASC' },
    });
    const customerEmail =
      firstInbound?.sender?.trim() || ticket.thread_key?.trim();
    if (!customerEmail) {
      throw new BadRequestException(
        'This ticket has no customer address to send to',
      );
    }

    // Thread anchor only matters for REPLY templates.
    const lastInbound =
      template.kind === EmailTemplateKind.REPLY
        ? await this.emails.findOne({
            where: { ticket_id: ticket.id, type: MessageDirection.RECEIVED },
            order: { createdAt: 'DESC' },
          })
        : null;
    if (template.kind === EmailTemplateKind.REPLY && !lastInbound) {
      // A REPLY template with nothing to reply to — refuse rather
      // than silently sending as a fresh email.
      throw new BadRequestException(
        'REPLY templates need an inbound email on the ticket to anchor against. Use an OUTREACH template to send cold.',
      );
    }

    // References chain = every message's external id in chronological
    // order so Outlook-class MUAs can stitch deep threads. Only
    // computed for REPLY sends.
    const references =
      template.kind === EmailTemplateKind.REPLY
        ? (
            await this.emails.find({
              where: { ticket_id: ticket.id },
              order: { createdAt: 'ASC' },
            })
          )
            .map((m) => m.external_message_id)
            .filter((s): s is string => Boolean(s))
        : [];

    // Resolve variables + render. Mirrors the testSend path's
    // resolution semantics: override is never present here (automation
    // doesn't carry one), so every variable goes resolver → fallback.
    let replacementMap: Record<string, string> = {};
    if (template.variableMapping && template.variableMapping.length > 0) {
      const names = template.variableMapping.map((m) => m.name);
      const resolved = await this.resolver.resolveForTicket(ticket.id, names);
      for (const m of template.variableMapping) {
        const r = resolved[m.name];
        if (r !== undefined && r !== null && r !== '') {
          replacementMap[m.name] = r;
          continue;
        }
        if (m.fallback !== null) {
          replacementMap[m.name] = m.fallback;
          continue;
        }
        throw new BadRequestException(
          `Variable "${m.name}" is non-nullable and resolved to null on this ticket`,
        );
      }
    }

    // Subject source branches on kind:
    //   REPLY    → "Re: <original first-inbound subject>" (standard
    //              email reply conventions; dedupes the Re: prefix if
    //              already present).
    //   OUTREACH → the template's own subject with variables rendered.
    const subjectSource =
      template.kind === EmailTemplateKind.REPLY
        ? toReplySubject(firstInbound?.subject ?? '')
        : renderNamedBody(template.subject ?? '', replacementMap);
    const subject = subjectSource.trim() || '(no subject)';
    const bodyHtml = normalizeBodyHtml(
      renderNamedBody(template.bodyHtml, replacementMap),
    );
    const bodyText = htmlToPlainText(bodyHtml);

    // SMTP first (outside the txn — can't hold a connection open
    // during the HTTP call). REPLY sets thread headers; OUTREACH
    // sends with no In-Reply-To / References so Gmail / Outlook show
    // it as a fresh conversation in the customer's inbox.
    const { externalMessageId } = await this.sender.sendReply({
      channel,
      to: [customerEmail],
      subject,
      body: bodyText,
      bodyHtml,
      inReplyTo:
        template.kind === EmailTemplateKind.REPLY
          ? (lastInbound?.external_message_id ?? null)
          : null,
      references,
    });

    try {
      await this.dataSource.transaction(async (mgr) => {
        const emailRepo = mgr.getRepository(EmailMessage);
        const logRepo = mgr.getRepository(TicketActivityLog);
        await emailRepo.save(
          emailRepo.create({
            channelId: ticket.channel_id,
            ticket_id: ticket.id,
            type: MessageDirection.SENT,
            subject,
            content: bodyText,
            content_html: bodyHtml,
            sender: channel.inbox_contact,
            receiver: [customerEmail],
            external_message_id: externalMessageId,
          }),
        );
        await logRepo.save({
          ticket_id: ticket.id,
          event: TicketActivity.AGENT_REPLIED,
          actor_id: actingUser.id,
          log: `Sent email template "${template.name}" (automation)`,
        });
      });
    } catch (persistErr) {
      const errMsg =
        persistErr instanceof Error ? persistErr.message : String(persistErr);
      this.logger.error(
        `Email template send ok but DB persist failed. ticket=${ticket.id} template=${template.name} externalId=${externalMessageId} error=${errMsg}`,
      );
      throw persistErr;
    }
  }

  private async assertEmailChannel(channelId: string): Promise<void> {
    const channel = await this.channels.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'Templates are only available on email channels',
      );
    }
  }
}
