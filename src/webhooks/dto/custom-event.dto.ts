import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Shape of the body on POST /webhooks/custom-events.
 *
 *   event         — Freeform event name the sender picked
 *                   (e.g. "order.confirmed", "shipment.out_for_delivery").
 *                   Rules match on this via a condition on `event.name`.
 *   variables     — Key/value map used to fill WhatsApp template
 *                   positional variables. Values can be string /
 *                   number / boolean; stringified at template-send
 *                   time. Optional — not every event has variables.
 *   customerPhone — Target wa_id for the template. Required because
 *                   webhook sends are ticketless; there's no customer
 *                   context to infer from.
 *   channelId     — Which WhatsApp channel to send from. Required for
 *                   the same reason.
 *
 * We DELIBERATELY don't declare the shape of `variables` strictly —
 * each sender has their own schema, and locking it would need an
 * admin-authored event registry. Trade-off accepted for V1; the
 * template-send handler reads values by mapping name at execution
 * time and tolerates missing keys (falls back to the template's
 * stored fallback string).
 */
export class CustomEventDto {
  @IsString()
  @MaxLength(128)
  event!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string | number | boolean>;

  @IsString()
  @MaxLength(32)
  customerPhone!: string;

  @IsString()
  @MaxLength(64)
  channelId!: string;

  /**
   * Phase 4 — full raw event JSON. When present, send_whatsapp_template
   * actions with variable_bindings resolve JSON paths against this
   * object. Optional for backward compat; pre-Phase-4 callers can
   * continue sending only `variables` and omit this.
   */
  @IsOptional()
  @IsObject()
  rawPayload?: Record<string, unknown>;
}
