import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { EnvVars } from '../../config/env.validation';

export interface UploadedFile {
  /** S3 key we wrote to, e.g. `attachments/2026/09/22/<uuid>/invoice.pdf`. */
  key: string;
  /** Public https URL — the bucket is public-read. */
  url: string;
}

/**
 * Thin wrapper around the S3 PutObject call. The bucket is public-read
 * by policy (see infra runbook), so we don't presign; the returned
 * `url` is the direct virtual-host address that any browser can hit.
 *
 * A single S3Client is held for the process lifetime — the SDK
 * multiplexes requests over an HTTP keep-alive agent internally, so
 * one instance is optimal.
 */
@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly config: ConfigService<EnvVars, true>) {
    this.region = this.config.get('AWS_REGION', { infer: true });
    this.bucket = this.config.get('S3_ATTACHMENTS_BUCKET', { infer: true });
    this.client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.config.get('AWS_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: this.config.get('AWS_SECRET_ACCESS_KEY', {
          infer: true,
        }),
      },
    });
  }

  /**
   * Upload the given bytes under a fresh randomly-prefixed key.
   *
   * Key shape: `attachments/YYYY/MM/DD/<uuid>/<filename>`. The date
   * partitioning is purely for humans browsing the bucket console —
   * S3 doesn't care about directories. The uuid folder prevents two
   * emails with `invoice.pdf` colliding.
   *
   * `filename` is sanitised: whitespace to underscores, non-safe
   * characters stripped. The original name survives at the DB level
   * on the attachment row so the FE can display it verbatim.
   */
  async upload(input: {
    filename: string;
    contentType: string;
    body: Buffer;
  }): Promise<UploadedFile> {
    const safeName = sanitiseFilename(input.filename);
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const key = `attachments/${yyyy}/${mm}/${dd}/${randomUUID()}/${safeName}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        // ContentDisposition tells browsers to download rather than
        // inline-render arbitrary content (matters for html/js
        // masquerading as user-supplied attachments). Filename in
        // the header uses the sanitised name so it survives HTTP.
        ContentDisposition: `attachment; filename="${safeName}"`,
      }),
    );

    return {
      key,
      url: this.publicUrl(key),
    };
  }

  /**
   * The direct virtual-host URL for a given key. Bucket policy grants
   * `s3:GetObject` to `Principal: *`, so any browser can fetch it
   * without credentials.
   */
  publicUrl(key: string): string {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  /**
   * Pull the entire object body into memory. Used by outbound SMTP
   * so nodemailer gets a `content: Buffer` rather than a `path: URL`
   * — that removes an SSRF surface (FE-supplied URLs can no longer
   * decide what the SMTP relay fetches) and gives us predictable
   * timeout / retry behaviour via the AWS SDK's own controls.
   *
   * `key` must belong to our own attachments prefix — reject
   * anything else defensively so a compromised caller can't point
   * this at, say, a credentials object elsewhere in the bucket.
   */
  async download(key: string): Promise<{
    body: Buffer;
    contentType: string | null;
  }> {
    if (!key.startsWith('attachments/')) {
      throw new Error(
        `Refused to download S3 key outside the attachments/ prefix: ${key}`,
      );
    }
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) {
      throw new Error(`S3 object has no body: ${key}`);
    }
    // The SDK v3 hands back a Node.js Readable via transformToByteArray()
    // on Node; using the officially-supported helper keeps us clear of
    // internal typing quirks.
    const bytes = await res.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: res.ContentType ?? null,
    };
  }
}

/**
 * Replace whitespace with underscores and drop anything outside a
 * conservative allowlist. Keeps dots so extensions survive.
 * Truncates to 200 chars so we don't blow S3's 1024-char key limit
 * combined with the date + uuid prefix.
 */
function sanitiseFilename(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, '_');
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '');
  const withDefault = cleaned.length > 0 ? cleaned : 'attachment';
  return withDefault.slice(0, 200);
}
