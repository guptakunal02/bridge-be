import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Team } from './team.entity';

/**
 * Join table for User ↔ Team. A user can belong to multiple teams —
 * they'll receive tickets routed to any of them, unless a per-team
 * pause is toggled.
 *
 * `paused_in_team` lets an admin pause an individual member from
 * receiving from one team without affecting the same person's
 * membership in other teams.
 */
@Entity({ name: 'team_member' })
export class TeamMember {
  @PrimaryColumn({ type: 'uuid', name: 'team_id' })
  team_id!: string;

  @ManyToOne(() => Team, (t) => t.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'team_id' })
  team!: Team;

  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'boolean', default: false, name: 'paused_in_team' })
  paused_in_team!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
