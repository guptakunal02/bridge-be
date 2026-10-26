import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CustomerUploadStatus } from '../../database/enums';

/**
 * Durable job record for a single CSV upload. The HTTP controller
 * returns {uploadId} immediately, kicks off a background worker
 * via setImmediate, and the frontend polls GET /segments/:id/
 * uploads/:uid to render progress. Everything the admin needs to
 * reason about a given upload lives here — no separate audit log.
 *
 * Counters are updated per 1,000-row batch, so a 200k upload
 * produces ~200 row-updates per job — well within Postgres write
 * budget. The frontend's 3-second poll interval surfaces that
 * progress at near-real time.
 *
 * `rejections` is a bounded array (first 100 rejections only, see
 * worker). Keeps the row small; a full export can be added later
 * if customers push for it.
 */
@Entity({ name: 'customer_upload' })
export class CustomerUpload {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'segment_id' })
  segment_id!: string;

  @Column({ type: 'uuid', name: 'uploaded_by' })
  uploaded_by!: string;

  @Column({ type: 'text', name: 'file_name' })
  file_name!: string;

  @Column({ type: 'bigint', name: 'file_size' })
  file_size!: string;

  @Column({
    type: 'enum',
    enum: CustomerUploadStatus,
    default: CustomerUploadStatus.PENDING,
  })
  status!: CustomerUploadStatus;

  @Column({ type: 'integer', default: 0, name: 'total_rows' })
  total_rows!: number;

  @Column({ type: 'integer', default: 0, name: 'processed_rows' })
  processed_rows!: number;

  /**
   * Rows that resulted in a fresh customer being created OR an
   * existing customer's blank name/email being filled in.
   */
  @Column({ type: 'integer', default: 0, name: 'succeeded_rows' })
  succeeded_rows!: number;

  /**
   * Rows whose phone was already a known customer AND nothing on
   * the Customer row changed (same name/email or those columns
   * already populated). Also counts rows added to the segment
   * that were already members — nothing to do.
   */
  @Column({ type: 'integer', default: 0, name: 'skipped_rows' })
  skipped_rows!: number;

  @Column({ type: 'integer', default: 0, name: 'rejected_rows' })
  rejected_rows!: number;

  @Column({
    type: 'jsonb',
    default: () => `'[]'::jsonb`,
  })
  rejections!: Array<{ line: number; reason: string }>;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;
}
