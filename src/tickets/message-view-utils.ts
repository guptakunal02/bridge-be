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
 * HTML splitting uses `cheerio` (server-side jQuery on top of parse5)
 * — real DOM traversal, not regex heuristics. See splitHtmlBody for
 * the CSS-selector strategy stack.
 *
 * Every function is pure so unit tests cover them end-to-end without
 * a DI container. The mapper in ticket-response.dto.ts wires them in
 * at response time.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

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
  // Collapse runs of whitespace to a single space before comparing.
  // Gmail rewrites "double  space" in subject lines to a single
  // space on reply; iPhone Mail preserves the original. Without
  // this, a customer who typed extra spaces in their subject (or
  // pasted a multi-line paragraph into the Subject field — see
  // ticket #556) trips a false "different subject" verdict and
  // we redundantly render the full subject on every reply card.
  return stripPrefixes(raw).replace(/\s+/g, ' ').toLowerCase();
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
  const result: SplitBodyResult = {
    newContent: textSplit ? textSplit.newText : text,
    newContentHtml: htmlSplit.newHtml,
    quotedContent: textSplit ? textSplit.quotedText : null,
    quotedContentHtml: htmlSplit.quotedHtml,
  };
  // Safety net: if newContent still contains a prior body verbatim,
  // our split missed the mark. Rather than silently showing the
  // agent a mixed new+quoted blob, fall back to "everything is
  // fresh" so no content is hidden. Better to over-show than
  // under-show — the "Show earlier messages" toggle disappears
  // for this message, and the agent sees the full body inline.
  if (containsPriorContent(result.newContent, priorBodies)) {
    return {
      newContent: text,
      newContentHtml: html,
      quotedContent: null,
      quotedContentHtml: null,
    };
  }
  return result;
}

/**
 * True when `newContent` contains any prior body as a substring of
 * meaningful length. Used as the safety-net cross-check.
 */
