import {
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Payload for POST /broadcasts. Admin picks a segment + a MARKETING
 * template; service validates that template.variables ⊆
 * segment.mapped_fields before snapshotting recipients.
 */
export class CreateBroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsUUID()
  segmentId!: string;

  @IsUUID()
  templateId!: string;

  /** When to start the send. ISO-8601 timestamp. Omit for "start on explicit click." */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  /**
   * Per-recipient retry policy. V1 defaults (3 tries over 60 min)
   * are tuned for marketing; admin can tighten (1 try, 10 min) for
   * a time-sensitive flash sale or loosen for a reliable push.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxTries?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  retryWindowMinutes?: number;

  /** Override the template's sample header image for this campaign. */
  @IsOptional()
  @IsUrl({ require_tld: true, require_protocol: true })
  headerImageUrlOverride?: string;

  /**
   * Per-message bid multiplier applied against the template's
   * max-price `bid_amount`. Meta's bid_spec accepts 0.1–10 at send
   * time; 1.0 is unchanged. Omit (or send 1.0) for "use the
   * template's bid as-is."
   */
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  perMessageBidMultiplier?: number;
}
