import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A canonical tag admins have registered. The `ticket.tags text[]`
 * column continues to store per-ticket tag lists; this table is the
 * source of truth for which names are allowed on new tags being
 * added.
 */
@Entity({ name: 'tag' })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
