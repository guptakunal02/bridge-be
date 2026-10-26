import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerSource } from '../database/enums';
import { Customer } from './entities/customer.entity';

export interface UpsertRow {
  phone: string;
  name: string | null;
  email: string | null;
}

export interface UpsertBatchResult {
  /**
   * IDs of every customer row that participated in this batch,
   * aligned 1:1 with the input `rows` in order. Used by the CSV
   * worker to then issue the segment-membership insert in bulk.
   */
  ids: string[];
  insertedCount: number;
  updatedCount: number;
}

/**
 * CRUD + bulk-import operations on Customer. The CSV upload worker
 * calls `upsertBatch` once per 1,000-row chunk, which is why that
 * method is written as a single INSERT ... ON CONFLICT round-trip
 * (one query per 1,000 rows instead of 1,000 queries per batch).
 *
 * `marketing_opted_out` is treated as sacred: the upsert path NEVER
 * writes it. A customer who sent STOP yesterday keeps opted_out=
 * true even if a re-upload touches their row today.
 */
@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  /**
   * Canonicalise a phone input to the digits-only form Meta's
   * WhatsApp API emits ("919205241076") — this is the shape every
   * Customer row holds. Strip leading +, strip any non-digit
   * character (common CSV noise: spaces, dashes, parentheses).
   *
   * Deliberately NOT country-code aware; admins ship E.164
   * ("+91…") in CSVs today, inbound webhooks arrive as digits,
   * and this normalisation unifies both. If we ever need to
   * reject implausible numbers we add a length check — not
   * worth the complexity until a real malformed row forces it.
   */
  static normalizePhone(input: string): string {
    return input.replace(/\D/g, '');
  }

  async findByPhone(phone: string): Promise<Customer | null> {
    return this.customers.findOne({
      where: { phone: CustomersService.normalizePhone(phone) },
    });
  }

  /**
   * Idempotently insert a chunk of customers. On conflict (phone),
   * blank name/email on the existing row are back-filled from the
   * incoming row — `COALESCE(customer.col, EXCLUDED.col)`. Nothing
   * else on the row changes. `marketing_opted_out`, `opted_out_at`,
   * and `opted_out_keyword` are untouched by design.
   *
   * The `xmax = 0` postgres trick in RETURNING distinguishes a
   * fresh INSERT from an UPDATE-on-conflict without a second query.
   */
  async upsertBatch(
    rows: UpsertRow[],
    source: CustomerSource,
  ): Promise<UpsertBatchResult> {
    if (rows.length === 0) {
      return { ids: [], insertedCount: 0, updatedCount: 0 };
    }

    const placeholders: string[] = [];
    const params: unknown[] = [];
    rows.forEach((row, i) => {
      const base = i * 4;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`,
      );
      params.push(
        CustomersService.normalizePhone(row.phone),
        row.name,
        row.email,
        source,
      );
    });

    const sql = `
      INSERT INTO customer (phone, name, email, source)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (phone) DO UPDATE SET
        name = COALESCE(customer.name, EXCLUDED.name),
        email = COALESCE(customer.email, EXCLUDED.email),
        "updatedAt" = NOW()
      RETURNING id, phone, (xmax = 0) AS inserted;
    `;

    const results: Array<{ id: string; phone: string; inserted: boolean }> =
      await this.customers.query(sql, params);

    // Align results back to the input order; INSERT RETURNING can
    // reorder rows under concurrent conflict resolution, so build
    // a phone→id map and pull in input order.
    const byPhone = new Map(results.map((r) => [r.phone, r]));
    const ids = rows.map(
      (r) => byPhone.get(CustomersService.normalizePhone(r.phone))!.id,
    );
    const insertedCount = results.filter((r) => r.inserted).length;
    const updatedCount = results.length - insertedCount;

    return { ids, insertedCount, updatedCount };
  }

  async countOptedOut(): Promise<number> {
    return this.customers.count({ where: { marketing_opted_out: true } });
  }

  async listOptedOut(
    limit: number,
    offset: number,
  ): Promise<{ rows: Customer[]; total: number }> {
    const [rows, total] = await this.customers.findAndCount({
      where: { marketing_opted_out: true },
      order: { opted_out_at: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { rows, total };
  }

  /**
   * Idempotent opt-out application. Called by the inbound STOP
   * handler on a phone we may or may not have seen before — if
   * the number is unknown we create a Customer row from scratch
   * (source WHATSAPP_INBOUND) so the opt-out is preserved; if the
   * number is known we flip the flag + stamp the keyword without
   * disturbing name/email.
   *
   * No-op when the customer is already opted out — returns the
   * existing row so the caller can short-circuit the auto-reply
   * if it wants to (we don't; sending twice is harmless and keeps
   * the admin from fielding "did my STOP work?" questions).
   */
  async applyOptOut(
    phone: string,
    keyword: string,
  ): Promise<Customer> {
    const normalised = CustomersService.normalizePhone(phone);
    const existing = await this.customers.findOne({
      where: { phone: normalised },
    });
    if (existing) {
      if (!existing.marketing_opted_out) {
        existing.marketing_opted_out = true;
        existing.opted_out_at = new Date();
        existing.opted_out_keyword = keyword;
        await this.customers.save(existing);
      }
      return existing;
    }

    const created = this.customers.create({
      phone: normalised,
      name: null,
      email: null,
      source: CustomerSource.WHATSAPP_INBOUND,
      marketing_opted_out: true,
      opted_out_at: new Date(),
      opted_out_keyword: keyword,
    });
    return this.customers.save(created);
  }
}
