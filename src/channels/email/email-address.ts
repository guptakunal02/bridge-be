/**
 * Normalise an email address for use as a stable contact identifier.
 * Rules (pragmatic — matches how mail providers actually work in 2020s):
 *   - Trim surrounding whitespace.
 *   - Lowercase the whole address. RFC 5321 says local-parts MAY be
 *     case-sensitive, but every major provider (Gmail, Outlook, Yahoo,
 *     Apple, Fastmail, Proton, and every hosted business inbox) treats
 *     them case-insensitively at delivery time. Case-preserving providers
 *     are effectively extinct.
 *
 * We intentionally do NOT strip "+tag" suffixes — a customer who emails
 * from support+tickets@ their own address expects to be a distinct thread.
 */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}
