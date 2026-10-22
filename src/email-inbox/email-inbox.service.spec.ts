// EmailInboxService's constructor pulls a dozen services (lifecycle,
// picker, routing, teams, runtime, storage, settings, channels,
// automations, …) and its public ingestInbound/ingestSent methods are
// 300+ lines each with nested transactions and side-effects into every
// one of them. A faithful end-to-end mock is prohibitive.
//
// This spec covers the two private methods where every recent
// regression lived (reopenResolved + rerouteOnCustomerMessage) by
// instantiating EmailInboxService with mock deps and reaching into
// the privates via bracket access. The classification + stitching
// paths in ingestInbound are intentionally out of scope; they're
// invariants documented in memory/email-ingest-invariants.md and will
// get their own spec once we fence the service into smaller units.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
  InjectDataSource: () => (): void => {},
  TypeOrmModule: {
    forRoot: () => ({ module: class {} }),
    forRootAsync: () => ({ module: class {} }),
    forFeature: () => ({ module: class {} }),
  },
}));

import type { EntityManager } from 'typeorm';
import {
  TicketActivity,
  TicketStatus,
  UserRole,
  UserStatus,
} from '../database/enums';
import { EmailInboxService } from './email-inbox.service';
import type { Ticket } from '../tickets/entities/ticket.entity';
import type { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import type { User } from '../users/entities/user.entity';

/* ------------------------------------------------------------------ */
/* Shared mock utilities                                              */
/* ------------------------------------------------------------------ */

type AnyFn = (...args: unknown[]) => unknown;

interface QBOpts {
  execute?: { affected?: number };
  getOne?: unknown;
  getMany?: unknown[];
}

function makeQB(opts: QBOpts = {}): Record<string, AnyFn> {
  const qb: Record<string, AnyFn> = {};
  const chain = [
    'where',
    'andWhere',
    'select',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'limit',
    'innerJoin',
    'leftJoin',
    'update',
    'set',
    'whereInIds',
  ];
  for (const m of chain) qb[m] = jest.fn(() => qb);
  qb.execute = jest.fn(() => Promise.resolve(opts.execute ?? { affected: 1 }));
  qb.getOne = jest.fn(() => Promise.resolve(opts.getOne ?? null));
  qb.getMany = jest.fn(() => Promise.resolve(opts.getMany ?? []));
  return qb;
}

interface RepoMock {
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeRepo(): RepoMock {
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn(),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    createQueryBuilder: jest.fn(() => makeQB()),
  };
}

/**
 * Build an EmailInboxService wired with minimum-viable mocks. Most of
 * the dozen constructor deps are irrelevant for the private methods
 * under test, so they get null-as-any stubs. The caller configures
 * only the repos / services the specific test actually touches.
 */
function buildService(wire?: {
  ticketUpdates?: Array<Record<string, unknown>>;
  savedLogs?: Array<Partial<TicketActivityLog>>;
  router?: { routeFacts: jest.Mock };
  teams?: unknown;
  ticketRepo?: RepoMock;
  userRepo?: RepoMock;
  logRepo?: RepoMock;
  teamRepo?: RepoMock;
  teamMemberRepo?: RepoMock;
  emailRepo?: RepoMock;
}) {
  const ticketUpdates = wire?.ticketUpdates ?? [];
  const savedLogs = wire?.savedLogs ?? [];
  const ticketRepo = wire?.ticketRepo ?? makeRepo();
  const userRepo = wire?.userRepo ?? makeRepo();
  const logRepo = wire?.logRepo ?? makeRepo();
  const teamRepo = wire?.teamRepo ?? makeRepo();
  const teamMemberRepo = wire?.teamMemberRepo ?? makeRepo();
  const emailRepo = wire?.emailRepo ?? makeRepo();

  // Intercept .set() on any QB so tests see what was written.
  const wrap = (repo: RepoMock) => {
    const originalCQB =
      repo.createQueryBuilder.getMockImplementation() ?? (() => makeQB());
    repo.createQueryBuilder = jest.fn((...args: unknown[]) => {
      const qb = originalCQB(...args) as Record<string, AnyFn>;
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((...setArgs: unknown[]) => {
        const patch = setArgs[0] as Record<string, unknown>;
        ticketUpdates.push(patch);
        return originalSet(patch) as unknown;
      }) as AnyFn;
      return qb;
    });
  };
  wrap(ticketRepo);

  // logRepo.save flattens arrays into savedLogs for assertions.
  logRepo.save = jest.fn((x: unknown) => {
    if (Array.isArray(x))
      savedLogs.push(...(x as Partial<TicketActivityLog>[]));
    else savedLogs.push(x as Partial<TicketActivityLog>);
    return Promise.resolve(x);
  });

  // The mgr passed into private methods — its getRepository routes
  // to the right mock based on the entity's class name.
  const mgr = {
    getRepository: jest.fn((entity: unknown) => {
      const name = (entity as { name?: string }).name ?? '';
      if (name === 'Ticket') return ticketRepo;
      if (name === 'User') return userRepo;
      if (name === 'TicketActivityLog') return logRepo;
      if (name === 'Team') return teamRepo;
      if (name === 'TeamMember') return teamMemberRepo;
      if (name === 'EmailMessage') return emailRepo;
      return makeRepo();
    }),
  } as unknown as EntityManager;

  // EmailInboxService's constructor positional args:
  //   emails, dataSource, picker, teams, router, runtime, lifecycle,
  //   storage, appSettings, channels, automations
  const service = new EmailInboxService(
    emailRepo as unknown as never, // emails (EmailMessageRepository)
    null as unknown as never, // dataSource
    null as unknown as never, // picker
    (wire?.teams ?? null) as unknown as never, // teams
    (wire?.router ?? null) as unknown as never, // router
    null as unknown as never, // runtime
    null as unknown as never, // lifecycle
    null as unknown as never, // storage
    null as unknown as never, // appSettings
    null as unknown as never, // channels repo
    null as unknown as never, // automations
  );

  return {
    service,
    mgr,
    ticketRepo,
    userRepo,
    logRepo,
    teamRepo,
    teamMemberRepo,
    emailRepo,
    ticketUpdates,
    savedLogs,
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const BOT_ID = 'bot-id';
const USER_ONLINE_ID = 'user-online-id';
const USER_OFFLINE_ID = 'user-offline-id';

function botUser(): User {
  return {
    id: BOT_ID,
    role: UserRole.BOT,
    status: UserStatus.ONLINE,
    deactivatedAt: null,
    name: 'BOT',
  } as unknown as User;
}

function member(id: string, status: UserStatus): User {
  return {
    id,
    role: UserRole.MEMBER,
    status,
    deactivatedAt: null,
    name: 'Alice',
  } as unknown as User;
}

/* ------------------------------------------------------------------ */
/* reopenResolved — private method, accessed via bracket              */
/* ------------------------------------------------------------------ */

type EmailInboxPrivate = {
  reopenResolved(ticketId: string, mgr: EntityManager): Promise<boolean>;
  rerouteOnCustomerMessage(mgr: EntityManager, ticket: Ticket): Promise<void>;
};

describe('EmailInboxService.reopenResolved', () => {
  it('[regression] re-queues to BOT when assignee is non-ONLINE at reopen time', async () => {
    const ctx = buildService();
    // The method's internal update.affected returns 1 so the flip
    // path is treated as "actually happened" and the logs fire.
    ctx.ticketRepo.findOne.mockResolvedValue({
      id: 't1',
      assignee: USER_OFFLINE_ID,
    });
    ctx.userRepo.findOne
      .mockResolvedValueOnce(member(USER_OFFLINE_ID, UserStatus.OFFLINE))
      .mockResolvedValueOnce(botUser()); // loadBot

    const result = await (
      ctx.service as unknown as EmailInboxPrivate
    ).reopenResolved('t1', ctx.mgr);

    expect(result).toBe(true);
    // Must include assignee=BOT in the UPDATE patch.
    const patch = ctx.ticketUpdates.find((u) => u.assignee === BOT_ID);
    expect(patch).toBeDefined();
    expect(patch).toMatchObject({
      status: TicketStatus.OPEN,
      is_reopened: true,
      resolved_at: null,
    });
    // Both activity rows fire: REOPENED + SENT_BACK_TO_QUEUE. Email
    // tickets never engage bot runtime, so the re-queue to BOT is
    // a data-layer sentinel only — the activity timeline reads as
    // SENT_BACK_TO_QUEUE to match the user-facing semantic.
    expect(ctx.savedLogs.map((l) => l.event)).toEqual([
      TicketActivity.REOPENED,
      TicketActivity.SENT_BACK_TO_QUEUE,
    ]);
  });

  it('keeps an ONLINE assignee owning the ticket', async () => {
    const ctx = buildService();
    ctx.ticketRepo.findOne.mockResolvedValue({
      id: 't1',
      assignee: USER_ONLINE_ID,
    });
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_ONLINE_ID, UserStatus.ONLINE),
    );

    const result = await (
      ctx.service as unknown as EmailInboxPrivate
    ).reopenResolved('t1', ctx.mgr);

    expect(result).toBe(true);
    // UPDATE patch must NOT touch assignee.
    expect(ctx.ticketUpdates[0]).not.toHaveProperty('assignee');
    expect(ctx.ticketUpdates[0]).toMatchObject({
      status: TicketStatus.OPEN,
      is_reopened: true,
      resolved_at: null,
    });
    // Single activity row (REOPENED). No SENT_BACK_TO_QUEUE.
    expect(ctx.savedLogs.map((l) => l.event)).toEqual([
      TicketActivity.REOPENED,
    ]);
  });

  it('BOT-assigned RESOLVED ticket stays on BOT (nothing to reroute)', async () => {
    const ctx = buildService();
    ctx.ticketRepo.findOne.mockResolvedValue({
      id: 't1',
      assignee: BOT_ID,
    });
    ctx.userRepo.findOne.mockResolvedValue(botUser());

    const result = await (
      ctx.service as unknown as EmailInboxPrivate
    ).reopenResolved('t1', ctx.mgr);

    expect(result).toBe(true);
    // No assignee change, no SENT_BACK_TO_QUEUE fallback log.
    expect(ctx.ticketUpdates[0]).not.toHaveProperty('assignee');
    expect(
      ctx.savedLogs.some(
        (l) => l.event === TicketActivity.SENT_BACK_TO_QUEUE,
      ),
    ).toBe(false);
  });

  it('skips fallback (keeps original) and warns when BOT is missing', async () => {
    const ctx = buildService();
    ctx.ticketRepo.findOne.mockResolvedValue({
      id: 't1',
      assignee: USER_OFFLINE_ID,
    });
    ctx.userRepo.findOne
      .mockResolvedValueOnce(member(USER_OFFLINE_ID, UserStatus.OFFLINE))
      .mockResolvedValueOnce(null); // BOT missing

    await (ctx.service as unknown as EmailInboxPrivate).reopenResolved(
      't1',
      ctx.mgr,
    );

    // UPDATE still happens (status flip) but WITHOUT assignee=BOT.
    expect(ctx.ticketUpdates[0]).not.toHaveProperty('assignee');
    // Only REOPENED log fires (no SENT_BACK_TO_QUEUE).
    expect(ctx.savedLogs.map((l) => l.event)).toEqual([
      TicketActivity.REOPENED,
    ]);
  });

  it('returns false (and skips logs) when the UPDATE affects zero rows (race)', async () => {
    const ctx = buildService();
    ctx.ticketRepo.findOne.mockResolvedValue({
      id: 't1',
      assignee: USER_ONLINE_ID,
    });
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_ONLINE_ID, UserStatus.ONLINE),
    );
    // Return 0 affected from the UPDATE QB — simulates "another worker
    // flipped it between our read and write." The method should bail
    // and NOT emit a REOPENED log for a flip that didn't happen.
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => {
      const qb = makeQB({ execute: { affected: 0 } });
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((...args: unknown[]) => {
        const patch = args[0] as Record<string, unknown>;
        ctx.ticketUpdates.push(patch);
        return originalSet(patch) as unknown;
      }) as AnyFn;
      return qb;
    });

    const result = await (
      ctx.service as unknown as EmailInboxPrivate
    ).reopenResolved('t1', ctx.mgr);

    expect(result).toBe(false);
    expect(ctx.savedLogs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* rerouteOnCustomerMessage                                           */
/* ------------------------------------------------------------------ */

describe('EmailInboxService.rerouteOnCustomerMessage', () => {
  // Common fixture: a RECEIVED message is loaded via emailRepo.findOne
  // in the method; stub it to return a minimal row with a sender.
  function wireFirstInbound(ctx: ReturnType<typeof buildService>) {
    ctx.emailRepo.findOne.mockResolvedValue({
      ticket_id: 't1',
      type: 'RECEIVED',
      sender: 'customer@example.com',
      subject: 'help',
    });
  }

  function stubRouting(
    routed: {
      teamId: string;
      matchedRule?: { name: string };
    } | null,
  ) {
    return {
      routeFacts: jest.fn(() => Promise.resolve(routed)),
    };
  }

  it('no-ops silently when the routing decision is unchanged (same team)', async () => {
    const ctx = buildService({ router: stubRouting({ teamId: 'team-a' }) });
    wireFirstInbound(ctx);
    const ticket = {
      id: 't1',
      team_id: 'team-a',
      channel_type: 'EMAIL',
      createdAt: new Date(),
      assignee: USER_ONLINE_ID,
      tags: [],
    } as unknown as Ticket;

    await (
      ctx.service as unknown as EmailInboxPrivate
    ).rerouteOnCustomerMessage(ctx.mgr, ticket);

    // No team-change log, no UPDATE patch.
    expect(ctx.savedLogs).toHaveLength(0);
    expect(ctx.ticketUpdates).toHaveLength(0);
  });

  it('moves team + keeps current assignee when they are a member of the new team', async () => {
    const ctx = buildService({
      router: stubRouting({ teamId: 'team-b', matchedRule: { name: 'OOH' } }),
    });
    wireFirstInbound(ctx);
    // Team lookups for the activity log.
    ctx.teamRepo.findOne.mockImplementation((q: { where: { id?: string } }) => {
      if (q.where.id === 'team-a')
        return Promise.resolve({ id: 'team-a', name: 'General' });
      if (q.where.id === 'team-b')
        return Promise.resolve({ id: 'team-b', name: 'OOH' });
      return Promise.resolve(null);
    });
    // Current assignee is a human (not BOT) and IS still in the new team.
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_ONLINE_ID, UserStatus.ONLINE),
    );
    ctx.teamMemberRepo.findOne.mockResolvedValue({
      team_id: 'team-b',
      user_id: USER_ONLINE_ID,
    });

    const ticket = {
      id: 't1',
      team_id: 'team-a',
      channel_type: 'EMAIL',
      createdAt: new Date(),
      assignee: USER_ONLINE_ID,
      tags: [],
    } as unknown as Ticket;

    await (
      ctx.service as unknown as EmailInboxPrivate
    ).rerouteOnCustomerMessage(ctx.mgr, ticket);

    // Reroute log fired with the matched rule name.
    const rerouteLog = ctx.savedLogs.find(
      (l) =>
        typeof l.log === 'string' &&
        l.log.includes('Auto-rerouted') &&
        l.log.includes('OOH'),
    );
    expect(rerouteLog).toBeDefined();
    // ticketRepo.update was called with team_id change + current assignee kept.
    expect(ctx.ticketRepo.update).toHaveBeenCalledWith(
      { id: 't1' },
      expect.objectContaining({
        team_id: 'team-b',
        assignee: USER_ONLINE_ID,
      }),
    );
  });

  it('parks on BOT when current assignee is NOT a member of the new team', async () => {
    const ctx = buildService({
      router: stubRouting({ teamId: 'team-b', matchedRule: { name: 'OOH' } }),
    });
    wireFirstInbound(ctx);
    ctx.teamRepo.findOne.mockImplementation(() =>
      Promise.resolve({ id: 'team-b', name: 'OOH' }),
    );
    // First userRepo call: load current assignee (not BOT).
    // Second userRepo call: loadBot for the swap.
    ctx.userRepo.findOne
      .mockResolvedValueOnce(member(USER_ONLINE_ID, UserStatus.ONLINE))
      .mockResolvedValueOnce(botUser());
    // Current assignee is NOT a member of the destination team.
    ctx.teamMemberRepo.findOne.mockResolvedValue(null);

    const ticket = {
      id: 't1',
      team_id: 'team-a',
      channel_type: 'EMAIL',
      createdAt: new Date(),
      assignee: USER_ONLINE_ID,
      tags: [],
    } as unknown as Ticket;

    await (
      ctx.service as unknown as EmailInboxPrivate
    ).rerouteOnCustomerMessage(ctx.mgr, ticket);

    // ticketRepo.update was called with team_id change + assignee=BOT.
    expect(ctx.ticketRepo.update).toHaveBeenCalledWith(
      { id: 't1' },
      expect.objectContaining({
        team_id: 'team-b',
        assignee: BOT_ID,
      }),
    );
  });

  it('BOT-assigned ticket moves team but keeps assignee=BOT (nothing to reroute)', async () => {
    const ctx = buildService({
      router: stubRouting({ teamId: 'team-b', matchedRule: { name: 'OOH' } }),
    });
    wireFirstInbound(ctx);
    ctx.teamRepo.findOne.mockImplementation(() =>
      Promise.resolve({ id: 'team-b', name: 'OOH' }),
    );
    ctx.userRepo.findOne.mockResolvedValue(botUser());

    const ticket = {
      id: 't1',
      team_id: 'team-a',
      channel_type: 'EMAIL',
      createdAt: new Date(),
      assignee: BOT_ID,
      tags: [],
    } as unknown as Ticket;

    await (
      ctx.service as unknown as EmailInboxPrivate
    ).rerouteOnCustomerMessage(ctx.mgr, ticket);

    expect(ctx.ticketRepo.update).toHaveBeenCalledWith(
      { id: 't1' },
      expect.objectContaining({
        team_id: 'team-b',
        assignee: BOT_ID,
      }),
    );
  });
});
