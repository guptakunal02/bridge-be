import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { Segment } from './entities/segment.entity';
import { SegmentCustomer } from './entities/segment-customer.entity';

export interface SegmentDetail {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  createdAt: Date;
  /** Rows currently joined via segment_customer. */
  totalMembers: number;
  /** Of those, how many will be filtered OUT by broadcast send. */
  optedOutCount: number;
  /** totalMembers − optedOutCount. The "actual" audience size. */
  willReceiveCount: number;
  /**
   * Which of the 5 Customer fields were mapped from the uploaded
   * CSV. Always includes country_code + phone_number; may include
   * first_name, last_name, email. Phase 3 broadcast reads this to
   * refuse templates referencing fields this segment doesn't carry.
   */
  mappedFields: string[];
}

/**
 * Segment lifecycle + membership. The CSV worker is the only
 * caller of `addMembershipsBatch`; everything else is admin UI.
 *
 * Count queries hit segment_customer joined to customer. These
 * three numbers surface prominently in the segment detail page
 * and are the "did my upload actually land" sanity signal — must
 * stay accurate under concurrent writes (the worker is still
 * batching while the admin is already viewing the page).
 */
@Injectable()
export class SegmentsService {
  constructor(
    @InjectRepository(Segment)
    private readonly segments: Repository<Segment>,
    @InjectRepository(SegmentCustomer)
    private readonly memberships: Repository<SegmentCustomer>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  async create(input: {
    name: string;
    description: string | null;
    created_by: string;
  }): Promise<Segment> {
    const row = this.segments.create(input);
    return this.segments.save(row);
  }

  async list(): Promise<Segment[]> {
    return this.segments.find({ order: { createdAt: 'DESC' } });
  }

  async findById(id: string): Promise<Segment> {
    const row = await this.segments.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Segment ${id} not found`);
    return row;
  }

  async getDetail(id: string): Promise<SegmentDetail> {
    const seg = await this.findById(id);
    const counts: Array<{ total: string; opted_out: string }> =
      await this.memberships.query(
        `
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE c.marketing_opted_out)::text AS opted_out
        FROM segment_customer sc
        JOIN customer c ON c.id = sc.customer_id
        WHERE sc.segment_id = $1
      `,
        [id],
      );
    const total = Number(counts[0]?.total ?? 0);
    const optedOut = Number(counts[0]?.opted_out ?? 0);
    return {
      id: seg.id,
      name: seg.name,
      description: seg.description,
      created_by: seg.created_by,
      createdAt: seg.createdAt,
      totalMembers: total,
      optedOutCount: optedOut,
      willReceiveCount: total - optedOut,
      mappedFields: seg.mappedFields,
    };
  }

  /**
   * Overwrites `segment.mapped_fields` with the fields the admin
   * chose on this upload. Called by CustomerUploadService.start.
   * If a second upload later arrives with a different mapping, we
   * take the latest — matches the admin's intuition that uploads
   * refresh the schema.
   */
  async setMappedFields(
    segmentId: string,
    fields: string[],
  ): Promise<void> {
    await this.segments.update({ id: segmentId }, { mappedFields: fields });
  }

  /**
   * Bulk-add membership rows. Composite PK (segment_id, customer_id)
   * on segment_customer gives us idempotency for free — ON CONFLICT
   * DO NOTHING skips re-adds silently. The caller feeds this the IDs
   * returned by CustomersService.upsertBatch.
   */
  async addMembershipsBatch(
    segmentId: string,
    customerIds: string[],
  ): Promise<{ added: number }> {
    if (customerIds.length === 0) return { added: 0 };
    const result: Array<{ count: string }> = await this.memberships.query(
      `
      INSERT INTO segment_customer (segment_id, customer_id)
      SELECT $1, UNNEST($2::uuid[])
      ON CONFLICT DO NOTHING
      RETURNING customer_id
    `,
      [segmentId, customerIds],
    );
    return { added: result.length };
  }

  async listMembers(
    segmentId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: Customer[]; total: number }> {
    // ORDER BY on a column from a joined (not selected) table breaks
    // under TypeORM's take()/skip() pagination: it auto-wraps the
    // query in a DISTINCT subquery, and `sc.added_at` isn't in the
    // inner SELECT (only Customer entity columns are), so Postgres
    // errors with `column distinctAlias.sc_added_at does not exist`.
    // c.createdAt IS a Customer column — included in the inner
    // SELECT — and in practice is virtually identical to added_at
    // (customers are created and joined to a segment in the same
    // transaction, 1k rows apart at most). Fine proxy for "recently
    // added to this segment" without needing a raw-SQL rewrite.
    const [rows, total] = await this.customers
      .createQueryBuilder('c')
      .innerJoin(
        'segment_customer',
        'sc',
        'sc.customer_id = c.id AND sc.segment_id = :segmentId',
        { segmentId },
      )
      .orderBy('c.createdAt', 'DESC')
      .take(limit)
      .skip(offset)
      .getManyAndCount();
    return { rows, total };
  }

  async remove(id: string): Promise<void> {
    const result = await this.segments.delete({ id });
    if (result.affected === 0) {
      throw new NotFoundException(`Segment ${id} not found`);
    }
  }
}
