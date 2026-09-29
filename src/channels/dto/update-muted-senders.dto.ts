import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/**
 * Replaces the channel's muted-senders list wholesale. Small array
 * semantics (< a few dozen entries) so PATCHing diffs would be more
 * complexity than the payload is worth; the FE sends the new list
 * and the BE normalises + persists.
 */
export class UpdateMutedSendersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  patterns!: string[];
}
