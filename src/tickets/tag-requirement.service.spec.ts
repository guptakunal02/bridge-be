// @nestjs/typeorm ships as ESM which jest's default transform can't
// handle. Stub the one decorator the service imports so the module
// graph resolves.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
}));

import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { TicketStatus, WaitingAction } from '../database/enums';
import type { AppSettingsService } from '../settings/app-settings.service';
import type { Ticket } from './entities/ticket.entity';
import { TagRequirementService } from './tag-requirement.service';

/**
 * Focused specs on the checker. The guard is a thin adapter around
 * this service, so covering the policy here covers both callsites
 * (guard + bulkUpdate loop) at once.
 */
describe('TagRequirementService.assertSatisfied', () => {
  interface Ctx {
    checker: TagRequirementService;
    ticket: Partial<Ticket>;
    settingOn: boolean;
    ticketRepoCalls: number;
  }

  function build(opts: {
    ticket?: Partial<Ticket> | null;
    settingOn: boolean;
  }): Ctx {
    const ctx: Ctx = {
      // Filled in below.
      checker: null as unknown as TagRequirementService,
      ticket: opts.ticket ?? {},
      settingOn: opts.settingOn,
      ticketRepoCalls: 0,
    };
    const ticketRepo = {
      findOne: async () => {
        ctx.ticketRepoCalls++;
        return opts.ticket === null ? null : (ctx.ticket as Ticket);
      },
    };
    const appSettings = {
      getRequireTagToResolve: async () => opts.settingOn,
    } as unknown as AppSettingsService;
    ctx.checker = new TagRequirementService(
      ticketRepo as unknown as Repository<Ticket>,
      appSettings,
    );
    return ctx;
  }

  it('is a no-op when body is undefined', async () => {
    const { checker } = build({ settingOn: true });
    await expect(checker.assertSatisfied('t1', undefined)).resolves.toBeUndefined();
  });

  it('is a no-op when the target status is not a closing state', async () => {
    const { checker, ticketRepoCalls } = build({ settingOn: true });
    await checker.assertSatisfied('t1', { status: TicketStatus.OPEN });
    // Setting not even consulted for non-closing transitions.
    expect(ticketRepoCalls).toBe(0);
  });

  it('is a no-op for WAITING without AUTO_RESOLVE waitingAction', async () => {
    const { checker } = build({ settingOn: true });
    await expect(
      checker.assertSatisfied('t1', {
        status: TicketStatus.WAITING,
        waitingAction: WaitingAction.REOPEN,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the setting is off — never even reads the ticket', async () => {
    const ctx = build({ settingOn: false, ticket: { tags: [] } });
    await ctx.checker.assertSatisfied('t1', {
      status: TicketStatus.RESOLVED,
    });
    expect(ctx.ticketRepoCalls).toBe(0);
  });

  it('allows the transition when the ticket already has tags', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: ['refund-request'] },
    });
    await expect(
      checker.assertSatisfied('t1', { status: TicketStatus.RESOLVED }),
    ).resolves.toBeUndefined();
  });

  it('allows the transition when the same PATCH is adding tags', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: [] },
    });
    await expect(
      checker.assertSatisfied('t1', {
        status: TicketStatus.RESOLVED,
        tags: ['refund-request'],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a tagless RESOLVED transition when the setting is on', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: [] },
    });
    await expect(
      checker.assertSatisfied('t1', { status: TicketStatus.RESOLVED }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects WAITING+AUTO_RESOLVE with no tags with the WAITING-specific copy', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: [] },
    });
    await expect(
      checker.assertSatisfied('t1', {
        status: TicketStatus.WAITING,
        waitingAction: WaitingAction.AUTO_RESOLVE,
      }),
    ).rejects.toThrow(/auto-resolving Waiting/);
  });

  it('lets a no-op re-PATCH through even without tags (already RESOLVED)', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.RESOLVED, tags: [] },
    });
    await expect(
      checker.assertSatisfied('t1', { status: TicketStatus.RESOLVED }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the ticket cannot be found — handler will 404', async () => {
    const { checker } = build({ settingOn: true, ticket: null });
    await expect(
      checker.assertSatisfied('missing', { status: TicketStatus.RESOLVED }),
    ).resolves.toBeUndefined();
  });

  it('treats PATCH { tags: [] } as an intent-to-clear and blocks the close', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: ['old-tag'] },
    });
    await expect(
      checker.assertSatisfied('t1', {
        status: TicketStatus.RESOLVED,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores non-string entries in body.tags (defensive coercion)', async () => {
    const { checker } = build({
      settingOn: true,
      ticket: { status: TicketStatus.OPEN, tags: [] },
    });
    await expect(
      checker.assertSatisfied('t1', {
        status: TicketStatus.RESOLVED,
        tags: [42, null, undefined],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
