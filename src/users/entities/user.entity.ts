import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole, UserStatus } from '../../database/enums';

@Entity({ name: 'user' })
@Index(['role', 'isApproved', 'deactivatedAt'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true, unique: true })
  googleSub!: string | null;

  @Column({ type: 'text', nullable: true, unique: true })
  email!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', nullable: true })
  photoUrl!: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.MEMBER })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.OFFLINE })
  status!: UserStatus;

  @Column({ type: 'boolean', default: false })
  isApproved!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deactivatedAt!: Date | null;

  // Refresh token lives inline instead of in a separate table.
  // One active session per user — logging in on device B invalidates
  // whatever refresh token device A was holding.
  @Column({ type: 'text', nullable: true })
  refreshTokenHash!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refreshTokenExpiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
