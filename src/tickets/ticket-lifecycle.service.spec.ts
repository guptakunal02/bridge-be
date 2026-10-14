// Follows the pattern established by tag-requirement.service.spec.ts —
// stub @nestjs/typeorm's InjectRepository so the module graph resolves
// without the Nest DI container.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
}));

import type { DataSource, EntityManager, Repository } from 'typeorm';
import {
  TicketActivity,
  TicketStatus,
  UserRole,
  UserStatus,
  WaitingAction,
} from '../database/enums';
import type { TicketActivityLog } from './entities/ticket-activity-log.entity';
import type { Ticket } from './entities/ticket.entity';
import type { User } from '../users/entities/user.entity';
import { TicketLifecycleService } from './ticket-lifecycle.service';

/**
 * Regression + invariant coverage for TicketLifecycleService.
 *
 * This file exists because every bug we chased in production the past
 * week — the wake-onto-offline-member cases, the sweep-skips-followup
 * early-return, the WAITING-reopen 4h-grace that ghosted tickets —
 * lived in this one service and had ZERO test coverage. Each `it`
 * block below encodes a specific scar story, named after the bug
 * (where applicable) so the next person touching the file can see
 * which invariant they'd break.
 *
 * The service is heavy on TypeORM query-builder chains, so the
 * mocking is DIY (there's no in-memory DB). Pattern:
 *   * `makeQB` returns a chainable mock where every builder method
 *     returns `self` and the terminal methods (`getOne`/`getMany`/
 *     `execute`) return whatever the test sets up.
 *   * `buildCtx` wires a `DataSource.transaction` stub that invokes
 *     the callback with a mocked `EntityManager` whose
 *     `getRepository(X)` returns the ticket / user / log repo mock
 *     the test configured.
 *
 * Verbose but it keeps each test's intent on the surface — no
 * ceremony hidden inside shared fixtures.
 */

/* ------------------------------------------------------------------ */
/* QueryBuilder + repo mocks                                          */
/* ------------------------------------------------------------------ */

type AnyFn = (...args: unknown[]) => unknown;
interface QBOpts {
  getOne?: unknown;
  getMany?: unknown[];
  execute?: { affected?: number };
}

/**
 * Chainable QB stub. Returns self for every chain method so
 * `.where(...).andWhere(...).limit(...).getMany()` resolves at
 * runtime without strict typing to each verb.
 */
function makeQB(opts: QBOpts = {}): Record<string, AnyFn> {
  const qb: Record<string, AnyFn> = {};
  const chain = [
    'where',
    'andWhere',
    'orWhere',
    'select',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'addGroupBy',
    'limit',
    'offset',
    'take',
    'skip',
    'setLock',
    'setOnLocked',
    'innerJoin',
    'leftJoin',
    'leftJoinAndSelect',
    'update',
    'set',
    'whereInIds',
    'insert',
    'into',
    'values',
  ];
  for (const m of chain) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getOne = jest.fn(async () => opts.getOne ?? null);
  qb.getMany = jest.fn(async () => opts.getMany ?? []);
  qb.execute = jest.fn(async () => opts.execute ?? { affected: 1 });
  return qb;
}

interface RepoMock {
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeRepo(): RepoMock {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
    save: jest.fn(async (x: unknown) => x),
    createQueryBuilder: jest.fn(() => makeQB()),
  };
}

interface Ctx {
  service: TicketLifecycleService;
  ticketRepo: RepoMock;
  userRepo: RepoMock;
  logRepo: RepoMock;
  teamMemberRepo: RepoMock;
  // Exposed so tests that call methods accepting an EntityManager
  // directly (wakeIfPaused, bounceOnEmergency's inner work) can hand
  // in the same mgr the dataSource.transaction stub would.
  mgr: EntityManager;
  // Captures of UPDATE patches so tests can inspect what was written.
  ticketUpdates: Array<Record<string, unknown>>;
  // Activity logs saved during the test (flattened).
  savedLogs: Array<Partial<TicketActivityLog>>;
}

