import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Shape of the body on POST /webhooks/lens, locked by the Lens-side
 * contract (see Lens's deploy handoff doc):
 *
 *   topic       — 'ndr' | 'npr'. Future topics (e.g. 'rto') land as
 *                 enum additions on both sides.
 *   event_id    — Lens's stable idempotency key — reused from the
 *                 LimeChat idempotency key — so retries from either
 *                 side land on the same row via our UNIQUE constraint.
 *   received_at — ISO 8601 timestamp when Lens processed the scan.
 *                 Optional; we fall back to the DB default when absent.
 *   payload     — Raw passthrough from Lens (post-Clickpost parsing).
 *                 Admins bind to arbitrary JSON paths in the automation
 *                 editor.
 */
export class LensEventDto {
  @IsString()
  @IsIn(['ndr', 'npr'])
  topic!: 'ndr' | 'npr';

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  event_id!: string;

  @IsOptional()
  @IsString()
  received_at?: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
