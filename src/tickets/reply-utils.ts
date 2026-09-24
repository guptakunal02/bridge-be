/**
 * Pure helpers used by TicketsService.reply. Extracted so unit
 * tests can exercise the tricky bits (subject-prefix stripping,
 * recipient dedupe) without spinning up the DI container.
 */

/**
 * Known reply/forward prefixes across English + common European
 * variants. Extend cautiously — anything added here strips from
 * user-facing subjects, so a false positive would silently mangle
 * legit content.
 */
const SUBJECT_PREFIX_RE =
  /^\s*(re|fwd?|fw|aw|sv|vs|rv|rép|res|rif)\s*:\s*/i;

/**
 * Build the outbound Subject: strip any known reply/forward prefix
 * (iteratively — "Re: Fwd: Re: X" collapses to "Re: X") and prepend
 * a single "Re: ". Empty/null falls back to a neutral "Support
 * reply" so a stripped-to-empty subject doesn't hit strict MTAs.
 */
export function replySubject(original: string | null): string {
  const trimmed = (original ?? '').trim();
  if (!trimmed) return 'Support reply';
  let stripped = trimmed;
  while (SUBJECT_PREFIX_RE.test(stripped)) {
    stripped = stripped.replace(SUBJECT_PREFIX_RE, '');
  }
  const body = stripped.trim();
  return body ? `Re: ${body}` : 'Support reply';
}

/**
 * Normalise a raw CC / BCC list from the FE:
 *   - lowercase + trim each address
 *   - drop empty strings
 *   - drop anything already in `exclude` (used to keep CC / BCC
 *     from redundantly re-including the primary To recipient, or
 *     BCC from duplicating CC).
 * Order preserved so admins see their intent reflected in the
 * activity log.
 */
export function normaliseAddressList(
  raw: string[] | undefined,
  exclude: string[],
): string[] {
  if (!raw || raw.length === 0) return [];
  const excludeLower = new Set(exclude.map((e) => e.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const addr = entry.trim().toLowerCase();
    if (!addr) continue;
    if (excludeLower.has(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}
