import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Key/value store for workspace-level knobs an admin can flip
 * without a deploy. Deliberately not typed per row — every value
 * is stored as text and interpreted by the reading service, so we
 * don't need a migration each time a new setting is added.
 *
 * Known keys today (see AppSettingsService for canonical names):
 *   - resolved_reopen_window_hours: integer; when a customer replies
 *     to a RESOLVED ticket within this window (in hours), the same
 *     ticket is reopened rather than spawning a new one.
 */
@Entity({ name: 'app_setting' })
export class AppSetting {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
