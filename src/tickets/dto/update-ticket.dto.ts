import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TicketStatus } from '../../database/enums';

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  /**
   * The full set of tags this ticket should carry after the update.
   * Set-semantics (not add/remove): whatever you send replaces what
   * was there. Keeps the API idempotent and the wire format simple.
   *
   * Each tag: 1-40 chars, lowercase letters / digits / dashes only —
   * so `refund-request` is fine, `Refund Request!` is not. Enforcing
   * a stable shape here means routing-rule matches never fail on
   * whitespace or casing quirks.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(40, { each: true })
  @Matches(/^[a-z0-9-]+$/, {
    each: true,
    message:
      'Tags must be lowercase letters, digits, or dashes (e.g. refund-request)',
  })
  tags?: string[];
}
