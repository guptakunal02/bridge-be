/**
 * Server-side computation of the "message view" — the shape the FE
 * actually needs to render each email in a ticket thread.
 *
 * What lives here:
 *   - `splitBody`      : split plain text + HTML into fresh reply
 *                        content vs the customer's quoted history
 *   - `shouldShowSubjectHeader`
 *                      : decide when the per-message subject is
 *                        redundant with the ticket's overall subject
 *   - `parseQuotedThread`
 *                      : reconstruct pseudo-messages from the
 *                        stripped quoted content so the FE can
 *                        render each ancestor as its own card
 *
 * Every function is pure so unit tests cover them end-to-end without
 * a DI container. The mapper in ticket-response.dto.ts wires them in
 * at response time.
 */

/**
 * Layered reply/forward prefixes across English + common European
 * variants. Iterative stripping collapses "Re: Fwd: Re: X" to "X"
 * before comparison so the ticket header vs message header match
 * across long threads.
 */
const SUBJECT_PREFIX_RE =
  /^\s*(re|fwd?|fw|aw|sv|vs|rv|rép|res|rif)\s*:\s*/i;

function stripPrefixes(subject: string): string {
  let stripped = subject.trim();
  while (SUBJECT_PREFIX_RE.test(stripped)) {
    stripped = stripped.replace(SUBJECT_PREFIX_RE, '');
  }
  return stripped.trim();
}

export function normaliseSubject(raw: string | null): string {
  if (!raw) return '';
  return stripPrefixes(raw).toLowerCase();
}

/**
 * True when the message's subject genuinely differs from the ticket
 * subject (a mid-thread rename). If it's the same subject with just
 * a Re/Fwd/AW-style prefix stacked on, we skip rendering it on the
 * message card — the sticky ticket header already shows the subject
 * once and repeating it per message is pure noise.
 */
export function shouldShowSubjectHeader(
  messageSubject: string | null,
  ticketSubject: string | null,
): boolean {
  if (!messageSubject) return false;
  const m = normaliseSubject(messageSubject);
  const t = normaliseSubject(ticketSubject);
  if (m === '' || t === '') return true;
  return m !== t;
}

/* ------------------------------------------------------------------ */
/* Body splitting                                                      */
/* ------------------------------------------------------------------ */

export interface SplitBodyResult {
  newContent: string;
  newContentHtml: string | null;
  quotedContent: string | null;
  quotedContentHtml: string | null;
}

/**
 * Split a message body into "fresh reply" and "quoted history"
 * halves. Tries three strategies in order:
 *
 *   1. Standard quote markers ("On <date> wrote:", "> " line prefix,
 *      "-----Original Message-----") — hit rate ~95% for Gmail /
 *      Apple Mail / Outlook.
 *
 *   2. Prior-content substring match — for the rare client that
 *      concatenates the previous body onto the reply WITHOUT any of
 *      the standard markers. We compare against the priorBodies
 *      array (previous messages on this ticket) and, if the entire
 *      prior body appears as a substring in this reply, split at
 *      the boundary.
 *
 *   3. If neither strategy matches → the whole body is "new".
 *
 * HTML is split using gmail_quote / trailing <blockquote> markers.
 * The two are treated independently because a message may have one
 * strategy work for the text half but not the HTML half.
 */
export function splitBody(
  text: string,
  html: string | null,
  priorBodies: string[],
): SplitBodyResult {
  const textSplit = splitTextByHeuristics(text) ?? splitTextByPrior(text, priorBodies);
  const htmlSplit = html ? splitHtmlBody(html) : { newHtml: null, quotedHtml: null };
  return {
    newContent: textSplit ? textSplit.newText : text,
    newContentHtml: htmlSplit.newHtml,
    quotedContent: textSplit ? textSplit.quotedText : null,
    quotedContentHtml: htmlSplit.quotedHtml,
  };
}

/**
 * The classic detection heuristics. Applies each in order and returns
 * the first split that matches. Returns null when none do.
 */
function splitTextByHeuristics(
  text: string,
): { newText: string; quotedText: string } | null {
  // Gmail / Apple Mail: "On [date], [sender] wrote:" preamble.
  // Multi-line since the preamble sits on its own line surrounded
  // by blank lines.
  const preamble = text.match(/^On .+ wrote:$/m);
  if (preamble && preamble.index !== undefined) {
    return {
      newText: text.slice(0, preamble.index).trimEnd(),
      quotedText: text.slice(preamble.index),
    };
  }
  // Outlook.
  const outlook = text.indexOf('-----Original Message-----');
  if (outlook !== -1) {
    return {
      newText: text.slice(0, outlook).trimEnd(),
      quotedText: text.slice(outlook),
    };
  }
  // "> " quoted-line prefix at start of any line.
  const quoteLine = text.match(/^>[ ].*$/m);
  if (quoteLine && quoteLine.index !== undefined) {
    return {
      newText: text.slice(0, quoteLine.index).trimEnd(),
      quotedText: text.slice(quoteLine.index),
    };
  }
  return null;
}