function containsPriorContent(
  newContent: string,
  priorBodies: string[],
): boolean {
  const trimmedNew = newContent.trim();
  if (trimmedNew.length === 0) return false;
  for (const prior of priorBodies) {
    const trimmedPrior = prior.trim();
    if (trimmedPrior.length < 80) continue;
    // Sample the middle 200 chars of the prior body — avoids false
    // positives on generic openers ("Hi,") or closers ("Thanks!")
    // while catching bodies that were meaningfully quoted.
    const mid = Math.max(0, Math.floor(trimmedPrior.length / 2) - 100);
    const sample = trimmedPrior.slice(mid, mid + 200);
    if (trimmedNew.includes(sample)) return true;
  }
  return false;
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
 * Selector list matched against the DOM to find quote boundaries.
 * The FIRST element in document order that matches ANY of these is
 * treated as the boundary — everything from it onward is quoted
 * history, everything before is fresh reply content.
 *
 * Extending for a new email client = add a selector here + a test.
 * Selectors intentionally tolerate class-list variations because a
 * DOM query on `.gmail_quote` matches both `class="gmail_quote"` and
 * `class="gmail_quote gmail_quote_container"` naturally.
 */
const QUOTE_BOUNDARY_SELECTORS = [
  // Gmail — web + Android. Also matches gmail_quote_container.
  '.gmail_quote',
  '.gmail_attr',
  '.gmail_extra',
  // Apple Mail / iPhone Mail
  'blockquote[type="cite"]',
  '.AppleMailQuote',
  // Outlook desktop
  '.OutlookMessageHeader',
  '#divRplyFwdMsg',
  // Outlook web
  '#appendonsend',
  '[id="mail-editor-reference-message-container"]',
  // Yahoo
  '.yahoo_quoted',
  // Zoho
  '.zmail_signature ~ blockquote',
  // Generic — any blockquote that's not just a tiny pull-quote at
  // the very top. We filter with a length check in JS after the
  // selector match, since CSS can't express "large enough."
  'blockquote',
].join(', ');

/**
 * Split HTML into fresh vs quoted using cheerio DOM traversal.
 *
 * Strategy:
 *   1. Parse HTML into a DOM tree.
 *   2. Find every element matching QUOTE_BOUNDARY_SELECTORS.
 *   3. Filter out obvious false positives (tiny intro blockquotes).
 *   4. Pick the FIRST remaining match in document order.
 *   5. Serialize the pre-boundary DOM as newHtml and the boundary +
 *      everything after as quotedHtml.
 *
 * Why cheerio not regex:
 *   - Attribute order doesn't matter — `class="foo gmail_quote bar"`
 *     matches `.gmail_quote` naturally.
 *   - Malformed markup is tolerated (parse5 handles it like Chrome does).
 *   - Nested boundaries handled by "first in document order wins."
 *   - Adding a new client is one line in QUOTE_BOUNDARY_SELECTORS.
 */
function splitHtmlBody(html: string): {
  newHtml: string;
  quotedHtml: string | null;
} {
  if (!html || html.trim().length === 0) {
    return { newHtml: html, quotedHtml: null };
  }
  const $ = cheerio.load(`<div id="__msg_root">${html}</div>`, null, false);
  const root = $('#__msg_root');
  if (root.length === 0) return { newHtml: html, quotedHtml: null };

  // Find first candidate boundary in document order.
  const candidates = root.find(QUOTE_BOUNDARY_SELECTORS);
  const boundary = candidates.filter((_, el) => !isTinyPullQuote($, el)).first();
  if (boundary.length === 0) {
    return { newHtml: html, quotedHtml: null };
  }

  // Split the DOM: everything at or after `boundary` (in document
  // order, considering all ancestors) is quoted content. We walk
  // upward from the boundary until we reach a child of the root,
  // then take that node + all its following siblings as quoted, and
  // reserialize the root's remaining children as newHtml.
  const topLevelAncestor = getTopLevelAncestor($, boundary, root);
  if (!topLevelAncestor) {
    return { newHtml: html, quotedHtml: null };
  }

  // Collect quoted: topLevelAncestor and every subsequent sibling.
  const quotedParts: string[] = [];
  quotedParts.push($.html(topLevelAncestor) ?? '');
  const following = $(topLevelAncestor).nextAll();
  following.each((_, el) => {
    quotedParts.push($.html(el) ?? '');
  });
  const quotedHtml = quotedParts.join('');

  // Remove the quoted portion from the root and serialize the rest.
  $(topLevelAncestor).nextAll().remove();
  $(topLevelAncestor).remove();
  const newHtml = root.html() ?? '';

  // Trim empty tail (trailing <br>, <div><br></div>, etc.) so
  // newHtml doesn't render a big empty space above the fold.
  const trimmedNewHtml = trimTailingEmpty(newHtml);

  return {
    newHtml: trimmedNewHtml,
    quotedHtml: quotedHtml.length > 0 ? quotedHtml : null,
  };
}

/**
 * A tiny blockquote near the top of the reply is likely a pull-quote
 * the user opened with, not the quote-history boundary. Same intuition
 * as the old 40-char / 200-char guard but expressed against the DOM
 * for clarity.
 */
function isTinyPullQuote(
  $: cheerio.CheerioAPI,
  el: AnyNode,
): boolean {
  const node = $(el);
  // Only apply the guard to bare <blockquote> — clients with an
  // explicit gmail_quote / OutlookMessageHeader class are always
  // legitimate boundaries regardless of size.
  const tagName = 'tagName' in el ? String(el.tagName).toLowerCase() : '';
  if (tagName !== 'blockquote') return false;
  const className = node.attr('class') ?? '';
  if (className.includes('gmail_quote') || className.includes('yahoo_quoted')) {
    return false;
  }
  if (node.attr('type') === 'cite') return false;
  const text = node.text().trim();
  if (text.length >= 200) return false;
  // Near the top? Check that no substantial content precedes it.
  const before = $.html(node.prevAll()) ?? '';
  // Strip tags to get just text-ish length.
  const beforeText = cheerio.load(before).text().trim();
  return beforeText.length < 40;
}

/**
 * Walk up from `el` until we reach a direct child of `root`. That
 * top-level ancestor + everything after it at the top level is what
 * becomes the quoted section. Returns null when we somehow can't
 * reach a top-level ancestor (shouldn't happen for cheerio-parsed
 * DOMs, but defensive).
 */
function getTopLevelAncestor(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
  root: cheerio.Cheerio<AnyNode>,
): AnyNode | null {
  let current: cheerio.Cheerio<AnyNode> = el;
  const rootNode = root.get(0);
  if (!rootNode) return null;
  for (let i = 0; i < 100; i++) {
    const parent = current.parent();
    if (parent.length === 0) return current.get(0) ?? null;
    const parentNode = parent.get(0);
    if (parentNode === rootNode) {
      return current.get(0) ?? null;
    }
    current = parent;
  }
  return null;
}

/**
 * Strip trailing empty <br>, whitespace, and empty <div><br></div>
 * wrappers from the end of newHtml — those get left behind by the
 * split and would render an ugly gap above the "···" toggle button.
 */
function trimTailingEmpty(html: string): string {
  return html
    .replace(/(?:\s|<br\s*\/?>|<div[^>]*>\s*(?:<br\s*\/?>\s*)*<\/div>)+$/gi, '')
    .trimEnd();
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
