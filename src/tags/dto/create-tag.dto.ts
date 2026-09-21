import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Same shape rule as the DB CHECK constraint: lowercase letters,
 * digits, and dashes. Enforced at both boundaries so a rejected
 * name never reaches the DB and a leaked bypass still can't insert
 * garbage.
 */
export class CreateTagDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[a-z0-9-]+$/, {
    message:
      'Tag name must be lowercase letters, digits, or dashes (e.g. refund-request)',
  })
  name!: string;
}
