import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

/**
 * Multer options for reply-attachment uploads. Centralised so the
 * controller reads as a one-liner and the allowlist can be audited
 * in one spot.
 *
 * Rules:
 *   - 25 MB per file (matches Gmail's max message size headroom;
 *     the SMTP relay would bounce anything larger)
 *   - 1 file per request (the FE calls this endpoint per-file)
 *   - MIME allowlist: images / office docs / pdf / text / archives
 *     / json. Everything else is rejected before bytes touch disk.
 *     SVG is out on purpose (XSS via script tags in the SVG). HTML
 *     and JS are out (public bucket + serving arbitrary HTML under
 *     our domain would be a phishing kit).
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
