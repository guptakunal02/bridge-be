import type { EntityManager, Repository } from 'typeorm';
import { UserRole, UserStatus } from '../database/enums';
import { User } from './entities/user.entity';

/**
 * Shared helpers for user-presence and BOT-user access patterns that
 * showed up in half a dozen places (reopen fallbacks, capacity picker,
 * automation actors, email-ingest routing). Keeping them here means
 * one source of truth for "what counts as assignable" and "how do we
 * look up BOT" — change the policy once, every caller gets it.
 *
 * Both are pure: no DI, no decorators, no module registration. Pass
 * the User object (for `isAssignable`) or a repo / EntityManager (for
 * `loadBot`). Callers decide which to hand in.
 */

/**
 * The single ONLINE-only policy. A user is assignable if and only
 * if: they exist, they're not deactivated, and their current status
 * is ONLINE. Any non-ONLINE state (MEETING / BREAK / EMERGENCY /
 * OFFLINE) → not assignable; the ticket should re-queue to BOT.
 *
 * BOT users deliberately return `false` — the BOT isn't a human
 * recipient, so an "assignable to BOT" question doesn't make sense;
 * all callers that need "park on BOT" ignore this predicate and
 * reach for `loadBot()` directly.
 *
 * See memory/feedback-auto-reopen-fallback.md for the invariant.
 */
export function isAssignable(
  user: User | null | undefined,
): user is User {
  if (!user) return false;
  if (user.role === UserRole.BOT) return false;
  if (user.deactivatedAt) return false;
  return user.status === UserStatus.ONLINE;
}

/**
 * Fetch the BOT user. Accepts either a `Repository<User>` (for
 * services that already injected the repo) or an `EntityManager`
 * (for callers running inside a transaction who want the write to
 * see the row from the same connection).
 *
 * Returns `null` when BOT isn't seeded — callers log + bail rather
 * than throwing, so a mis-seeded prod environment doesn't crash
 * every reopen / wake / routing event.
 */
export function loadBot(
  repoOrMgr: Repository<User> | EntityManager,
): Promise<User | null> {
  const repo: Repository<User> =
    'getRepository' in repoOrMgr
      ? repoOrMgr.getRepository(User)
      : repoOrMgr;
  return repo.findOne({ where: { role: UserRole.BOT } });
}
