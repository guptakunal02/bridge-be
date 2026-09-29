import { ChannelType } from '../database/enums';
import {
  isMutedSender,
  normalizeMutedSenders,
} from './channel-muted-senders';

describe('isMutedSender — EMAIL', () => {
  const EMAIL = ChannelType.EMAIL;

  it('returns false when the mute list is empty', () => {
    expect(isMutedSender('a@b.com', [], EMAIL)).toBe(false);
  });

  it('returns false when the sender is null / undefined / blank', () => {
    expect(isMutedSender(null, ['judge.me'], EMAIL)).toBe(false);
    expect(isMutedSender(undefined, ['judge.me'], EMAIL)).toBe(false);
    expect(isMutedSender('   ', ['judge.me'], EMAIL)).toBe(false);
  });

  it('matches a full address exactly, case-insensitive', () => {
    expect(
      isMutedSender('support@judge.me', ['support@judge.me'], EMAIL),
    ).toBe(true);
    expect(
      isMutedSender('SUPPORT@Judge.Me', ['support@judge.me'], EMAIL),
    ).toBe(true);
  });

  it('does NOT match a different address on the same domain via full-address rule', () => {
    // Pattern is a full address — only exact matches allowed.
    expect(
      isMutedSender('noreply@judge.me', ['support@judge.me'], EMAIL),
    ).toBe(false);
  });

  it('matches every address on a domain when the pattern is bare', () => {
    expect(isMutedSender('support@judge.me', ['judge.me'], EMAIL)).toBe(true);
    expect(isMutedSender('noreply@judge.me', ['judge.me'], EMAIL)).toBe(true);
    expect(isMutedSender('alerts@judge.me', ['judge.me'], EMAIL)).toBe(true);
  });

  it('domain match is a strict suffix — no false positives on look-alikes', () => {
    // `judge.me` should NOT match `notjudge.me` — the whole domain
    // component must equal, not just end with the string.
    expect(isMutedSender('anyone@notjudge.me', ['judge.me'], EMAIL)).toBe(
      false,
    );
  });

  it('trims and lowercases patterns before matching', () => {
    expect(
      isMutedSender('support@judge.me', ['  JUDGE.ME  '], EMAIL),
    ).toBe(true);
  });

  it('ignores blank / empty entries in the mute list', () => {
    expect(
      isMutedSender('support@judge.me', ['', '   ', 'judge.me'], EMAIL),
    ).toBe(true);
    // An accidentally-blank chip must not silently mute everyone.
    expect(isMutedSender('kunal@surma.in', ['', '   '], EMAIL)).toBe(false);
  });

  it('handles addresses with a display-name-style prefix by matching on the raw string', () => {
    // We only receive the canonical email address here (the ingest
    // path parses "From:" into a bare address before calling us).
    // Guardrail: something like "Support <support@judge.me>" that
    // slipped through would hit the domain rule via lastIndexOf('@').
    expect(
      isMutedSender('Support <support@judge.me>', ['judge.me'], EMAIL),
    ).toBe(true);
  });
});

describe('isMutedSender — non-EMAIL channels', () => {
  it('never mutes on WHATSAPP or INSTAGRAM until those rules are defined', () => {
    expect(
      isMutedSender('+911234567890', ['+911234567890'], ChannelType.WHATSAPP),
    ).toBe(false);
    expect(
      isMutedSender('@somehandle', ['@somehandle'], ChannelType.INSTAGRAM),
    ).toBe(false);
  });
});

describe('normalizeMutedSenders', () => {
  it('trims + lowercases every entry', () => {
    expect(normalizeMutedSenders(['  JUDGE.ME  ', 'Foo@Bar.COM'])).toEqual([
      'judge.me',
      'foo@bar.com',
    ]);
  });

  it('drops empty / blank entries', () => {
    expect(normalizeMutedSenders(['', '   ', 'judge.me'])).toEqual(['judge.me']);
  });

  it('dedupes case-insensitively', () => {
    expect(
      normalizeMutedSenders(['judge.me', 'JUDGE.ME', 'Judge.Me']),
    ).toEqual(['judge.me']);
  });

  it('preserves original order (stable display)', () => {
    expect(
      normalizeMutedSenders(['zeta.com', 'alpha.com', 'beta.com']),
    ).toEqual(['zeta.com', 'alpha.com', 'beta.com']);
  });
});
