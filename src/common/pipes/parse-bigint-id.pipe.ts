import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

/**
 * Route-param pipe for bigint primary keys.
 *
 * NestJS's default `ParseIntPipe` converts through JavaScript's
 * `Number`, which silently loses precision above 2^53 (
 * `Number.MAX_SAFE_INTEGER`). Ticket ids are Postgres bigint —
 * fine now but a real footgun at scale. Keep the value as a string
 * end-to-end and just validate the shape.
 *
 * Rules:
 *   - non-empty
 *   - digits only, no leading zeros
 *   - <= 19 digits (bigint max = 9,223,372,036,854,775,807)
 */
@Injectable()
export class ParseBigintIdPipe implements PipeTransform<string, string> {
  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) {
      throw new BadRequestException('Invalid id');
    }
    return value;
  }
}
