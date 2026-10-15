import { formatWaId } from './wa-id-format';

describe('formatWaId', () => {
  it('formats Indian 12-digit wa_id as "+91 XXXXX XXXXX"', () => {
    expect(formatWaId('918569993083')).toBe('+91 85699 93083');
  });

  it('is idempotent on an already-formatted Indian number', () => {
    // The DTO layer formats senders at the response boundary; if the
    // same value is passed through twice (adapter → mapper), we must
    // not double-format or add a second "+".
    expect(formatWaId('+91 85699 93083')).toBe('+91 85699 93083');
  });

  it('falls back to "+<digits>" for non-Indian codes', () => {
    // US (country code 1 + 10 digits). We don't India-format this,
    // but we also don't produce something misleading like a "+91"
    // header. "+15558675309" is correct, just not pretty — libphone-
    // number lands here when we need multi-country display.
    expect(formatWaId('15558675309')).toBe('+15558675309');
  });

  it('falls back to "+<digits>" for a UK 11-digit input', () => {
    expect(formatWaId('447911123456')).toBe('+447911123456');
  });

  it('strips non-digit characters before deciding', () => {
    // Defensive — we don't expect webhooks to send dashes, but a
    // manual seed or copy-paste in a test fixture shouldn't trip us.
    expect(formatWaId('91-85699-93083')).toBe('+91 85699 93083');
  });

  it('returns null for null / undefined / empty / all-non-digits', () => {
    expect(formatWaId(null)).toBeNull();
    expect(formatWaId(undefined)).toBeNull();
    expect(formatWaId('')).toBeNull();
    expect(formatWaId('   ')).toBeNull();
    expect(formatWaId('abc')).toBeNull();
  });
});