/**
 * Fallback for clients that inline the previous message body without
 * any of the standard markers. Looks for the LARGEST prior body as
 * a substring — a partial hit could be a false positive on a common
 * phrase, so we require the full body to appear verbatim.
 *
 * Only accepts the split when it produces a substantial "new" chunk
 * (>= 20 chars) that's SHORTER than or equal to the quoted portion.
 * That guards against a bottom-quoted-without-marker case where
 * the new content is at the top and the prior body at the bottom —
 * splitting there would incorrectly file the new content as
 * "quoted history."
 */
function splitTextByPrior(
  text: string,
  priorBodies: string[],
): { newText: string; quotedText: string } | null {
  if (priorBodies.length === 0) return null;
  // Longest prior first — best chance of a unique substring hit.
  const sorted = [...priorBodies].sort((a, b) => b.length - a.length);
  for (const prior of sorted) {
    const trimmedPrior = prior.trim();
    // Too short? Skip — a 20-char body could false-positive on a
    // common phrase like a signature.
    if (trimmedPrior.length < 40) continue;
    const idx = text.indexOf(trimmedPrior);
    if (idx === -1) continue;
    const endOfPrior = idx + trimmedPrior.length;
    const quotedText = text.slice(0, endOfPrior).trimEnd();
    const newText = text.slice(endOfPrior).trimStart();
    if (newText.length < 20) continue;
    // Guard against the "new content is at top, prior body is at
    // bottom without a marker" layout — in that case the new
    // section would be substantially longer than the quoted one.
    if (newText.length > quotedText.length) continue;
    return { newText, quotedText };
  }
  return null;
}

/**
 * Split HTML into fresh vs quoted. Recognises Gmail's gmail_quote
 * wrapper and a trailing <blockquote> as a fallback. No prior-content
 * heuristic on the HTML side yet — HTML replies almost always carry
 * a gmail_quote or blockquote marker, so the coverage from these two
 * paths is very high.
 */
function splitHtmlBody(html: string): {
  newHtml: string;
  quotedHtml: string | null;
} {
  const gmail = html.search(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["']/i);
  if (gmail !== -1) {
    return { newHtml: html.slice(0, gmail), quotedHtml: html.slice(gmail) };
  }
  // Fallback — a blockquote late in the body. Only treat as quoted
  // if it starts past 20% of the doc so an intro-blockquote at the
  // top of the reply isn't wrongly hidden.
  const blockquote = html.search(/<blockquote/i);
  if (blockquote !== -1 && blockquote > html.length * 0.2) {
    return {
      newHtml: html.slice(0, blockquote),
      quotedHtml: html.slice(blockquote),
    };
  }
  return { newHtml: html, quotedHtml: null };
}

/* ------------------------------------------------------------------ */
/* Quoted-thread reconstruction                                        */
/* ------------------------------------------------------------------ */

export interface PseudoMessage {
  sender: string;
  date: string;
  body: string;
}

/**
 * Parse a quoted section into an ordered list of pseudo-messages
 * using the "On <date>, <name> wrote:" preamble that every major
 * client inserts around each quoted level. Order: newest first (as
 * the quoted content appears — i.e. the immediate parent of this
 * reply comes before its own parent).
 *
 * Each pseudo-message body has its "> " quote prefix stripped so it
 * reads like a normal message instead of an inbox quote block.
 *
 * Returns an empty array when no preamble is found — the FE falls
 * back to rendering the raw quoted content in that case.
 */
export function parseQuotedThread(quotedText: string): PseudoMessage[] {
  const preambleRe = /^On (.+?) wrote:\s*$/gm;
  const marks: Array<{ start: number; end: number; header: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = preambleRe.exec(quotedText)) !== null) {
    const header = m[1] ?? '';
    marks.push({
      start: m.index,
      end: m.index + m[0].length,
      header: header.trim(),
    });
  }
  if (marks.length === 0) return [];

  const out: PseudoMessage[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (!mark) continue;
    const nextMark = marks[i + 1];
    const nextStart = nextMark ? nextMark.start : quotedText.length;
    const bodyRaw = quotedText.slice(mark.end, nextStart).replace(/^\s*\n/, '');
    const body = stripQuotePrefix(bodyRaw);
    const { sender, date } = parseHeader(mark.header);
    out.push({ sender, date, body });
  }
  return out;
}

function parseHeader(header: string): { sender: string; date: string } {
  const emailMatch = header.match(/<([^>]+)>/);
  if (emailMatch && emailMatch.index !== undefined) {
    const email = emailMatch[1] ?? '';
    const beforeEmail = header.slice(0, emailMatch.index).trim();
    const time = beforeEmail.match(/^(.+?(?:AM|PM|am|pm))\s+(.+)$/);
    if (time) {
      const timePart = time[1] ?? '';
      const senderPart = time[2] ?? '';
      return {
        date: timePart.trim(),
        sender: `${senderPart.trim()} <${email}>`,
      };
    }
    return { sender: `${beforeEmail} <${email}>`, date: '' };
  }
  const time = header.match(/^(.+?(?:AM|PM|am|pm))\s+(.+)$/);
  if (time) {
    const timePart = time[1] ?? '';
    const senderPart = time[2] ?? '';
    return { date: timePart.trim(), sender: senderPart.trim() };
  }
  return { sender: header, date: '' };
}

function stripQuotePrefix(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
}
