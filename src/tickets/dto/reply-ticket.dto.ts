import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One outbound-reply attachment reference. The FE uploads each file
 * via POST /tickets/:id/attachments/upload first, gets back the S3
 * metadata, then hands the storage descriptors here when it fires
 * the reply. Keeping upload separate from send lets the composer
 * show a list of pending attachments the agent can remove before
 * hitting Send.
 */
export class ReplyAttachmentRef {
  /** S3 object key returned by the upload endpoint. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  storageKey!: string;

  /** Public HTTPS URL returned by the upload endpoint. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  storageUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contentType!: string;

  @IsInt()
  @Min(0)
  @Max(50 * 1024 * 1024)
  sizeBytes!: number;
}

/**
 * Payload for POST /tickets/:id/reply. `body` is the only required
 * field. CC / BCC each cap at 20 recipients (SMTP servers commonly
 * enforce ~50 total; keeping our own cap tight prevents fat-finger
 * blasts). Attachments cap at 10 per reply.
 */
export class ReplyTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  bodyHtml?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsEmail({}, { each: true })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsEmail({}, { each: true })
  bcc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ReplyAttachmentRef)
  attachments?: ReplyAttachmentRef[];
}
