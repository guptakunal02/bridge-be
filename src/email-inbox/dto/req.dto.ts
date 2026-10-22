import {
  ArrayNotEmpty,
  IsBoolean,
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
  /**
   * Effective sender for ingest decisions. If the message has a
   * Reply-To header we honour it over From (see the Reply-To fix
   * — judge.me / Shopify review notifications set Reply-To to the
   * real customer). Falls back to From when Reply-To is absent.
   */
  @IsEmail()
  sender!: string;

  /**
   * Raw From-header address, independent of Reply-To honouring.
   * Needed to distinguish "we sent this via a relay" (From =
   * external, Reply-To = us) from "customer or notification sent
   * this" (From = anyone). Classification happens in ingestInbound.
   * Optional for backward compat — older callers that didn't set
   * this field behave the same as before.
   */
  @IsOptional()
  @IsEmail()
  fromAddress?: string;

  /** Recipients (To:). At least one; each element must be a valid email. */
  @IsEmail({}, { each: true })
  @ArrayNotEmpty()
  receiver!: string[];

  /** Subject line — email clients may omit this, so it's optional. */
  @IsOptional()
  @IsString()
  subject?: string;

  /** Plain-text body of the email. Legitimately empty when the
   *  sender sends subject-only or attachments-only — don't require
   *  non-empty, just non-null. */
  @IsString()
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

  /**
   * True when this message is machine-generated — a vacation
   * responder, a mailing-list digest, a bounce / DSN, or anything
   * else that shouldn't trigger our automation engine. Detection
   * surfaces at ingest time by inspecting RFC 3834 (`Auto-Submitted`),
   * RFC 2076 (`Precedence: bulk|list|junk|auto_reply`), the DSN
   * content type (`multipart/report; report-type=delivery-status`),
   * common no-reply / mailer-daemon local-parts, and Outlook's
   * `X-Auto-Response-Suppress`.
   *
   * Set TRUE → the message is still persisted on the ticket (so
   * admins see the bounce / autoresponse in the thread) but
   * MESSAGE_RECEIVED / TICKET_CREATED automation events are NOT
   * emitted. This is the primary brake on auto-reply loops
   * (ticket #1768, 2026-10-22).
   */
  @IsOptional()
  @IsBoolean()
  isAutoSubmitted?: boolean;
}
