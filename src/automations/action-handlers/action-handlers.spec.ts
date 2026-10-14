// Importing a handler drags in TicketsService → BotRuntimeService →
// OpsReadService → DatabaseModule which calls TypeOrmModule.forRootAsync
// at module-load time. Stub both the decorator and the module-level
// APIs so the transitive chain evaluates without a real Nest container.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
  InjectDataSource: () => (): void => {},
  TypeOrmModule: {
    forRoot: () => ({ module: class {} }),
    forRootAsync: () => ({ module: class {} }),
    forFeature: () => ({ module: class {} }),
  },
}));

import type { Repository } from 'typeorm';
import { TicketStatus, UserRole } from '../../database/enums';
import type { Team } from '../../teams/entities/team.entity';
import type { TicketsService } from '../../tickets/tickets.service';
import type { User } from '../../users/entities/user.entity';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';
import { AddTagHandler } from './add-tag.handler';
import { RemoveTagHandler } from './remove-tag.handler';
import { SetAssigneeHandler } from './set-assignee.handler';
import { SetStatusHandler } from './set-status.handler';
import { SetTeamHandler } from './set-team.handler';

/**
 * Covers each automation action handler end-to-end. Each handler is a
 * small adapter around TicketsService.update, so we assert on
 *   (a) idempotency short-circuits (already-in-state → no update)
 *   (b) defensive bails (missing BOT, deactivated user, unknown team)
 *   (c) the exact patch handed to tickets.update when the action fires
 *   (d) in-memory ctx mutations that cascade to subsequent cases in
 *       the same evaluation (the add_tag / remove_tag "snapshot
 *       staleness" bug — ticket #1200 — lives here)
 *
 * The handlers depend on TicketsService + AutomationSystemActor +
 * (sometimes) a Repository<User | Team>. We mock all of them with
 * jest.fn() so the module graph resolves without a Nest container.
 */

const BOT_SYS = {
  id: 'bot-id',
  email: 'bot@internal',
  role: UserRole.BOT,
  isApproved: true,
};

function mockTickets() {
  return {
    update: jest.fn(async () => ({})),
  } as unknown as TicketsService;
}

function mockActor(sys: typeof BOT_SYS | null = BOT_SYS): AutomationSystemActor {
  return {
    resolve: jest.fn(async () => sys),
  } as unknown as AutomationSystemActor;
}

function mockUserRepo(opts: {
  bot?: User | null;
  target?: User | null;
}): Repository<User> {
  return {
    findOne: jest.fn(async (q: { where: { role?: UserRole; id?: string } }) => {
      if (q.where.role === UserRole.BOT) return opts.bot ?? null;
      if (q.where.id) return opts.target ?? null;
      return null;
    }),
  } as unknown as Repository<User>;
}

function mockTeamRepo(team: Team | null): Repository<Team> {
  return {
    findOne: jest.fn(async () => team),
  } as unknown as Repository<Team>;
}

function ctxWith(overrides: Partial<AutomationEventPayload['ticket']>): AutomationEventPayload {
  return {
    event: 'ticket.created',
    ticket: {
      id: 't1',
      channelId: 'ch1',
      channelType: 'EMAIL',
      status: TicketStatus.OPEN,
      teamId: 'team-a',
      assigneeId: null,
      tags: [],
      ...overrides,
    } as AutomationEventPayload['ticket'],
    actor: null,
  } as unknown as AutomationEventPayload;
}

/* ------------------------------------------------------------------ */
/* AddTagHandler                                                      */
/* ------------------------------------------------------------------ */

describe('AddTagHandler', () => {
  it('calls tickets.update with the new tag appended to the existing set', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new AddTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: ['vip'] });

    await handler.execute(
      { type: 'add_tag', tagName: 'refund' },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { tags: ['vip', 'refund'] },
      BOT_SYS,
    );
  });

  it('short-circuits when the tag is already present (idempotency)', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new AddTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: ['refund'] });

    await handler.execute({ type: 'add_tag', tagName: 'refund' }, ctx);

    expect(tickets.update).not.toHaveBeenCalled();
    // Also no need to resolve the system actor if we bailed early.
    expect(actor.resolve).not.toHaveBeenCalled();
  });

  it('[regression #1200] mutates ctx.ticket.tags so subsequent cases in the same evaluation see the new tag', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new AddTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: [] });

    await handler.execute({ type: 'add_tag', tagName: 'escalated' }, ctx);

    // The whole point of the fix: subsequent handlers reading
    // ctx.ticket.tags see "escalated" without a re-fetch.
    expect(ctx.ticket.tags).toEqual(['escalated']);
  });

  it('skips (with a warn) when AutomationSystemActor returns null', async () => {
    const tickets = mockTickets();
    const actor = mockActor(null);
    const handler = new AddTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: [] });

    await handler.execute({ type: 'add_tag', tagName: 'refund' }, ctx);

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('normalises the tag name (trim + lowercase)', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new AddTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: [] });

    await handler.execute(
      { type: 'add_tag', tagName: '  Refund  ' },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { tags: ['refund'] },
      BOT_SYS,
    );
  });
});

/* ------------------------------------------------------------------ */
/* RemoveTagHandler                                                   */
/* ------------------------------------------------------------------ */

