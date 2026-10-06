import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for POST /tickets/:id/notes. Plain text only in V1 — no
 * markdown, no attachments, no mentions. Cap at 20k chars so one
 * note doesn't swallow the whole conversation panel.
 */
export class CreateTicketNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body!: string;
}
