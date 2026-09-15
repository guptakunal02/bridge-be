import { getCustomerType } from './get-customer-type';
import type { BotFunction } from './types';

/**
 * Every function the bot builder can offer. Adding a new one is a
 * two-step change: implement the handler file, then append it here.
 * Discovery at boot; nothing runtime-configurable.
 */
export const FUNCTIONS: readonly BotFunction[] = [getCustomerType];

const BY_KEY = new Map(FUNCTIONS.map((f) => [f.key, f]));

export function findFunction(key: string): BotFunction | undefined {
  return BY_KEY.get(key);
}
