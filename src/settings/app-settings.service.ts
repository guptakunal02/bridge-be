import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';

/** Canonical setting keys — using constants keeps typos out. */
export const SETTING_KEYS = {
  RESOLVED_REOPEN_WINDOW_HOURS: 'resolved_reopen_window_hours',
  REQUIRE_TAG_TO_RESOLVE: 'require_tag_to_resolve',
} as const;

/** Fallback values used when the row is absent (e.g. brand-new
 * install before the migration seed lands, or a manual delete). */
const DEFAULTS = {
  [SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS]: 2,
  [SETTING_KEYS.REQUIRE_TAG_TO_RESOLVE]: false,
} as const;

/**
 * Typed wrapper around the `app_setting` key/value table. Callers
 * think in terms of named getters (`getResolvedReopenWindowHours`)
 * rather than raw string keys, so the storage shape can evolve
 * without touching every use-site.
 */
@Injectable()
export class AppSettingsService {
  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
  ) {}

  async getResolvedReopenWindowHours(): Promise<number> {
    const raw = await this.getRaw(SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS);
    if (raw === null) return DEFAULTS[SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS];
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULTS[SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS];
  }

  async setResolvedReopenWindowHours(hours: number): Promise<void> {
    await this.setRaw(
      SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      String(hours),
    );
  }

  /**
   * Admin toggle: when true, a ticket cannot transition into a
   * "closed" state without at least one tag on it. Enforced at
   * two transitions in tickets.service:
   *   * status → RESOLVED (manual close)
   *   * status → WAITING with waitingAction = AUTO_RESOLVE
   *     (deferred close — the tag can't be added later by the
   *     sweep, so we require it up front)
   * Not enforced on other transitions since the ticket comes back
   * to the member and they can still tag before closing.
   */
  async getRequireTagToResolve(): Promise<boolean> {
    const raw = await this.getRaw(SETTING_KEYS.REQUIRE_TAG_TO_RESOLVE);
    if (raw === null) return DEFAULTS[SETTING_KEYS.REQUIRE_TAG_TO_RESOLVE];
    return raw === 'true';
  }

  async setRequireTagToResolve(v: boolean): Promise<void> {
    await this.setRaw(
      SETTING_KEYS.REQUIRE_TAG_TO_RESOLVE,
      v ? 'true' : 'false',
    );
  }

  private async getRaw(key: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { key } });
    return row?.value ?? null;
  }

  /**
   * INSERT ... ON CONFLICT so callers don't have to check-then-write.
   * `updatedAt` is included in the overwrite set with an explicit
   * `NOW()` because raw QueryBuilder inserts bypass TypeORM's
   * lifecycle hooks — @UpdateDateColumn wouldn't fire on the
   * conflict path otherwise, leaving the timestamp stuck at the
   * original insert time.
   */
  private async setRaw(key: string, value: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(AppSetting)
      .values({ key, value, updatedAt: () => 'NOW()' })
      .orUpdate(['value', 'updatedAt'], ['key'])
      .execute();
  }
}
