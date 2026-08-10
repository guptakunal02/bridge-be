import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TOKEN_BYTES = 48;

export function generateOpaqueToken(
  byteLength: number = DEFAULT_TOKEN_BYTES,
): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
