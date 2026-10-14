jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
}));

import type { Repository } from 'typeorm';
import { UserStatus } from '../database/enums';
import { AssignmentPickerService } from './assignment-picker.service';
import type { User } from './entities/user.entity';

/**
 * Covers the round-robin + capacity + team-pause + BOT-fallback
 * decision tree in pickNextAssigneeForTeam. The service is a single
 * public method so one describe is fine.
 *
 * Mocking strategy: the repo exposes `manager.query` (raw SQL for the
 * team-pause check + BOT lookup) and `createQueryBuilder` (the
 * capacity-aware candidate pick). We stub those directly — no DI
 * container, no in-memory DB.
 */

type AnyFn = (...args: unknown[]) => unknown;

function makeQB(candidate: User | null): Record<string, AnyFn> {
  const qb: Record<string, AnyFn> = {};
  const chain = [
    'where',
    'andWhere',
    'select',
    'orderBy',
    'addOrderBy',
    'limit',
    'innerJoin',
    'setParameter',
    'setParameters',
  ];
  for (const m of chain) qb[m] = jest.fn(() => qb);
  qb.getOne = jest.fn(async () => candidate);
  return qb;
}

interface Ctx {
  service: AssignmentPickerService;
  repo: Pick<Repository<User>, 'manager' | 'createQueryBuilder' | 'update'>;
  queryCalls: Array<{ sql: string; params: unknown[] }>;
  updateCalls: Array<{ criteria: unknown; patch: unknown }>;
}

function buildCtx(opts: {
  teamPaused: boolean;
  candidate: User | null;
  // The second manager.query call is for the BOT lookup — returns
  // zero rows (no BOT) or one row with { id, paused }.
  bot: { id: string; paused: boolean | null } | null;
}): Ctx {
  const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
  const updateCalls: Array<{ criteria: unknown; patch: unknown }> = [];

  // manager.query is called twice at most — once for team pause,
  // once for BOT lookup. Return the right payload for each call.
  let queryCall = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    queryCalls.push({ sql, params });
    const idx = queryCall++;
    if (idx === 0) {
      // Team-pause check: SELECT assignment_paused AS paused FROM team.
      return [{ paused: opts.teamPaused }];
    }
    // BOT lookup.
    return opts.bot ? [opts.bot] : [];
  });

  const repo = {
    manager: { query } as unknown as Repository<User>['manager'],
    createQueryBuilder: jest.fn(() => makeQB(opts.candidate)) as unknown as Repository<User>['createQueryBuilder'],
    update: jest.fn(async (criteria: unknown, patch: unknown) => {
      updateCalls.push({ criteria, patch });
      return { affected: 1 };
    }) as unknown as Repository<User>['update'],
  };

  const service = new AssignmentPickerService(
    repo as unknown as Repository<User>,
  );
  return { service, repo, queryCalls, updateCalls };
}

function liveMember(id: string): User {
  return {
    id,
    status: UserStatus.ONLINE,
    name: 'Alice',
  } as unknown as User;
}

describe('AssignmentPickerService.pickNextAssigneeForTeam', () => {
  it('returns BOT id when team is paused — skips candidate lookup entirely', async () => {
    const ctx = buildCtx({
      teamPaused: true,
      candidate: null,
      bot: { id: 'bot-id', paused: false },
    });

    const picked = await ctx.service.pickNextAssigneeForTeam('team-x');

    expect(picked).toBe('bot-id');
    // No candidate QB fetch (team-paused short-circuits).
    expect(ctx.repo.createQueryBuilder).not.toHaveBeenCalled();
    // No last_assigned_at update either.
    expect(ctx.updateCalls).toHaveLength(0);
  });

  it('picks the eligible candidate when one exists and stamps last_assigned_at', async () => {
    const alice = liveMember('alice');
    const ctx = buildCtx({
      teamPaused: false,
      candidate: alice,
      bot: { id: 'bot-id', paused: false },
    });

    const picked = await ctx.service.pickNextAssigneeForTeam('team-x');

    expect(picked).toBe('alice');
    // last_assigned_at bumped so the next pick skips her first.
    expect(ctx.updateCalls).toHaveLength(1);
    expect(ctx.updateCalls[0].criteria).toEqual({ id: 'alice' });
    expect(ctx.updateCalls[0].patch).toMatchObject({
      last_assigned_at: expect.any(Date),
    });
  });

  it('falls back to BOT when no eligible candidate (none online or all at cap)', async () => {
    const ctx = buildCtx({
      teamPaused: false,
      candidate: null, // picker's capacity+ONLINE query returned nothing
      bot: { id: 'bot-id', paused: false },
    });

    const picked = await ctx.service.pickNextAssigneeForTeam('team-x');

    expect(picked).toBe('bot-id');
    // No candidate was found → no last_assigned_at bump.
    expect(ctx.updateCalls).toHaveLength(0);
  });

  it('throws when BOT user is not seeded (deployment misconfiguration)', async () => {
    const ctx = buildCtx({
      teamPaused: false,
      candidate: null,
      bot: null,
    });

    await expect(
      ctx.service.pickNextAssigneeForTeam('team-x'),
    ).rejects.toThrow(/BOT user is not seeded/);
  });

  it('throws when BOT is paused in the target team (surfaces to IMAP retry)', async () => {
    const ctx = buildCtx({
      teamPaused: false,
      candidate: null,
      bot: { id: 'bot-id', paused: true },
    });

    await expect(
      ctx.service.pickNextAssigneeForTeam('team-x'),
    ).rejects.toThrow(/BOT is paused on this team/);
  });

  it('still falls through to the BOT fallback when team is NOT paused but no human is available', async () => {
    const ctx = buildCtx({
      teamPaused: false,
      candidate: null,
      bot: { id: 'bot-id', paused: false },
    });

    const picked = await ctx.service.pickNextAssigneeForTeam('team-x');

    // Two manager.query calls happened: one for team pause, one for
    // BOT. This verifies the candidate QB was tried AND the fallback
    // path was reached.
    expect(ctx.queryCalls).toHaveLength(2);
    expect(ctx.repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(picked).toBe('bot-id');
  });
});
