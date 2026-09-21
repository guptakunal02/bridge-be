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

  /**
   * Runs a callback inside a single connection + transaction, so
   * `SET LOCAL` settings (statement_timeout, work_mem, etc.) stick
   * for the duration and reset automatically on commit.
   *
   * The callback receives a query helper that carries the same
   * read-only sniffer as the top-level `query()`. Callers use this
   * for costed reads on the ops DB where an unbounded scan would be
   * a real problem — statement_timeout there fails the query with a
   * clean error instead of hanging the caller.
   */
  async transactional<T = Record<string, unknown>>(
    fn: (
      q: (sql: string, params?: unknown[]) => Promise<T[]>,
    ) => Promise<T[]>,
  ): Promise<T[]> {
    return this.ds.transaction(async (mgr) => {
      const q = async (sql: string, params: unknown[] = []): Promise<T[]> => {
        assertReadOnly(sql);
        const rows: unknown = await mgr.query(sql, params);
        return rows as T[];
      };
      return fn(q);
    });
  }
}

const READ_STARTERS = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'VALUES',
  // Session-scoped configuration commands that don't mutate data —
  // safe inside a read-only txn and used by callers to add a
  // statement_timeout guardrail before an expensive scan.
  'SET',
]);

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
