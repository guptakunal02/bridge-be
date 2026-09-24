import {
  ArrayNotEmpty,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One inbound-email attachment as seen by the IMAP loop (post-parse,
 * pre-upload). Uploaded to S3 during ingest; the resulting metadata
 * is persisted as an email_message_attachment row. Never crosses
 * the HTTP boundary — populated only in server-to-server calls.
 */
export class IngestEmailAttachment {
  @IsString()
  @IsNotEmpty()
  filename!: string;

  @IsString()
  @IsNotEmpty()
  contentType!: string;

  /** Byte size — surfaced on the FE as "invoice.pdf (240 KB)". */
  @IsInt()
  size!: number;

  /** Raw bytes; the DTO carries a Buffer straight from mailparser. */
  body!: Buffer;
}

/**
 * Body payload for ingesting a single inbound email into Bridge.
 * Independent of the entity — this is the API contract, not the DB shape.
 */
export class IngestEmailInbox {
  /** Sender's email address (From:). */
  @IsEmail()
  sender!: string;

  /** Recipients (To:). At least one; each element must be a valid email. */
  @IsEmail({}, { each: true })
  @ArrayNotEmpty()
  receiver!: string[];

  /** Subject line — email clients may omit this, so it's optional. */
  @IsOptional()
  @IsString()
  subject?: string;

  /** Plain-text body of the email. */
  @IsString()
  @IsNotEmpty()
  content!: string;

  /** Original HTML body (if the sender included one). */
  @IsOptional()
  @IsString()
  contentHtml?: string;

  /**
   * Gmail Message-ID header. Used as the idempotency key in
   * EmailMessage.external_message_id to dedup replays from the IMAP loop.
   */
  @IsString()
  @IsNotEmpty()
  external_message_id!: string;

  /**
   * The parent Message-ID this email is replying to (In-Reply-To
   * header). Optional — absent on brand-new threads. Together with
   * `references`, drives thread stitching so a chain of replies
   * ends up on one ticket instead of a fresh one per message.
   */
  @IsOptional()
  @IsString()
  inReplyTo?: string;

  /**
   * Full References chain, oldest → newest. RFC 5322 §3.6.4 guarantees
   * this carries every ancestor Message-ID in the thread up to and
   * including In-Reply-To. Used to find the root of the conversation.
   */
  @IsOptional()
  @IsString({ each: true })
  references?: string[];

  /**
   * Any file attachments the sender included. Parsed by mailparser
   * in the IMAP loop; EmailInboxService uploads them to S3 during
   * ingest and persists the metadata rows. Optional because most
   * inbound emails carry no attachments.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => IngestEmailAttachment)
  attachments?: IngestEmailAttachment[];
}
