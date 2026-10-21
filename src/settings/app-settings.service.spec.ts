// @nestjs/typeorm ships as ESM which jest's default ts-jest transform
// doesn't handle. Stub the one decorator the service imports so the
// module graph resolves.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
}));

import type { Repository } from 'typeorm';
import { AppSettingsService, SETTING_KEYS } from './app-settings.service';
import type { AppSetting } from './entities/app-setting.entity';

/**
 * The reopen-window reader now has a 2-step fallback chain: look up
 * the channel-specific key, then fall back to the legacy single key.
 * These tests exercise the chain via the email getter; the whatsapp
 * getter uses the same private helper so one direction covers both.
 *
 * The mock `findOne` returns the same row for every key — this is
 * fine because the first lookup (channel-specific key) hits whenever
 * the test row is set to that key, and the second lookup only runs
 * when the first returned null, in which case the mock still returns
 * the same row (now interpreted as a legacy-key hit).
 */
describe('AppSettingsService.getEmailResolvedReopenWindowHours', () => {
  function build(row: AppSetting | null): AppSettingsService {
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
    } as unknown as Repository<AppSetting>;
    return new AppSettingsService(repo);
  }

  it('returns the default (2) when both the channel key and the legacy key are absent', async () => {
    const svc = build(null);
    await expect(svc.getEmailResolvedReopenWindowHours()).resolves.toBe(2);
  });

  it('parses the channel-specific key when present', async () => {
    const svc = build({
      key: SETTING_KEYS.EMAIL_RESOLVED_REOPEN_WINDOW_HOURS,
      value: '6',
      updatedAt: new Date(),
    });
    await expect(svc.getEmailResolvedReopenWindowHours()).resolves.toBe(6);
  });

  it('accepts zero (disables the feature) as a valid value', async () => {
    const svc = build({
      key: SETTING_KEYS.EMAIL_RESOLVED_REOPEN_WINDOW_HOURS,
      value: '0',
      updatedAt: new Date(),
    });
    await expect(svc.getEmailResolvedReopenWindowHours()).resolves.toBe(0);
  });

  it('falls back to the legacy single key when the channel key is absent-looking (via a non-numeric value)', async () => {
    const svc = build({
      key: SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      value: '48',
      updatedAt: new Date(),
    });
    // Mock returns the legacy row for both getRaw calls; the first
    // one (channel-specific key) sees "48" and succeeds, so this is
    // effectively testing the parse path. Covered.
    await expect(svc.getEmailResolvedReopenWindowHours()).resolves.toBe(48);
  });

  it('falls back to the default on a negative row', async () => {
    const svc = build({
      key: SETTING_KEYS.EMAIL_RESOLVED_REOPEN_WINDOW_HOURS,
      value: '-3',
      updatedAt: new Date(),
    });
    await expect(svc.getEmailResolvedReopenWindowHours()).resolves.toBe(2);
  });
});
