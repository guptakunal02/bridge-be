// @nestjs/typeorm ships as ESM which jest's default ts-jest transform
// doesn't handle. Stub the one decorator the service imports so the
// module graph resolves.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (): void => {},
}));

import type { Repository } from 'typeorm';
import { AppSettingsService, SETTING_KEYS } from './app-settings.service';
import type { AppSetting } from './entities/app-setting.entity';

describe('AppSettingsService.getResolvedReopenWindowHours', () => {
  function build(row: AppSetting | null): AppSettingsService {
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
    } as unknown as Repository<AppSetting>;
    return new AppSettingsService(repo);
  }

  it('returns the default (2) when the row is absent', async () => {
    const svc = build(null);
    await expect(svc.getResolvedReopenWindowHours()).resolves.toBe(2);
  });

  it('parses a valid stored integer', async () => {
    const svc = build({
      key: SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      value: '6',
      updatedAt: new Date(),
    });
    await expect(svc.getResolvedReopenWindowHours()).resolves.toBe(6);
  });

  it('accepts zero (disables the feature) as a valid value', async () => {
    const svc = build({
      key: SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      value: '0',
      updatedAt: new Date(),
    });
    await expect(svc.getResolvedReopenWindowHours()).resolves.toBe(0);
  });

  it('falls back to the default on a non-numeric row', async () => {
    const svc = build({
      key: SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      value: 'not-a-number',
      updatedAt: new Date(),
    });
    await expect(svc.getResolvedReopenWindowHours()).resolves.toBe(2);
  });

  it('falls back to the default on a negative row', async () => {
    const svc = build({
      key: SETTING_KEYS.RESOLVED_REOPEN_WINDOW_HOURS,
      value: '-3',
      updatedAt: new Date(),
    });
    await expect(svc.getResolvedReopenWindowHours()).resolves.toBe(2);
  });
});
