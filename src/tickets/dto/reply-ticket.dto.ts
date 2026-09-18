import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for POST /tickets/:id/reply. Only the plain-text `body` is
 * required — HTML is optional and, if supplied, the outbound mail
 * carries both parts so the recipient's MUA picks the best it can
 * render.
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
}
