/**
 * Rewrites `<img src="data:image/*;base64,...">` tags in an email's
 * HTML body to point at the already-uploaded S3 URLs of the
 * attachments. Mailparser surfaces inline images BOTH as `data:` URIs
 * inside `parsed.html` AND as separate items in `parsed.attachments`
 * — we end up storing the bytes twice: once in `email_message_attachment.
 * storage_url` (S3) and once as a megabyte-sized base64 blob inside
 * `email_message.content_html`.
 *
 * The second copy is the one that killed us. A 24 MB thread crashed
 * the serializer with 100+ MB of transient allocation and systemd
 * OOM-killed the whole pm2 service group (incident 2026-10-29).
 *
 * Rewriting at ingest time means the DB only ever stores small HTML
 * going forward. A one-time backfill (scripts/backfill-email-html.ts)
 * runs the same rewrite over every historical row so opening an old
 * ticket is also safe.
 *
 * Pairing by order of appearance is intentional: there's no robust
 * cross-walk between a stripped `cid:` tag and a Content-ID header
 * after mailparser flattens the structure, but Nth-inline → Nth-image
 * attachment is empirically correct for every mail client we've seen
 * (Gmail iOS, Yahoo Mail, Apple Mail, Outlook). Edge case: a sender
 * who embedded via `data:` only (no separate attachment) renders a
 * minimal text placeholder.
 */
export interface InlineImageAttachment {
  content_type: string;
  storage_url: string;
}

const INLINE_IMAGE_PATTERN =
  /<img[^>]*src\s*=\s*["']data:image\/[^"']+["'][^>]*>/gi;

const INLINE_PLACEHOLDER =
  '<span style="color:#999;font-size:12px">[inline image unavailable]</span>';

export function rewriteInlineBase64Images(
  html: string,
  attachments: InlineImageAttachment[],
): string {
  const imageAttachments = attachments.filter((a) =>
    (a.content_type ?? '').startsWith('image/'),
  );
  let attachIdx = 0;
  return html.replace(INLINE_IMAGE_PATTERN, () => {
    const att = imageAttachments[attachIdx++];
    if (att) {
      // max-width:100% so a camera-wide screenshot doesn't blow past
      // the thread column on narrow viewports. border-radius matches
      // the subtle chrome around attachment chips.
      return `<img src="${att.storage_url}" style="max-width:100%;height:auto;border-radius:4px" />`;
    }
    return INLINE_PLACEHOLDER;
  });
}

/**
 * Cheap pre-check — avoids allocating the imageAttachments array and
 * walking the regex when there's nothing to rewrite. Called from the
 * ingest hot path, where the overwhelming majority of inbound emails
 * won't match.
 */
export function hasInlineBase64Image(html: string): boolean {
  return html.includes('data:image/');
}
