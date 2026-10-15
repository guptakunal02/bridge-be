/**
 * Pretty-formats a WhatsApp wa_id (country code + national number,
 * digits-only — the shape Meta hands us in webhooks) for human
 * display in the inbox + ticket detail.
 *
 * Our customer base is India-first, so we hand-grouping 91 + 10
 * digits ("+91 85699 93083"). Any other country code falls back to
 * "+<digits>" with no grouping — correct, just not pretty. When we
 * genuinely need international formatting across many countries,
 * drop in libphonenumber-js here; the entry point stays the same.
 *
 * Empty / null in → null out so callers can pipe through the
 * "unknown sender" fallback branch unchanged.
 */
export function formatWaId(waId: string | null | undefined): string | null {
  if (!waId) return null;
  const digits = waId.replace(/\D/g, '');
  if (digits.length === 0) return null;
  // India (country code 91) + 10-digit mobile → "+91 XXXXX XXXXX"
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}
