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

  /**
   * Cap on this member's concurrently-OPEN tickets in this team.
   * Only OPEN tickets count — WAITING / IN_FOLLOWUP free the slot,
   * which is what lets the queue keep flowing to the agent. Set at
   * the (team, user) level so the same agent can carry different
   * loads across teams they belong to.
   */
  @Column({
    type: 'integer',
    default: 5,
    name: 'max_concurrent_tickets',
  })
  max_concurrent_tickets!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
