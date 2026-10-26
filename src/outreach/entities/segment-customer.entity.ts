import {
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * Many-to-many join between Segment and Customer. Composite PK
 * (segment_id, customer_id) enforces idempotent membership — a
 * re-uploaded CSV with the same phone against the same segment is
 * a no-op on this table.
 *
 * Index on customer_id supports the "which segments is this
 * customer in" admin lookup; segment_id scan is already fast via
 * the composite PK prefix.
 */
@Entity({ name: 'segment_customer' })
@Index(['customerId'])
export class SegmentCustomer {
  @PrimaryColumn({ type: 'uuid', name: 'segment_id' })
  segmentId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'added_at' })
  added_at!: Date;
}
