import { IsDateString, IsOptional } from 'class-validator';

/**
 * Query for GET /tickets/me/resolved-count. Both bounds are OPTIONAL;
 * when either is missing the service falls back to "today in IST"
 * (same as the legacy `resolvedTodayByMe` on myStats). Values are
 * IST calendar dates — YYYY-MM-DD — not full timestamps. The service
 * expands them to an [from 00:00 IST, (to + 1) 00:00 IST) half-open
 * window so a user picking "Nov 3 – Nov 5" gets all three days
 * inclusively.
 *
 * If `from > to`, the service swaps them silently so a user who
 * clicks the end date first and the start date second still gets a
 * sane range. The UI relies on this swap being transparent.
 */
export class ResolvedCountQuery {
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    { message: 'from must be a YYYY-MM-DD date' },
  )
  from?: string;

  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    { message: 'to must be a YYYY-MM-DD date' },
  )
  to?: string;
}
