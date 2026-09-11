import {
  ArrayNotEmpty,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

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

  /**
   * Gmail Message-ID header. Used as the idempotency key in
   * EmailMessage.external_message_id to dedup replays from the IMAP loop.
   */
  @IsString()
  @IsNotEmpty()
  external_message_id!: string;
}
