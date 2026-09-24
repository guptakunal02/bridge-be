import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';

/** Canonical setting keys — using constants keeps typos out. */
export const SETTING_KEYS = {
  RESOLVED_REOPEN_WINDOW_HOURS: 'resolved_reopen_window_hours',
} as const;

/** Fallback values used when the row is absent (e.g. brand-new
 * install before the migration seed lands, or a manual delete). */
const DEFAULTS = {
  [SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS]: 2,
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