function buildCtx(): Ctx {
  const ticketRepo = makeRepo();
  const userRepo = makeRepo();
  const logRepo = makeRepo();
  const teamMemberRepo = makeRepo();

  const ticketUpdates: Array<Record<string, unknown>> = [];
  const savedLogs: Array<Partial<TicketActivityLog>> = [];

  // Capture the .set() calls inside QB chains so tests can assert
  // "the UPDATE wrote this patch." Overrides the default behaviour
  // of createQueryBuilder with a wrapper that records set() payloads.
  const wrapRepo = (repo: RepoMock): RepoMock => {
    repo.createQueryBuilder = jest.fn((_alias?: string) => {
      const qb = makeQB();
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((patch: Record<string, unknown>) => {
        ticketUpdates.push(patch);
        return (originalSet as jest.Mock)(patch);
      });
      return qb;
    });
    return repo;
  };
  wrapRepo(ticketRepo);
  wrapRepo(userRepo);

  // logRepo.save sometimes receives arrays and sometimes single rows —
  // flatten everything into savedLogs for easy assertion.
  logRepo.save = jest.fn(async (x: unknown) => {
    if (Array.isArray(x)) savedLogs.push(...(x as Partial<TicketActivityLog>[]));
    else savedLogs.push(x as Partial<TicketActivityLog>);
    return x;
  });

  const mgr = {
    getRepository: jest.fn((entity: unknown) => {
      const name = (entity as { name?: string }).name ?? '';
      if (name === 'Ticket') return ticketRepo;
      if (name === 'User') return userRepo;
      if (name === 'TicketActivityLog') return logRepo;
      if (name === 'TeamMember') return teamMemberRepo;
      return makeRepo();
    }),
    // Advisory-lock sweep uses mgr.query(...). Always grant the lock.
    query: jest.fn(async () => [{ locked: true }]),
  } as unknown as EntityManager;

  const dataSource = {
    transaction: jest.fn(async <T,>(cb: (m: EntityManager) => Promise<T>) =>
      cb(mgr),
    ),
  } as unknown as DataSource;

  const service = new TicketLifecycleService(
    ticketRepo as unknown as Repository<Ticket>,
    dataSource,
  );

  return {
    service,
    ticketRepo,
    userRepo,
    logRepo,
    teamMemberRepo,
    mgr,
    ticketUpdates,
    savedLogs,
  };
}

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

const BOT_ID = 'bot-00000000-0000-0000-0000-000000000000';
const USER_ONLINE_ID = 'user-online-id';
const USER_OFFLINE_ID = 'user-offline-id';
const TEAM_ID = 'team-general';

function botUser(): User {
  return {
    id: BOT_ID,
    role: UserRole.BOT,
    status: UserStatus.ONLINE,
    deactivatedAt: null,
    name: 'BOT',
  } as unknown as User;
}

function member(id: string, status: UserStatus, name = 'Alice'): User {
  return {
    id,
    role: UserRole.MEMBER,
    status,
    deactivatedAt: null,
    name,
  } as unknown as User;
}

function ticket(
  overrides: Partial<Ticket> & { id: string } = { id: 't1' },
): Ticket {
  return {
    id: 't1',
    status: TicketStatus.WAITING,
    assignee: USER_ONLINE_ID,
    team_id: TEAM_ID,
    waiting_action: WaitingAction.REOPEN,
    resume_at: new Date(Date.now() - 60_000),
    ...overrides,
  } as unknown as Ticket;
}

/* ------------------------------------------------------------------ */
/* wakeIfPaused                                                       */
/* ------------------------------------------------------------------ */

