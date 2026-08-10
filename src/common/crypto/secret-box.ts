import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12; // GCM recommended IV length
const TAG_LEN = 16;

/**
 * Symmetric encryption for at-rest secrets (channel credentials etc.).
 * Format: base64( iv[12] || tag[16] || ciphertext ).
 *
 * The key is passed in (not read from env here) so this module stays
 * dependency-free and testable. Callers hold a decoded 32-byte Buffer.
 */
export function encrypt(key: Buffer, plaintext: string): string {
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(key: Buffer, envelope: string): string {
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`);
  }
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext envelope too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf8',
  );
}

export function decodeKey(base64Key: string): Buffer {
  const buf = Buffer.from(base64Key, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `CHANNEL_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}
