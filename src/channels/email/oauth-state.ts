import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * OAuth state serialisation. We can't rely on cookies or headers
 * surviving the Google redirect back to our callback, so state
 * has to encode everything we need to identify the request AND
 * defend against CSRF.
 *
 * Wire shape: `<base64url payload>.<base64url hmac>`
 *   payload = { channelId, userId, nonce, iat }
 *   hmac    = HMAC-SHA256 of payload using JWT_ACCESS_SECRET
 *
 * We hand-roll instead of using jsonwebtoken because JWTs would
 * add ~400 bytes of header + alg gymnastics the query string
 * doesn't need. HMAC + base64url is 200 bytes total.
 */
export interface OAuthStatePayload {
  channelId: string;
  userId: string;
  nonce: string;
  iat: number;
}

const MAX_AGE_MS = 10 * 60 * 1000;

export function encodeOAuthState(
  input: Omit<OAuthStatePayload, 'nonce' | 'iat'>,
  secret: string,
): string {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(12).toString('base64url'),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function decodeOAuthState(
  raw: string,
  secret: string,
): OAuthStatePayload {
  const [body, sig] = raw.split('.');
  if (!body || !sig) {
    throw new Error('Malformed OAuth state.');
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const provided = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (
    provided.length !== wanted.length ||
    !timingSafeEqual(provided, wanted)
  ) {
    throw new Error('OAuth state signature failed verification.');
  }
  const payload = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  ) as OAuthStatePayload;
  if (
    typeof payload.channelId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.iat !== 'number'
  ) {
    throw new Error('OAuth state has an unexpected shape.');
  }
  if (Date.now() - payload.iat > MAX_AGE_MS) {
    throw new Error('OAuth state has expired.');
  }
  return payload;
}
