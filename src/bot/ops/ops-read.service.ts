import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OPS_CONNECTION } from '../../database/database.module';

/**
 * Read-only doorway to the surma_common_ops DB.
 *
 * The connection is registered with empty entities and no
 * migrations, but a determined caller could still fire a mutation
 * through raw SQL. Belt-and-braces here: every query passes through
 * a keyword sniffer that rejects any SQL starting with a
 * non-SELECT/WITH verb before it ever hits the wire.
 *
 * That's a code convention, not a DB permission. If you need the
 * hard guarantee, create a dedicated read-only Postgres role and
 * point DATABASE_URL's user at it — this service will still work,
 * and any mutation would fail with a permissions error.
 */
@Injectable()
export class OpsReadService {
  constructor(
    @InjectDataSource(OPS_CONNECTION)
    private readonly ds: DataSource,
  ) {}

  /**
   * Run a parameterised SELECT. Callers pass `$1`, `$2`, … in the SQL
   * and matching values in `params`. The result is untyped by
   * default; call sites cast to a well-defined row shape.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    assertReadOnly(sql);
    // typeorm's .query() returns Promise<any>; the generic T is the
    // contract the caller has just declared, so we route through
    // `unknown` to satisfy no-unsafe-return without adding a second
    // (unnecessary) assertion the linter flags.
    const rows: unknown = await this.ds.query(sql, params);
    return rows as T[];
  }

  /** Convenience for single-row lookups. Returns null when empty. */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
}

const READ_STARTERS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'VALUES']);

/**
 * Reject anything that doesn't obviously start with a read verb.
 * Strips leading whitespace and both line- and block-comment
 * prefixes so a "trailing-comment then DELETE" trick doesn't
 * sneak past the check.
 */
function assertReadOnly(sql: string): void {
  const cleaned = stripLeadingCommentsAndWhitespace(sql).toUpperCase();
  const firstWord = cleaned.split(/[^A-Z]/)[0] ?? '';
  if (!READ_STARTERS.has(firstWord)) {
    throw new BadRequestException(
      `OpsReadService rejects non-read SQL (first word: "${firstWord || '(empty)'}"). This connection is read-only.`,
    );
  }
}

function stripLeadingCommentsAndWhitespace(sql: string): string {
  let s = sql.trim();
  while (true) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trim();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trim();
    } else {
      break;
    }
  }
  return s;
}
