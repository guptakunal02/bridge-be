import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A named bag of Customer references. Membership lives on the
 * SegmentCustomer join table — a customer can belong to many
 * segments, and a segment can be shared across broadcasts.
 *
 * Segment itself is intentionally thin: no filtering rules, no
 * materialised view, no auto-refresh. Phase 1 only supports
 * static CSV-upload segments; dynamic rules ("last ordered in
 * 60 days") land in a later phase, at which point this table
 * grows a nullable `rule` jsonb column (compat with existing
 * static segments).
 *
 * Deliberately no deleted_at — segment deletion is irreversible
 * because broadcasts hold snapshots of recipients at send time;
 * the segment row itself is just metadata.
 */
@Entity({ name: 'segment' })
export class Segment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