describe('RemoveTagHandler', () => {
  it('calls tickets.update with the tag removed', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new RemoveTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: ['vip', 'refund'] });

    await handler.execute(
      { type: 'remove_tag', tagName: 'refund' },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { tags: ['vip'] },
      BOT_SYS,
    );
  });

  it('short-circuits when the tag is not present (idempotency)', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new RemoveTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: ['vip'] });

    await handler.execute(
      { type: 'remove_tag', tagName: 'refund' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('mutates ctx.ticket.tags for subsequent cases (sibling of the add_tag fix)', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new RemoveTagHandler(tickets, actor);
    const ctx = ctxWith({ tags: ['vip', 'refund'] });

    await handler.execute(
      { type: 'remove_tag', tagName: 'refund' },
      ctx,
    );

    expect(ctx.ticket.tags).toEqual(['vip']);
  });
});

/* ------------------------------------------------------------------ */
/* SetStatusHandler                                                   */
/* ------------------------------------------------------------------ */

describe('SetStatusHandler', () => {
  it('calls tickets.update when transitioning to RESOLVED', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new SetStatusHandler(tickets, actor);
    const ctx = ctxWith({ status: TicketStatus.OPEN });

    await handler.execute(
      { type: 'set_status', status: TicketStatus.RESOLVED },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { status: TicketStatus.RESOLVED },
      BOT_SYS,
    );
  });

  it('rejects WAITING with a warn — V1 does not accept timed statuses from automations', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new SetStatusHandler(tickets, actor);
    const ctx = ctxWith({ status: TicketStatus.OPEN });

    await handler.execute(
      { type: 'set_status', status: TicketStatus.WAITING },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('rejects IN_FOLLOWUP similarly', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new SetStatusHandler(tickets, actor);
    const ctx = ctxWith({ status: TicketStatus.OPEN });

    await handler.execute(
      { type: 'set_status', status: TicketStatus.IN_FOLLOWUP },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('short-circuits when the ticket is already in the target status', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const handler = new SetStatusHandler(tickets, actor);
    const ctx = ctxWith({ status: TicketStatus.RESOLVED });

    await handler.execute(
      { type: 'set_status', status: TicketStatus.RESOLVED },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* SetTeamHandler                                                     */
/* ------------------------------------------------------------------ */

describe('SetTeamHandler', () => {
  it('calls tickets.update when transitioning to a different team that exists', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const teams = mockTeamRepo({ id: 'team-b' } as Team);
    const handler = new SetTeamHandler(tickets, actor, teams);
    const ctx = ctxWith({ teamId: 'team-a' });

    await handler.execute(
      { type: 'set_team', teamId: 'team-b' },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { teamId: 'team-b' },
      BOT_SYS,
    );
  });

  it('warns and skips when the target team is not found', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const teams = mockTeamRepo(null);
    const handler = new SetTeamHandler(tickets, actor, teams);
    const ctx = ctxWith({ teamId: 'team-a' });

    await handler.execute(
      { type: 'set_team', teamId: 'team-nonexistent' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('short-circuits when the ticket is already in the target team', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const teams = mockTeamRepo({ id: 'team-a' } as Team);
    const handler = new SetTeamHandler(tickets, actor, teams);
    const ctx = ctxWith({ teamId: 'team-a' });

    await handler.execute(
      { type: 'set_team', teamId: 'team-a' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* SetAssigneeHandler                                                 */
/* ------------------------------------------------------------------ */

describe('SetAssigneeHandler', () => {
  const botUser = {
    id: 'bot-id',
    role: UserRole.BOT,
  } as unknown as User;

  it('resolves userId=null to BOT and calls update', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const users = mockUserRepo({ bot: botUser });
    const handler = new SetAssigneeHandler(tickets, actor, users);
    const ctx = ctxWith({ assigneeId: 'alice' });

    await handler.execute(
      { type: 'set_assignee', userId: null },
      ctx,
    );

    expect(tickets.update).toHaveBeenCalledWith(
      't1',
      { assigneeId: 'bot-id' },
      BOT_SYS,
    );
  });

  it('warns and skips when userId=null but BOT is not seeded', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const users = mockUserRepo({ bot: null });
    const handler = new SetAssigneeHandler(tickets, actor, users);
    const ctx = ctxWith({ assigneeId: 'alice' });

    await handler.execute({ type: 'set_assignee', userId: null }, ctx);

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('warns and skips when the target user is deactivated', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const users = mockUserRepo({
      target: {
        id: 'bob',
        role: UserRole.MEMBER,
        deactivatedAt: new Date(),
      } as unknown as User,
    });
    const handler = new SetAssigneeHandler(tickets, actor, users);
    const ctx = ctxWith({ assigneeId: 'alice' });

    await handler.execute(
      { type: 'set_assignee', userId: 'bob' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('warns and skips when the target user does not exist', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const users = mockUserRepo({ target: null });
    const handler = new SetAssigneeHandler(tickets, actor, users);
    const ctx = ctxWith({ assigneeId: 'alice' });

    await handler.execute(
      { type: 'set_assignee', userId: 'ghost' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('short-circuits when the ticket is already assigned to the target', async () => {
    const tickets = mockTickets();
    const actor = mockActor();
    const users = mockUserRepo({
      target: {
        id: 'bob',
        role: UserRole.MEMBER,
        deactivatedAt: null,
      } as unknown as User,
    });
    const handler = new SetAssigneeHandler(tickets, actor, users);
    const ctx = ctxWith({ assigneeId: 'bob' });

    await handler.execute(
      { type: 'set_assignee', userId: 'bob' },
      ctx,
    );

    expect(tickets.update).not.toHaveBeenCalled();
  });
});
