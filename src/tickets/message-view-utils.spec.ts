import {
  normaliseSubject,
  parseQuotedThread,
  shouldShowSubjectHeader,
  splitBody,
} from './message-view-utils';

describe('normaliseSubject', () => {
  it('lowercases and trims', () => {
    expect(normaliseSubject('  Order Refund  ')).toBe('order refund');
  });
  it('strips layered Re/Fwd/AW/SV/Rép chains', () => {
    expect(normaliseSubject('Re: Re: Order refund')).toBe('order refund');
    expect(normaliseSubject('Fwd: AW: Re: Order refund')).toBe(
      'order refund',
    );
    expect(normaliseSubject('Rép: Res: Order refund')).toBe('order refund');
  });
  it('returns empty for null / empty', () => {
    expect(normaliseSubject(null)).toBe('');
    expect(normaliseSubject('')).toBe('');
    expect(normaliseSubject('   ')).toBe('');
  });
});

describe('shouldShowSubjectHeader', () => {
  it('hides when message subject matches the ticket subject exactly', () => {
    expect(shouldShowSubjectHeader('Order refund', 'Order refund')).toBe(
      false,
    );
  });
  it('hides when message subject is a Re: of the ticket subject', () => {
    expect(shouldShowSubjectHeader('Re: Order refund', 'Order refund')).toBe(
      false,
    );
    expect(
      shouldShowSubjectHeader('Re: Re: Order refund', 'Order refund'),
    ).toBe(false);
  });
  it('shows when the subject was actually renamed mid-thread', () => {
    expect(
      shouldShowSubjectHeader('URGENT: Refund now', 'Order refund'),
    ).toBe(true);
  });
  it('hides when the message has no subject', () => {
    expect(shouldShowSubjectHeader(null, 'Order refund')).toBe(false);
    expect(shouldShowSubjectHeader('', 'Order refund')).toBe(false);
  });
  it('shows when the ticket subject itself is missing (data anomaly)', () => {
    expect(shouldShowSubjectHeader('Order refund', null)).toBe(true);
  });
});

describe('splitBody — heuristic strategies', () => {
  it('splits on "On <date> wrote:" preamble', () => {
    const text =
      'Thanks for your reply.\n\nOn Sep 26, 2026, at 5:34 PM, sender@x.com wrote:\n> original stuff';
    const out = splitBody(text, null, []);
    expect(out.newContent).toBe('Thanks for your reply.');
    expect(out.quotedContent).toContain('On Sep 26');
  });

  it('splits on "> " line prefix', () => {
    const text = 'Fresh reply.\n\n> quoted original line';
    const out = splitBody(text, null, []);
    expect(out.newContent).toBe('Fresh reply.');
    expect(out.quotedContent).toContain('> quoted');
  });

  it('splits on Outlook "-----Original Message-----"', () => {
    const text =
      'Fresh reply text.\n\n-----Original Message-----\nFrom: someone';
    const out = splitBody(text, null, []);
    expect(out.newContent).toBe('Fresh reply text.');
    expect(out.quotedContent).toContain('-----Original Message-----');
  });

  it('leaves everything as new when no marker is present', () => {
    const text = 'Just a fresh message with nothing quoted.';
    const out = splitBody(text, null, []);
    expect(out.newContent).toBe(text);
    expect(out.quotedContent).toBeNull();
  });
});

describe('splitBody — prior-content fallback', () => {
  it('splits when the entire prior body appears verbatim as a prefix', () => {
    const priorBody =
      'Hi, I purchased a Kurta Set in size S but the size was much larger than expected. Please check my exchange status and expedite the process. Thank you!';
    const text = `Re: [subject]\n\n${priorBody}\n\nThank you for your response. I understand. Please let me know when it will arrive.`;
    const out = splitBody(text, null, [priorBody]);
    expect(out.newContent).toBe(
      'Thank you for your response. I understand. Please let me know when it will arrive.',
    );
    expect(out.quotedContent).toContain(priorBody);
  });

  it('skips the fallback when the prior body is too short', () => {
    const priorBody = 'Short reply.';
    const text = `Short reply.\n\nMy new content here.`;
    const out = splitBody(text, null, [priorBody]);
    // Prior is <40 chars — fallback rejects. Whole thing is "new".
    expect(out.newContent).toBe(text);
    expect(out.quotedContent).toBeNull();
  });

  it('picks the longest matching prior body when several qualify', () => {
    const priorShort =
      'Hello, I have a question about my order please respond quickly thanks a lot.';
    const priorLong =
      'Hello, I have a question about my order please respond quickly thanks a lot. Also I would like to know when my package will arrive because I am leaving town on Friday and would like it before then.';
    const text = `${priorLong}\n\nHere is my new reply, thanks for handling it so quickly!`;
    const out = splitBody(text, null, [priorShort, priorLong]);
    expect(out.quotedContent).toContain(priorLong);
    expect(out.newContent).toBe(
      'Here is my new reply, thanks for handling it so quickly!',
    );
  });

  it('rejects the split when new content is longer than quoted (avoids bottom-quoted mis-classification)', () => {
    const priorBody =
      'Hi, one line customer message that meets forty character length.';
    const bigNewReply =
      'This is my very extensive reply that goes on for quite a while and describes multiple aspects of the situation in great detail. It has many sentences and covers a lot of ground. The customer would want a thorough response.';
    const text = `${bigNewReply}\n\n${priorBody}`;
    const out = splitBody(text, null, [priorBody]);
    // New longer than quoted → fallback rejects, everything stays "new".
    expect(out.newContent).toBe(text);
    expect(out.quotedContent).toBeNull();
  });

  it('defers to the heuristic marker if one is present (never reaches prior-content path)', () => {
    const priorBody =
      'Hi, I have a question, please help. This body is long enough.';
    const text = `Fresh reply.\n\nOn Sep 26, 2026, at 5:34 PM, x@y.com wrote:\n${priorBody}`;
    const out = splitBody(text, null, [priorBody]);
    expect(out.newContent).toBe('Fresh reply.');
    // Heuristic wins — the preamble marker is present.
    expect(out.quotedContent).toContain('On Sep 26');
  });
});

