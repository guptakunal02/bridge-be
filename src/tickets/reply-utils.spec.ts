import { normaliseAddressList, replySubject } from './reply-utils';

describe('replySubject', () => {
  it('falls back to "Support reply" for null / empty / whitespace', () => {
    expect(replySubject(null)).toBe('Support reply');
    expect(replySubject('')).toBe('Support reply');
    expect(replySubject('   \t  ')).toBe('Support reply');
  });

  it('prepends "Re: " to a fresh subject', () => {
    expect(replySubject('Order refund')).toBe('Re: Order refund');
    expect(replySubject('  spaces around  ')).toBe('Re: spaces around');
  });

  it('strips a single Re:/re:/RE: prefix with any spacing', () => {
    expect(replySubject('Re: Order refund')).toBe('Re: Order refund');
    expect(replySubject('RE: Order refund')).toBe('Re: Order refund');
    expect(replySubject('re:Order refund')).toBe('Re: Order refund');
    expect(replySubject('re :Order refund')).toBe('Re: Order refund');
  });

  it('collapses layered Re/Fwd/AW/SV/Rép/Res/Rif chains', () => {
    expect(replySubject('Re: Re: Re: Order refund')).toBe(
      'Re: Order refund',
    );
    expect(replySubject('Fwd: Re: Fw: Order refund')).toBe(
      'Re: Order refund',
    );
    expect(replySubject('AW: SV: Order refund')).toBe('Re: Order refund');
    expect(replySubject('Rép: Res: Rif: Order refund')).toBe(
      'Re: Order refund',
    );
  });

  it('leaves the middle of the subject alone', () => {
    // The regex is anchored — an internal "Re:" is not touched.
    expect(replySubject('Order: Re-shipment status')).toBe(
      'Re: Order: Re-shipment status',
    );
  });

  it('falls back to "Support reply" when stripping empties the subject', () => {
    expect(replySubject('Re:')).toBe('Support reply');
    expect(replySubject('Re: Fwd: ')).toBe('Support reply');
  });
});

describe('normaliseAddressList', () => {
  it('returns [] for undefined / empty', () => {
    expect(normaliseAddressList(undefined, [])).toEqual([]);
    expect(normaliseAddressList([], [])).toEqual([]);
  });

  it('lowercases and trims each address', () => {
    expect(
      normaliseAddressList(['  Foo@Bar.com  ', 'Bar@Baz.COM'], []),
    ).toEqual(['foo@bar.com', 'bar@baz.com']);
  });

  it('drops empty strings after trimming', () => {
    expect(normaliseAddressList(['a@x.com', '', '  ', 'b@x.com'], [])).toEqual(
      ['a@x.com', 'b@x.com'],
    );
  });

  it('dedupes case-insensitively within the input', () => {
    expect(
      normaliseAddressList(['a@x.com', 'A@X.COM', 'a@x.com'], []),
    ).toEqual(['a@x.com']);
  });

  it('excludes anything present in `exclude` (case-insensitively)', () => {
    expect(
      normaliseAddressList(['a@x.com', 'B@X.com'], ['A@x.com']),
    ).toEqual(['b@x.com']);
  });

  it('preserves input order for kept entries', () => {
    expect(
      normaliseAddressList(['c@x.com', 'a@x.com', 'b@x.com'], []),
    ).toEqual(['c@x.com', 'a@x.com', 'b@x.com']);
  });
});
