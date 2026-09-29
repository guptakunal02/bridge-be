import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TeamMember } from './team-member.entity';

/**
 * A team is a routing bucket. Every ticket belongs to exactly one
 * team; assignment picks from that team's non-paused Online members.
 *
 * `is_default = true` on exactly one row (constraint enforced by the
 * migration via a partial unique index). Tickets that no routing rule
 * matches land here — MVP always uses the default team since we
 * haven't shipped rules yet.
 */
@Entity({ name: 'team' })
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  is_default!: boolean;

  /** Admin kill-switch — tickets pile up on BOT instead of routing to a live member. */
  @Column({ type: 'boolean', default: false, name: 'assignment_paused' })
  assignment_paused!: boolean;

  /**
   * Routing precedence. Lower value = earlier evaluation. At ingest
   * the router walks teams in priority ASC; the first team with a
   * rule that matches wins the ticket, else it falls through to
   * the default team. Admin reorders via drag on the /teams list.
   */
  @Column({ type: 'integer', default: 1000 })
  priority!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => TeamMember, (m) => m.team)
  members!: TeamMember[];
}
