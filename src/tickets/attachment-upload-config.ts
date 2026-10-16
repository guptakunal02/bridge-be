import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

/**
 * Multer options for reply-attachment uploads. Centralised so the
 * controller reads as a one-liner and the allowlist can be audited
 * in one spot.
 *
 * Rules:
 *   - 25 MB per file (matches Gmail's max message size headroom;
 *     the SMTP relay would bounce anything larger). Note: WhatsApp
 *     has its own per-kind caps (image 5 MB / video + audio 16 MB /
 *     document 100 MB) enforced in replyWhatsapp — the 25 MB cap
 *     here is the hard upper bound regardless of channel. The one
 *     real exception is PDFs bigger than 25 MB going to WhatsApp
 *     (which allows 100 MB docs); if that becomes a real request
 *     we lift to 100 MB here and tighten the per-channel cap below.
 *   - 1 file per request (the FE calls this endpoint per-file)
 *   - MIME allowlist: images / office docs / pdf / text / archives
 *     / json / video / audio. Everything else is rejected before
 *     bytes touch disk. SVG is out on purpose (XSS via script tags
 *     in the SVG). HTML and JS are out (public bucket + serving
 *     arbitrary HTML under our domain would be a phishing kit).
 *   - Filename cannot contain path separators or "..".
 */
const MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  // Images (svg deliberately excluded — XSS surface)
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  // PDF
  'application/pdf',
  // Word / Excel / PowerPoint (legacy + OOXML)
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text formats
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/rtf',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  // Video — mp4 + mov are the common ones agents will upload from a
  // phone or screen recording; 3gp is WhatsApp's secondary; webm is
  // Chrome/Firefox recordings; avi is legacy but still shows up.
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
  'video/x-msvideo',
  // Audio — covers mp3/m4a/wav/ogg/aac/amr (WhatsApp voice-note
  // compatible) and the full set of common formats email clients
  // produce as recordings.
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/aac',
  'audio/amr',
  'audio/webm',
]);

export const REPLY_ATTACHMENT_UPLOAD_OPTIONS: MulterOptions = {
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!MIME_ALLOWLIST.has(file.mimetype)) {
      cb(
        new BadRequestException(
          `Unsupported file type: ${file.mimetype}`,
        ) as unknown as Error,
        false,
      );
      return;
    }
    const name = file.originalname ?? '';
    if (
      name.includes('..') ||
      name.includes('/') ||
      name.includes('\\') ||
      name.length === 0 ||
      name.length > 255
    ) {
      cb(
        new BadRequestException(
          'Filename contains illegal characters or is too long.',
        ) as unknown as Error,
        false,
      );
      return;
    }
    cb(null, true);
  },
};
