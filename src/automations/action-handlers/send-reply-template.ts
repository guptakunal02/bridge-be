/**
 * Pure helpers used by SendReplyHandler to turn a template body +
 * event payload into the actual message bytes. Split out so they
 * can be unit-tested without pulling the whole Nest module graph
 * (TicketsService ↔ AutomationsModule) into the test runtime.
 */

/**
 * Derive a human-ish name from the sender string in the event
 * payload. Best-effort — "there" is the honest fallback when the
 * sender doesn't yield a name (WhatsApp wa_ids are digits only).
 */
export function customerName(sender: string | null | undefined): string {
  if (!sender) return 'there';
  // Email path: local part before @. Strip trailing digits /
  // underscores (e.g. "neeta_1711" → "neeta"), replace separators
  // with spaces ("john.doe" → "john doe"), capitalise.
  if (sender.includes('@')) {
    const local = sender.split('@')[0] ?? '';
    const trimmed = local
      .replace(/[_\d-]+$/g, '')
      .replace(/[._-]+/g, ' ')
      .trim();
    if (!trimmed) return 'there';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  // WhatsApp wa_id (digits only) — no name available.
  return 'there';
}

/**
 * Replace {token} occurrences in `template` with values from `vars`.
 * Unknown tokens are left as-is so a typo like {custmerName} is
 * visibly broken instead of silently resolving to empty string.
 */
export function expand(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : v;
  });
}
