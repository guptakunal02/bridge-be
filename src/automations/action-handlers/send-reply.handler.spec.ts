import { customerName, expand } from './send-reply-template';

describe('send-reply.customerName', () => {
  it('extracts a capitalised local-part from an email', () => {
    expect(customerName('neeta@yahoo.com')).toBe('Neeta');
    expect(customerName('john.doe@example.com')).toBe('John doe');
  });

  it('strips trailing digits and underscores', () => {
    expect(customerName('neeta_1711@yahoo.com')).toBe('Neeta');
    expect(customerName('user123@acme.co')).toBe('User');
  });

  it('falls back to "there" for whatsapp wa_ids (digits only)', () => {
    expect(customerName('918569993083')).toBe('there');
    expect(customerName('15555551212')).toBe('there');
  });

  it('falls back to "there" for nullish or empty input', () => {
    expect(customerName(null)).toBe('there');
    expect(customerName(undefined)).toBe('there');
    expect(customerName('')).toBe('there');
  });

  it('falls back to "there" when the local-part is all digits', () => {
    // A real case we've seen: autogen'd notification addresses like
    // "123456@notifications.example.com" shouldn't become "123456".
    expect(customerName('1711@yahoo.com')).toBe('there');
  });
});

describe('send-reply.expand', () => {
  it('substitutes known tokens', () => {
    const out = expand('Hi {customerName}, your ticket is #{ticketId}.', {
      customerName: 'Neeta',
      ticketId: '1449',
    });
    expect(out).toBe('Hi Neeta, your ticket is #1449.');
  });

  it('leaves unknown tokens untouched so typos stay visible', () => {
    // Previously we silently dropped unknown tokens — authors with a
    // typo like {custmerName} saw their message go out as "Hi , ..."
    // which looked like a BE bug. Leaving the raw token in the body
    // surfaces the typo at test-send time.
    const out = expand('Hi {custmerName}, #{ticketId}.', {
      customerName: 'Neeta',
      ticketId: '1',
    });
    expect(out).toBe('Hi {custmerName}, #1.');
  });

  it('is a no-op on templates with no tokens', () => {
    expect(expand('No tokens here.', { customerName: 'x' })).toBe(
      'No tokens here.',
    );
  });
});