describe('splitBody — HTML', () => {
  it('splits on Gmail gmail_quote div', () => {
    const html = '<p>hi there</p><div class="gmail_quote">old stuff</div>';
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toBe('<p>hi there</p>');
    expect(out.quotedContentHtml).toContain('gmail_quote');
  });

  it('leaves HTML alone with no marker', () => {
    const html = '<p>just my message</p>';
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toBe('<p>just my message</p>');
    expect(out.quotedContentHtml).toBeNull();
  });

  it('splits at the Apple/iPhone Mail "On <date> wrote:" preamble div', () => {
    const priorBody =
      'Hi Anjali, we have reverted to your previous email. Regards, Nausheen';
    const html = [
      '<div>Could you please give me an update on my exchange order?</div>',
      '<div><br></div>',
      '<div>On Sat, 26 Sep 2026 at 1:46 PM, Surma &lt;team@x.com&gt; wrote:</div>',
      `<blockquote>${priorBody}</blockquote>`,
    ].join('');
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Could you please give me an update');
    expect(out.newContentHtml).not.toContain('On Sat');
    expect(out.quotedContentHtml).toContain('On Sat');
    expect(out.quotedContentHtml).toContain(priorBody);
  });

  it('splits short-new + long-blockquote (the #556 case)', () => {
    // Reply body: ~200 chars of new content followed by 3000+ chars
    // of quoted history in a blockquote. Old 20%-position guard
    // would have rejected because blockquote sits at ~6% of the doc.
    const newContent =
      '<div>Could you please give me an update on my exchange order, order number 230050? It has reached Shimla today.</div>';
    const longQuoted = '<blockquote>' + 'a'.repeat(3000) + '</blockquote>';
    const html = newContent + longQuoted;
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toBe(newContent);
    expect(out.quotedContentHtml).toContain('<blockquote>');
    expect(out.quotedContentHtml?.length).toBeGreaterThan(2000);
  });

  it('still ignores a tiny intro blockquote (pull-quote pattern)', () => {
    // A user opens their reply with a short pull-quote at the top.
    // We should NOT treat that as the quoted-history boundary —
    // the blockquote is small AND at the very start.
    const html =
      '<blockquote>brief pull quote</blockquote><p>Here is my long thoughtful reply that continues on and provides substantial context and value to the reader.</p>';
    const out = splitBody('', html, []);
    expect(out.quotedContentHtml).toBeNull();
    expect(out.newContentHtml).toBe(html);
  });
});

describe('parseQuotedThread', () => {
  it('splits multiple "On <date> wrote:" blocks', () => {
    const quoted = [
      'On Wed, Sep 21, 2026 at 6:17PM Kunal <k@x.com> wrote:',
      '> hello',
      '> ',
      'On Tue, Sep 20, 2026 at 3:14PM Alice <a@x.com> wrote:',
      '> earlier hello',
    ].join('\n');
    const out = parseQuotedThread(quoted);
    expect(out).toHaveLength(2);
    expect(out[0]?.sender).toContain('Kunal');
    expect(out[0]?.body).toBe('hello');
    expect(out[1]?.sender).toContain('Alice');
    expect(out[1]?.body).toBe('earlier hello');
  });

  it('returns [] when no preamble is present', () => {
    expect(parseQuotedThread('just plain text with no wrote line')).toEqual(
      [],
    );
  });
});
