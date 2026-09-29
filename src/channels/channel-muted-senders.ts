import { ChannelType } from '../database/enums';

/**
 * Should this inbound sender be silently dropped based on the
 * channel's mute list?
 *
 * Pure function — no I/O, no logging. Callers (currently
 * EmailInboxService.ingestInbound) log the drop separately with
 * whatever contextual fields they have (external_message_id,
 * matched pattern, etc).
 *
 * Matching rules by channel type:
 *   * EMAIL — a pattern containing `@` matches the sender's full
 *     address, case-insensitive. A pattern without `@` is treated
 *     as a domain and matches when the sender's address ends with
 *     `@<pattern>`. Domain match is a strict suffix — `judge.me`
 *     does NOT match `notjudge.me`.
 *   * WHATSAPP / INSTAGRAM — reserved. Current behaviour: never
 *     mutes (rules to be filled in when those channels ingest).
 *
 * Whitespace is trimmed on every pattern before comparison, and
 * empty patterns are ignored, so an accidentally blank chip
 * doesn't silently mute everything.
 */
export function isMutedSender(
  sender: string | null | undefined,
  patterns: string[] | null | undefined,
  channelType: ChannelType,
): boolean {
  if (!sender || !patterns || patterns.length === 0) return false;
  if (channelType !== ChannelType.EMAIL) return false;

  const normalizedSender = sender.trim().toLowerCase();
  if (normalizedSender.length === 0) return false;

  const atIndex = normalizedSender.lastIndexOf('@');
  // Defensive: if a display-name-wrapped address like
  // `"Support <support@judge.me>"` slipped past the DTO, strip the
  // trailing `>` so the domain component still equals cleanly.
  const senderDomain =
    atIndex >= 0
      ? normalizedSender.slice(atIndex + 1).replace(/[>\s]+$/, '')
      : null;

  for (const raw of patterns) {
    const pattern = raw?.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.includes('@')) {
      if (pattern === normalizedSender) return true;
    } else if (senderDomain !== null && senderDomain === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Normalise + dedupe a user-supplied list of patterns before we
 * persist them. Trims, lowercases, drops empties + duplicates,
 * preserves the caller's original order for stable display.
 */
export function normalizeMutedSenders(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const p = raw?.trim().toLowerCase();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
