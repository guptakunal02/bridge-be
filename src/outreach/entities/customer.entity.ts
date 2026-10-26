import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CustomerSource } from '../../database/enums';

/**
 * The marketing-side person-of-interest. One row per phone number;
 * the inbox / ticket world keeps using phone-number-strings-on-
 * Ticket as before (no FK to Customer) so this table can be
 * populated or wiped without touching the conversation history.
 *
 * `phone` is stored exactly as the admin's CSV supplied it after
 * E.164 normalisation (`+91XXXXXXXXXX`); dedup is phone-only.
 *
 * `marketing_opted_out` is the single source of truth for
 * compliance filtering at broadcast send time. It is NEVER cleared
 * by a CSV re-upload — a customer who sent STOP yesterday will
 * still read opted_out=true even if an admin re-imports the same
 * phone tomorrow. The only paths that flip it to false are an
 * explicit admin override (future) or an inbound START message.
 */
@Entity({ name: 'customer' })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  phone!: string;

  /**
   * Country code portion of the phone, e.g. "91" for India.
   * Nullable because:
   *   * STOP-handler-created rows arrive from Meta's webhook as a
   *     digits-only `from` field — we assume "91" during backfill
   *     but future webhook sources (international numbers) may
   *     leave this NULL until re-identified via CSV upload.
   *   * Phase-3 broadcast filters out marketing_opted_out=false
   *     rows regardless of country_code; a NULL doesn't affect
   *     send eligibility, only display.
   */
  @Column({ type: 'text', nullable: true, name: 'country_code' })
  countryCode!: string | null;

  /**
   * Phone number without the country-code prefix. Mirror field of
   * `phone` (which stays the dedup key as the full combined form).
   * See the migration for the backfill heuristic.
   */
  @Column({ type: 'text', nullable: true, name: 'phone_number' })
  phoneNumber!: string | null;

  @Column({ type: 'text', nullable: true, name: 'first_name' })
  firstName!: string | null;

  @Column({ type: 'text', nullable: true, name: 'last_name' })
  lastName!: string | null;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'enum', enum: CustomerSource, default: CustomerSource.CSV })
  source!: CustomerSource;

  @Column({ type: 'text', nullable: true, name: 'shopify_customer_id' })
  shopify_customer_id!: string | null;

  @Column({ type: 'boolean', default: false, name: 'marketing_opted_out' })
  marketing_opted_out!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'opted_out_at' })
  opted_out_at!: Date | null;

  /**
   * Which configured OptOutAutomation keyword actually triggered
   * the opt-out, captured verbatim from the inbound message after
   * normalisation. Useful later for admin-side diagnostics ("most
   * customers unsubscribe via <keyword>") and for debugging a
   * keyword that turns out to be too greedy.
   */
  @Column({ type: 'text', nullable: true, name: 'opted_out_keyword' })
  opted_out_keyword!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
