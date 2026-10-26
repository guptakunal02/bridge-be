import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation';
import { S3StorageService } from '../common/storage/s3-storage.service';

/**
 * Max bytes Meta accepts for a template-header image. The actual
 * limit is higher for VIDEO + DOCUMENT headers but IMAGE caps at
 * 5MB — rejecting larger uploads client-side avoids a confusing
 * mid-upload failure from Meta's resumable endpoint.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

/**
 * Owns the two-sided upload for a WhatsApp template header image.
 *
 * Meta's rule: at template-authoring time, Meta needs a `header_handle`
 * returned by their **Resumable Upload API** so their reviewer has a
 * concrete sample image to approve against. The handle alone isn't
 * useful on the send path, so we ALSO upload the same bytes to S3
 * and keep that URL on the template row. At send time (Phase 3
 * broadcast) we hand Meta a public S3 URL for the image, which can
 * optionally be overridden per campaign.
 *
 * Flow:
 *   1. Upload bytes to our S3 bucket → get a public URL.
 *   2. Open a Meta resumable upload session (POST /{APP_ID}/uploads).
 *   3. Upload the bytes to the session (POST /{upload_id}, note the
 *      "OAuth" auth scheme Meta mandates on this call — NOT Bearer).
 *   4. Return { url, handle } to the controller; the admin's template
 *      authoring form stashes both and submits them with the template.
 */
@Injectable()
export class WhatsappMediaUploadService {
  private readonly logger = new Logger(WhatsappMediaUploadService.name);

  constructor(
    private readonly s3: S3StorageService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async uploadImageForTemplateHeader(
    buffer: Buffer,
    filename: string,
    contentType: string,
  ): Promise<{ url: string; handle: string }> {
    if (!ALLOWED_IMAGE_MIMES.has(contentType)) {
      throw new BadRequestException(
        `Unsupported image type ${contentType}. Use PNG or JPEG.`,
      );
    }
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `Image too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
      );
    }

    // S3 upload + Meta session-create are independent and run in
    // parallel — we only pay the slower of the two instead of the
    // sum. The subsequent Meta bytes upload needs the uploadId AND
    // the buffer, so it still waits on both. Net saving: ~0.5–1.5s
    // on a cold run (S3 round-trip ~1s, Meta session ~0.5–1s).
    const appId = this.config.get('WHATSAPP_APP_ID', { infer: true });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const sessionUrl =
      `https://graph.facebook.com/${version}/${appId}/uploads` +
      `?file_name=${encodeURIComponent(filename)}` +
      `&file_length=${buffer.byteLength}` +
      `&file_type=${encodeURIComponent(contentType)}`;

    const startedAt = Date.now();
    let url: string;
    let uploadId: string;
    try {
      const [s3Result, sessionRes] = await Promise.all([
        this.s3.upload({ filename, contentType, body: buffer }),
        fetch(sessionUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      url = s3Result.url;
      if (!sessionRes.ok) {
        const body = await sessionRes.text();
        this.logger.warn(
          `Meta upload-session rejected ${sessionRes.status}: ${body.slice(0, 400)}`,
        );
        throw new InternalServerErrorException(
          `Meta refused to open an upload session (HTTP ${sessionRes.status})`,
        );
      }
      const sessionJson: { id?: string } = await sessionRes.json();
      if (!sessionJson.id) {
        throw new InternalServerErrorException(
          'Meta returned no upload id on session create',
        );
      }
      uploadId = sessionJson.id;
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(
        `S3+Meta parallel step failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new InternalServerErrorException(
        'Could not prepare the upload — retry in a moment',
      );
    }
    const parallelMs = Date.now() - startedAt;

    // 3 — Push the bytes. The second call uses `Authorization: OAuth`
    // (not Bearer) — a Meta quirk documented on the Resumable Upload
    // reference. `file_offset: 0` for a single-chunk upload.
    const bytesUrl = `https://graph.facebook.com/${version}/${uploadId}`;
    let bytesRes: Response;
    try {
      bytesRes = await fetch(bytesUrl, {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${token}`,
          file_offset: '0',
          'Content-Type': contentType,
        },
        body: buffer as unknown as BodyInit,
      });
    } catch (err) {
      this.logger.error(
        `Meta upload-bytes network error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new InternalServerErrorException(
        'Could not stream bytes to Meta — retry in a moment',
      );
    }
    if (!bytesRes.ok) {
      const body = await bytesRes.text();
      this.logger.warn(
        `Meta upload-bytes rejected ${bytesRes.status}: ${body.slice(0, 400)}`,
      );
      throw new InternalServerErrorException(
        `Meta refused the image bytes (HTTP ${bytesRes.status})`,
      );
    }
    const bytesJson: { h?: string } = await bytesRes.json();
    const handle = bytesJson.h;
    if (!handle) {
      throw new InternalServerErrorException(
        'Meta returned no handle on upload complete',
      );
    }

    const totalMs = Date.now() - startedAt;
    const bytesMs = totalMs - parallelMs;
    this.logger.log(
      `Template header uploaded in ${totalMs}ms (parallel=${parallelMs}ms, bytes=${bytesMs}ms): ` +
        `size=${(buffer.byteLength / 1024).toFixed(0)}KB s3=${url.slice(-32)} metaHandle=${handle.slice(0, 12)}…`,
    );
    return { url, handle };
  }
}
