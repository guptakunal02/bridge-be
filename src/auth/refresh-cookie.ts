import type { CookieOptions, Response } from 'express';
import { NodeEnv } from '../config/env.validation';

export const REFRESH_COOKIE_NAME = 'bridge_refresh';
const REFRESH_COOKIE_PATH = '/auth';

export function buildRefreshCookieOptions(
  nodeEnv: NodeEnv,
  expiresAt: Date,
): CookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === NodeEnv.Production,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  };
}

export function setRefreshCookie(
  res: Response,
  nodeEnv: NodeEnv,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(
    REFRESH_COOKIE_NAME,
    token,
    buildRefreshCookieOptions(nodeEnv, expiresAt),
  );
}

export function clearRefreshCookie(res: Response, nodeEnv: NodeEnv): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: nodeEnv === NodeEnv.Production,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  });
}