describe('TicketLifecycleService.wakeIfPaused', () => {
  it('keeps an ONLINE assignee owning the ticket when customer replies', async () => {
    const ctx = buildCtx();
    ctx.ticketRepo.findOne.mockResolvedValue(
      ticket({ id: 't1', status: TicketStatus.WAITING, assignee: USER_ONLINE_ID }),
    );
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_ONLINE_ID, UserStatus.ONLINE),
    );

    await ctx.service.wakeIfPaused('t1', ctx.mgr);

    // Expect ONE UPDATE patch that does NOT touch assignee.
    expect(ctx.ticketUpdates).toHaveLength(1);
    expect(ctx.ticketUpdates[0]).toMatchObject({
      status: TicketStatus.OPEN,
      resume_at: null,
      waiting_action: null,
    });
    expect(ctx.ticketUpdates[0]).not.toHaveProperty('assignee');

    // Single activity log, no fallback-to-BOT entry.
    expect(ctx.savedLogs).toHaveLength(1);
    expect(ctx.savedLogs[0].event).toBe(TicketActivity.SENT_BACK_TO_QUEUE);
  });

  it('[regression #1330] re-queues to BOT when assignee is OFFLINE at wake time', async () => {
    const ctx = buildCtx();
    ctx.ticketRepo.findOne.mockResolvedValue(
      ticket({ id: 't1', status: TicketStatus.WAITING, assignee: USER_OFFLINE_ID }),
    );
    // First userRepo call: load the assignee. Second: load BOT.
    ctx.userRepo.findOne
      .mockResolvedValueOnce(member(USER_OFFLINE_ID, UserStatus.OFFLINE))
      .mockResolvedValueOnce(botUser());

    await ctx.service.wakeIfPaused('t1', ctx.mgr);

    // UPDATE patch must include assignee=BOT (the whole point of the fix).
    expect(ctx.ticketUpdates).toHaveLength(1);
    expect(ctx.ticketUpdates[0]).toMatchObject({
      status: TicketStatus.OPEN,
      assignee: BOT_ID,
    });
    // Activity trail: SENT_BACK_TO_QUEUE + ASSIGNED_TO_BOT (two rows).
    expect(ctx.savedLogs.map((l) => l.event)).toEqual([
      TicketActivity.SENT_BACK_TO_QUEUE,
      TicketActivity.ASSIGNED_TO_BOT,
    ]);
  });

  it('is a no-op when the ticket is no longer WAITING (race-safe)', async () => {
    const ctx = buildCtx();
    ctx.ticketRepo.findOne.mockResolvedValue(
      ticket({ id: 't1', status: TicketStatus.OPEN }),
    );

    await ctx.service.wakeIfPaused('t1', ctx.mgr);

    expect(ctx.ticketUpdates).toHaveLength(0);
    expect(ctx.savedLogs).toHaveLength(0);
  });

  it('skips fallback and warns when BOT user is missing (keeps original)', async () => {
    const ctx = buildCtx();
    ctx.ticketRepo.findOne.mockResolvedValue(
      ticket({ id: 't1', status: TicketStatus.WAITING, assignee: USER_OFFLINE_ID }),
    );
    ctx.userRepo.findOne
      .mockResolvedValueOnce(member(USER_OFFLINE_ID, UserStatus.OFFLINE))
      .mockResolvedValueOnce(null); // BOT missing

    await ctx.service.wakeIfPaused('t1', ctx.mgr);

    // UPDATE still happens (status transition) but WITHOUT assignee=BOT.
    expect(ctx.ticketUpdates).toHaveLength(1);
    expect(ctx.ticketUpdates[0]).not.toHaveProperty('assignee');
    // Only the SENT_BACK_TO_QUEUE log fires, no ASSIGNED_TO_BOT.
    expect(ctx.savedLogs.map((l) => l.event)).toEqual([
      TicketActivity.SENT_BACK_TO_QUEUE,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* sweepTimers — WAITING branch                                       */
/* ------------------------------------------------------------------ */

describe('TicketLifecycleService.sweepTimers — WAITING branch', () => {
  function wireRipe(ctx: Ctx, ripeWaiting: Ticket[], ripeFollowup: Ticket[] = []) {
    // The sweep fetches ripe WAITING then ripe IN_FOLLOWUP via two
    // separate createQueryBuilder calls. Rotate the mock to return
    // each in sequence.
    const originalCQB = ctx.ticketRepo.createQueryBuilder as jest.Mock;
    let call = 0;
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => {
      const idx = call++;
      // Call 0 = ripe WAITING fetch, Call 1 = any UPDATE for
      // toResolve, Call 2 = any UPDATE for toReopenKeep, etc.
      // Only the fetch builders need to return getMany data; UPDATE
      // builders use .execute(). Simpler: return a QB tied to the
      // call index with the right getMany payload.
      if (idx === 0) {
        const qb = makeQB({ getMany: ripeWaiting });
        return qb;
      }
      // IN_FOLLOWUP fetch — second getMany call. We detect it by the
      // next createQB whose chain eventually hits getMany. Easier
      // approach: give every subsequent QB the followup payload (it
      // doesn't matter for UPDATE QBs since they never call getMany).
      const qb = makeQB({ getMany: ripeFollowup });
      // Preserve the ticketUpdates capture that buildCtx installed.
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((patch: Record<string, unknown>) => {
        ctx.ticketUpdates.push(patch);
        return (originalSet as jest.Mock)(patch);
      });
      return qb;
    });
    void originalCQB; // referenced to keep the lint happy
  }

  it('WAITING with waiting_action=AUTO_RESOLVE → status becomes RESOLVED', async () => {
    const ctx = buildCtx();
    const t = ticket({
      id: 't1',
      status: TicketStatus.WAITING,
      waiting_action: WaitingAction.AUTO_RESOLVE,
      assignee: USER_ONLINE_ID,
    });
    wireRipe(ctx, [t]);

    await ctx.service.sweepTimers();

    // Expect at least one UPDATE patch setting status=RESOLVED.
    const resolved = ctx.ticketUpdates.find(
      (u) => u.status === TicketStatus.RESOLVED,
    );
    expect(resolved).toBeDefined();
    expect(ctx.savedLogs.some((l) => l.event === TicketActivity.MARKED_RESOLVED)).toBe(true);
  });

  it('WAITING + REOPEN + ONLINE assignee → keeps assignee', async () => {
    const ctx = buildCtx();
    const t = ticket({
      id: 't1',
      status: TicketStatus.WAITING,
      waiting_action: WaitingAction.REOPEN,
      assignee: USER_ONLINE_ID,
    });
    wireRipe(ctx, [t]);
    ctx.userRepo.find.mockResolvedValue([member(USER_ONLINE_ID, UserStatus.ONLINE)]);

    await ctx.service.sweepTimers();

    // Find the UPDATE patch for the "keep" branch (status=OPEN
    // without an assignee rewrite).
    const keep = ctx.ticketUpdates.find(
      (u) => u.status === TicketStatus.OPEN && !('assignee' in u),
    );
    expect(keep).toBeDefined();
    // No ASSIGNED_TO_BOT in the log.
    expect(ctx.savedLogs.some((l) => l.event === TicketActivity.ASSIGNED_TO_BOT)).toBe(false);
  });

  it('[regression #1438] WAITING + REOPEN + non-ONLINE assignee → re-queues to BOT (no 4h grace)', async () => {
    const ctx = buildCtx();
    const t = ticket({
      id: 't1',
      status: TicketStatus.WAITING,
      waiting_action: WaitingAction.REOPEN,
      assignee: USER_OFFLINE_ID,
    });
    wireRipe(ctx, [t]);
    // Member went OFFLINE 2 minutes ago (would have been within the
    // old 4h grace; must now re-queue immediately under the unified
    // ONLINE-only policy).
    const offline = member(USER_OFFLINE_ID, UserStatus.OFFLINE);
    (offline as { status_changed_at: Date }).status_changed_at = new Date(
      Date.now() - 2 * 60_000,
    );
    ctx.userRepo.find.mockResolvedValue([offline]);
    ctx.userRepo.findOne.mockResolvedValue(botUser());

    await ctx.service.sweepTimers();

    const toBot = ctx.ticketUpdates.find(
      (u) => u.status === TicketStatus.OPEN && u.assignee === BOT_ID,
    );
    expect(toBot).toBeDefined();
    expect(ctx.savedLogs.some((l) => l.event === TicketActivity.ASSIGNED_TO_BOT)).toBe(true);
  });

  it('[regression #1436] processes ripe IN_FOLLOWUP even when NO WAITING is ripe (early-return guard)', async () => {
    const ctx = buildCtx();
    const t = ticket({
      id: 't1',
      status: TicketStatus.IN_FOLLOWUP,
      waiting_action: null as unknown as WaitingAction,
      assignee: USER_OFFLINE_ID,
    });
    wireRipe(ctx, [], [t]);
    ctx.userRepo.find.mockResolvedValue([member(USER_OFFLINE_ID, UserStatus.OFFLINE)]);
    ctx.userRepo.findOne.mockResolvedValue(botUser());

    await ctx.service.sweepTimers();

    // Prior to the fix, an empty WAITING set early-returned, so this
    // UPDATE would never run. Must now re-queue the followup to BOT.
    const toBot = ctx.ticketUpdates.find(
      (u) => u.status === TicketStatus.OPEN && u.assignee === BOT_ID,
    );
    expect(toBot).toBeDefined();
  });

  it('IN_FOLLOWUP ripe + ONLINE assignee → does NOT re-queue (capacity hook owns it)', async () => {
    const ctx = buildCtx();
    const t = ticket({
      id: 't1',
      status: TicketStatus.IN_FOLLOWUP,
      waiting_action: null as unknown as WaitingAction,
      assignee: USER_ONLINE_ID,
    });
    wireRipe(ctx, [], [t]);
    ctx.userRepo.find.mockResolvedValue([member(USER_ONLINE_ID, UserStatus.ONLINE)]);

    await ctx.service.sweepTimers();

    // The followup should be left in place for drainRipeFollowup
    // to handle — no UPDATE from the sweep.
    expect(
      ctx.ticketUpdates.some((u) => u.assignee === BOT_ID),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* drainRipeFollowup / pullFromBotQueue (via onCapacityFreed)          */
/* ------------------------------------------------------------------ */

describe('TicketLifecycleService.onCapacityFreed', () => {
  it('[regression #1357] no-op when user is not ONLINE — does not wake followup onto an offline member', async () => {
    const ctx = buildCtx();
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_OFFLINE_ID, UserStatus.OFFLINE),
    );

    const moved = await ctx.service.onCapacityFreed(USER_OFFLINE_ID);

    expect(moved).toBe(false);
    expect(ctx.ticketUpdates).toHaveLength(0);
    expect(ctx.savedLogs).toHaveLength(0);
  });

  it('wakes a ripe followup onto an ONLINE assignee, keeps ownership', async () => {
    const ctx = buildCtx();
    ctx.userRepo.findOne.mockResolvedValue(
      member(USER_ONLINE_ID, UserStatus.ONLINE),
    );
    // drainRipeFollowup uses .createQueryBuilder — give it a ripe
    // followup ticket to find.
    const ripe = ticket({
      id: 't1',
      status: TicketStatus.IN_FOLLOWUP,
      assignee: USER_ONLINE_ID,
    });
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => {
      const qb = makeQB({ getOne: ripe });
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((patch: Record<string, unknown>) => {
        ctx.ticketUpdates.push(patch);
        return (originalSet as jest.Mock)(patch);
      });
      return qb;
    });

    const moved = await ctx.service.onCapacityFreed(USER_ONLINE_ID);

    expect(moved).toBe(true);
    // drainRipeFollowup uses repo.update() (not QB), so check that.
    expect(ctx.ticketRepo.update).toHaveBeenCalledWith(
      { id: 't1' },
      expect.objectContaining({ status: TicketStatus.OPEN }),
    );
    expect(ctx.savedLogs.some((l) =>
      typeof l.log === 'string' && l.log.includes('Auto-woken from followup'),
    )).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* bounceOnEmergency                                                  */
/* ------------------------------------------------------------------ */

describe('TicketLifecycleService.bounceOnEmergency', () => {
  it('re-queues every OPEN ticket owned by the user to BOT in same team', async () => {
    const ctx = buildCtx();
    const open1 = ticket({
      id: 't1',
      status: TicketStatus.OPEN,
      assignee: USER_ONLINE_ID,
    });
    const open2 = ticket({
      id: 't2',
      status: TicketStatus.OPEN,
      assignee: USER_ONLINE_ID,
    });
    // bounceOnEmergency uses createQueryBuilder → getMany for the
    // OPEN tickets list; followed by findOne for BOT; then an
    // UPDATE via QB; then save() for the activity logs.
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => {
      const qb = makeQB({ getMany: [open1, open2] });
      const originalSet = qb.set as jest.Mock;
      qb.set = jest.fn((patch: Record<string, unknown>) => {
        ctx.ticketUpdates.push(patch);
        return (originalSet as jest.Mock)(patch);
      });
      return qb;
    });
    ctx.userRepo.findOne.mockResolvedValue(botUser());

    await ctx.service.bounceOnEmergency({ userId: USER_ONLINE_ID });

    // One UPDATE patch covering both tickets, setting assignee=BOT.
    const bounce = ctx.ticketUpdates.find((u) => u.assignee === BOT_ID);
    expect(bounce).toBeDefined();
    // Two activity rows (one per ticket).
    const emergencyLogs = ctx.savedLogs.filter(
      (l) => l.event === TicketActivity.ASSIGNED_TO_BOT,
    );
    expect(emergencyLogs).toHaveLength(2);
    expect(
      emergencyLogs.every(
        (l) =>
          typeof l.log === 'string' &&
          l.log.includes('assignee set status to EMERGENCY'),
      ),
    ).toBe(true);
  });

  it('no-op when the user has no OPEN tickets', async () => {
    const ctx = buildCtx();
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => makeQB({ getMany: [] }));

    await ctx.service.bounceOnEmergency({ userId: USER_ONLINE_ID });

    expect(ctx.ticketUpdates).toHaveLength(0);
    expect(ctx.savedLogs).toHaveLength(0);
    // BOT user never looked up either (short-circuited).
    expect(ctx.userRepo.findOne).not.toHaveBeenCalled();
  });

  it('warns and keeps assignees when BOT user is missing', async () => {
    const ctx = buildCtx();
    const open1 = ticket({
      id: 't1',
      status: TicketStatus.OPEN,
      assignee: USER_ONLINE_ID,
    });
    ctx.ticketRepo.createQueryBuilder = jest.fn(() => makeQB({ getMany: [open1] }));
    ctx.userRepo.findOne.mockResolvedValue(null); // BOT missing

    await ctx.service.bounceOnEmergency({ userId: USER_ONLINE_ID });

    // Should not try to UPDATE assignee since there's no BOT to assign to.
    expect(ctx.ticketUpdates).toHaveLength(0);
    expect(ctx.savedLogs).toHaveLength(0);
  });
});
