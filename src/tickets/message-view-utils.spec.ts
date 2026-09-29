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
  it('collapses whitespace runs (Gmail rewrites double spaces on reply)', () => {
    // iPhone Mail preserves "same day.  Original" (2 spaces); Gmail
    // collapses to "same day. Original" (1 space) on reply. Both
    // must normalise to the same string so the reply's subject
    // doesn't get flagged as a mid-thread rename.
    expect(normaliseSubject('Hi, same day.  Original order')).toBe(
      normaliseSubject('Re: Hi, same day. Original order'),
    );
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
  it('hides even when Gmail collapsed double-spaces on reply (ticket #556)', () => {
    // Real-world capture: customer put their entire complaint into
    // the Subject field from iPhone Mail (which preserved the
    // double-space typo). Gmail collapsed it on the reply Re: line.
    const ticketSubject =
      'Hi, I purchased a Kurta Set, exchange request on the same day.  Original Order Number: 218780. Please look into this and let me know. Thank you!';
    const replySubject =
      'Re: Hi, I purchased a Kurta Set, exchange request on the same day. Original Order Number: 218780. Please look into this and let me know. Thank you!';
    expect(shouldShowSubjectHeader(replySubject, ticketSubject)).toBe(false);
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
    expect(out.newContentHtml).toContain('hi there');
    expect(out.newContentHtml).not.toContain('gmail_quote');
    expect(out.quotedContentHtml).toContain('gmail_quote');
  });

  it('splits on gmail_quote_container (real ticket #556 case)', () => {
    // The actual HTML shape Gmail produces on a reply. Fresh content
    // sits in nested `<div style="font-size:inherit">` before the
    // gmail_quote_container div. Real-world capture — do not modify
    // without keeping the shape recognizable.
    const html = [
      '<div><div style="font-size:inherit"><div style="font-size:inherit">',
      '<p dir="auto">Thank you for your response. I understand.</p>',
      '</div></div><br></div>',
      '<div><br>',
      '<div class="gmail_quote gmail_quote_container">',
      '<div dir="ltr" class="gmail_attr">On Sat, 26 Sep 2026, Surma wrote:<br></div>',
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">',
      '<p>Hi Anjali, we have reverted to your previous email. Regards, Nausheen</p>',
      '</blockquote>',
      '</div></div>',
    ].join('');
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Thank you for your response');
    expect(out.newContentHtml).not.toContain('gmail_quote');
    expect(out.newContentHtml).not.toContain('Hi Anjali');
    expect(out.quotedContentHtml).toContain('gmail_quote_container');
    expect(out.quotedContentHtml).toContain('Hi Anjali');
  });

  it('splits on Apple Mail blockquote type="cite"', () => {
    const html = [
      '<div>Sure, will do.</div>',
      '<br>',
      '<blockquote type="cite">',
      '<div>On Sep 26, 2026, at 5:34 PM, x@y.com wrote:</div>',
      '<div>Original message here.</div>',
      '</blockquote>',
    ].join('');
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Sure, will do');
    expect(out.newContentHtml).not.toContain('blockquote');
    expect(out.quotedContentHtml).toContain('type="cite"');
  });

  it('splits on Outlook OutlookMessageHeader', () => {
    const html = [
      '<p>Thanks for the update.</p>',
      '<div class="OutlookMessageHeader">',
      '<b>From:</b> Someone<br>',
      '<b>Sent:</b> Monday...<br>',
      '</div>',
      '<p>Original outlook message.</p>',
    ].join('');
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Thanks for the update');
    expect(out.newContentHtml).not.toContain('OutlookMessageHeader');
    expect(out.quotedContentHtml).toContain('OutlookMessageHeader');
    expect(out.quotedContentHtml).toContain('Original outlook message');
  });

  it('splits on Yahoo yahoo_quoted', () => {
    const html = [
      '<div>Got it, thanks!</div>',
      '<div class="yahoo_quoted">',
      '<div>On Monday, someone wrote:</div>',
      '<blockquote>original</blockquote>',
      '</div>',
    ].join('');
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Got it');
    expect(out.newContentHtml).not.toContain('yahoo_quoted');
    expect(out.quotedContentHtml).toContain('yahoo_quoted');
  });

  it('tolerates attribute order (id before class)', () => {
    const html = '<p>hi</p><div id="foo" data-x="1" class="prefix gmail_quote suffix">old</div>';
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('hi');
    expect(out.quotedContentHtml).toContain('gmail_quote');
  });

  it('handles malformed HTML gracefully', () => {
    // Missing closing tags — cheerio auto-closes like a browser would.
    // Verifies we never throw; exact split location on malformed input
    // is browser-defined and not worth asserting.
    const html = '<div>New content</div><div class="gmail_quote">quoted';
    expect(() => splitBody('', html, [])).not.toThrow();
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('New content');
    expect(out.quotedContentHtml).toContain('gmail_quote');
  });

  it('leaves HTML alone with no marker', () => {
    const html = '<p>just my message</p>';
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toBe('<p>just my message</p>');
    expect(out.quotedContentHtml).toBeNull();
  });

  it('splits short-new + long-blockquote (the #556 case)', () => {
    // Reply body: ~200 chars of new content followed by 3000+ chars
    // of quoted history in a bare blockquote. Real replies that
    // wrap prior content in a blockquote without any client-class
    // marker should still split correctly.
    const newContent =
      '<div>Could you please give me an update on my exchange order, order number 230050? It has reached Shimla today.</div>';
    const longQuoted =
      '<blockquote>' + 'lorem ipsum '.repeat(300) + '</blockquote>';
    const html = newContent + longQuoted;
    const out = splitBody('', html, []);
    expect(out.newContentHtml).toContain('Could you please');
    expect(out.newContentHtml).not.toContain('lorem');
    expect(out.quotedContentHtml).toContain('lorem');
  });

  it('still ignores a tiny intro blockquote (pull-quote pattern)', () => {
    // A user opens their reply with a short pull-quote at the top.
    // We should NOT treat that as the quoted-history boundary —
    // the blockquote is small AND at the very start.
    const html =
      '<blockquote>brief pull quote</blockquote><p>Here is my long thoughtful reply that continues on and provides substantial context and value to the reader.</p>';
    const out = splitBody('', html, []);
    expect(out.quotedContentHtml).toBeNull();
    expect(out.newContentHtml).toContain('brief pull quote');
    expect(out.newContentHtml).toContain('Here is my long thoughtful reply');
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
