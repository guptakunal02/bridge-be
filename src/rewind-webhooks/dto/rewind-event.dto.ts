import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Shape of the body on POST /webhooks/rewind. Identical to
 * CustomEventDto's shape — the Rewind integration email went out with
 * this exact body contract (event / customerPhone / channelId /
 * variables? / rawPayload?), so the DTO mirrors it key-for-key. The
 * dedicated endpoint exists so Rewind traffic gets its own audit
 * table + its own typed automation trigger, not because the body
 * shape differs.
 *
 *   event         — Rewind event name as the caller picked
 *                   ("rewind.points_earned",
 *                    "rewind.subscription_cancelled", etc). Admin
 *                   rules match on this via `event.eventType`.
 *   variables     — Optional key/value map used to fill WhatsApp
 *                   template positional variables. Each sender has
 *                   their own schema; template handler tolerates
 *                   missing keys (falls back to template defaults).
 *   customerPhone — Target wa_id for the template. Required because
 *                   webhook sends are ticketless; no customer context
 *                   to infer.
 *   channelId     — Which WhatsApp channel to send from.
 *   rawPayload    — Full Rewind event body for JSON-path variable
 *                   binding at template-send time. Optional.
 */
export class RewindEventDto {
  @IsString()
  @MaxLength(128)
  event!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string | number | boolean>;

  @IsString()
  @MaxLength(32)
  customerPhone!: string;

  /**
   * Optional. Rewind doesn't know Bridge's internal channel UUIDs;
   * when absent, the downstream send handler falls back to each
   * matched template's own bound channel — same convention Shopify /
   * Clickpost custom-sends use.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  channelId?: string;

  @IsOptional()
  @IsObject()
  rawPayload?: Record<string, unknown>;

  /**
   * Pass-through fields Rewind puts at the top of the body (their
   * internal event id + event key). Declared so the whitelist
   * ValidationPipe accepts the payload; we read nothing from them
   * directly — dedup/idempotency uses sha256 of the full body.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  key?: string;
}
