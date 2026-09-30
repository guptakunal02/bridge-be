import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketStatus, WaitingAction } from '../database/enums';
import { AppSettingsService } from '../settings/app-settings.service';
import { Ticket } from './entities/ticket.entity';

/**
 * "Require a tag before closing a ticket" policy. Extracted so the
 * rule lives in one place, has its own spec surface, and can be
 * re-invoked from any future path that closes tickets.
 *
 * Called by TicketsService.update() at the top of every mutation.
 * bulkUpdate reaches update() per-ticket, so it inherits the check
 * for free — a tagless entry in a mixed batch surfaces in failed[]
 * rather than tanking the whole request.
 *
 * `body` is typed loosely (Record<string, unknown>) so the checker
 * doesn't couple to the caller's DTO shape — same reason we don't
 * inline it into update(): the rule is transport-agnostic.
 */
@Injectable()
export class TagRequirementService {
  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly appSettings: AppSettingsService,
  ) {}

  /**
   * Throws BadRequestException when the workspace setting is on
   * AND the requested transition would close a ticket that has
   * no tags AND the same PATCH isn't adding any. Returns without
   * throwing otherwise (setting off, non-closing target, or tags
   * present via either the ticket or the payload).
   */
  async assertSatisfied(
    ticketId: string,
    body: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!body || typeof body !== 'object') return;

    // Which target status are we asked to move to? Only two land
    // as "closing":
    //   1. RESOLVED — direct manual close
    //   2. WAITING with waitingAction=AUTO_RESOLVE — the sweep will
    //      close it later with no member touch, so we require the
    //      tag NOW rather than waiting for a moment that never comes
    const status = readString(body.status);
    if (status !== TicketStatus.RESOLVED && status !== TicketStatus.WAITING) {
      return;
    }
    const waitingAction = readString(body.waitingAction);
    const isClosingTarget =
      status === TicketStatus.RESOLVED ||
      (status === TicketStatus.WAITING &&
        waitingAction === WaitingAction.AUTO_RESOLVE);
    if (!isClosingTarget) return;

    // Fast path: setting off → guard is a no-op (matches the
    // "return true early" shape the design brief called out).
    const required = await this.appSettings.getRequireTagToResolve();
    if (!required) return;

    // Setting is on. Load the ticket to decide whether this is a
    // genuine transition (a no-op re-PATCH on an already-RESOLVED
    // ticket shouldn't fire the guard) and to know the current tags.
    const ticket = await this.tickets.findOne({
      where: { id: ticketId },
      select: { id: true, tags: true, status: true },
    });
    if (!ticket) return; // let the handler surface the 404 cleanly
    if (ticket.status === status) return; // no-op re-PATCH, allow through

    // Effective tags: whatever the PATCH sets wins, even if the
    // PATCH sets `tags: []` explicitly (that's an intent-to-clear).
    // Otherwise the ticket's current tags decide.
    const bodyTags = readStringArray(body.tags);
    const effectiveTags = bodyTags ?? ticket.tags ?? [];
    if (effectiveTags.length > 0) return;

    throw new BadRequestException(
      status === TicketStatus.WAITING
        ? 'Apply at least one tag before moving this ticket to auto-resolving Waiting.'
        : 'Apply at least one tag before resolving this ticket.',
    );
  }
}

function readString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function readStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}
