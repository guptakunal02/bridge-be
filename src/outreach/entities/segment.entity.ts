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

  /**
   * Which of the 5 Customer fields were actually mapped from the
   * uploaded CSV. Always includes `country_code` + `phone_number`
   * (mandatory at mapping time); may additionally include any of
   * `first_name`, `last_name`, `email` depending on what the admin
   * chose.
   *
   * Phase-3 broadcast validates that every variable referenced by
   * the chosen MARKETING template (`{{first_name}}` etc.) is
   * present in this array — otherwise rejects with a clear error
   * ("template uses {{first_name}} but this segment didn't map
   * first_name"). The mapping is captured once per segment on
   * first upload; subsequent re-uploads to the same segment must
   * use the same mapping (service enforces).
   */
  @Column({
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
    name: 'mapped_fields',
  })
  mappedFields!: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
