import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  /**
   * Read-only companion DB — same RDS host / creds as DATABASE_URL,
   * just a different logical database. Bridge NEVER writes here;
   * bot function handlers use it for order / customer lookups.
   */
  @IsString()
  @MinLength(1)
  DB_OPS_NAME!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  FRONTEND_ORIGIN!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(1)
  JWT_ACCESS_TTL!: string;

  @IsString()
  @MinLength(1)
  JWT_REFRESH_TTL!: string;

  // 32 bytes base64-encoded → ~44 chars. AES-256-GCM for at-rest channel creds.
  @IsString()
  @MinLength(40)
  CHANNEL_ENCRYPTION_KEY!: string;

  // Google OAuth 2.0 web client ID (public).
  @IsString()
  @MinLength(1)
  GOOGLE_WEB_CLIENT_ID!: string;

  // Google OAuth 2.0 client secret — used server-side to exchange the auth code.
  @IsString()
  @MinLength(1)
  GOOGLE_CLIENT_SECRET!: string;

  // Absolute URL Google redirects back to after user consent. Must match
  // an Authorized redirect URI registered in the Google Cloud OAuth client.
  @IsUrl({ require_tld: false, require_protocol: true })
  GOOGLE_OAUTH_CALLBACK_URL!: string;

  /**
   * Second Google OAuth client — separate from the sign-in client
   * above because this one requests the mail.google.com scope and
   * has its own redirect URI. Kept apart so the sign-in client
   * stays scoped to userinfo only; a leaked sign-in token can
   * never touch mailbox data.
   */
  @IsString()
  @MinLength(1)
  EMAIL_INBOX_GOOGLE_CLIENT_ID!: string;

  @IsString()
  @MinLength(1)
  EMAIL_INBOX_GOOGLE_CLIENT_SECRET!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  EMAIL_INBOX_GOOGLE_CALLBACK_URL!: string;

  /**
   * S3 credentials + bucket for inbound email attachment storage.
   * The bucket is public-read (see infra runbook), so URLs the app
   * returns are direct https://<bucket>.s3.<region>.amazonaws.com/<key>
   * links — no presigning at read time.
   */
  @IsString()
  @MinLength(16)
  AWS_ACCESS_KEY_ID!: string;

  @IsString()
  @MinLength(1)
  AWS_SECRET_ACCESS_KEY!: string;

  @IsString()
  @MinLength(1)
  AWS_REGION!: string;

  @IsString()
  @MinLength(1)
  S3_ATTACHMENTS_BUCKET!: string;

  /**
   * WhatsApp Business Platform Cloud API credentials. All seven are
   * REQUIRED — missing any one makes the webhook / send flows
   * unusable, so we fail fast at boot instead of lazy-detecting
   * halfway through processing an inbound message.
   */
  @IsString()
  @MinLength(10)
  WHATSAPP_PHONE_NUMBER_ID!: string;

  @IsString()
  @MinLength(10)
  WHATSAPP_BUSINESS_ACCOUNT_ID!: string;

  @IsString()
  @MinLength(50)
  WHATSAPP_ACCESS_TOKEN!: string;

  @IsString()
  @MinLength(10)
  WHATSAPP_APP_ID!: string;

  @IsString()
  @MinLength(16)
  WHATSAPP_APP_SECRET!: string;

  // Pinned Graph API version — change here when Meta deprecates ours.
  @IsString()
  @MinLength(3)
  WHATSAPP_GRAPH_API_VERSION!: string;

  // Shared secret we hand to Meta on webhook subscription. Meta echoes
  // it back on every verify request; a mismatch means someone forged
  // the request. 32+ chars of random entropy expected.
  @IsString()
  @MinLength(32)
  WHATSAPP_WEBHOOK_VERIFY_TOKEN!: string;

  /**
   * Shopify API secret used to HMAC-sign every webhook. Admin finds
   * this in Shopify Admin → Settings → Notifications → Webhooks →
   * "Signing secret". Stored ONLY here (never in DB) — rotating
   * requires a redeploy. Optional so a dev-mode Bridge without
   * Shopify configured still boots; the Shopify webhook controller
   * returns 503 when the secret is missing, which is distinguishable
   * from a signature mismatch (403).
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  SHOPIFY_WEBHOOK_SECRET?: string;

  /**
   * The connected Shopify store's domain (e.g. `surma.myshopify.com`).
   * Every webhook includes `X-Shopify-Shop-Domain`; we reject
   * requests whose domain doesn't match. Keeps config in one place.
   * Non-secret but kept here for consistency.
   */
  @IsOptional()
  @IsString()
  @MinLength(5)
  SHOPIFY_SHOP_DOMAIN?: string;

  /**
   * Return Prime store access token. Used as the `x-rp-token` header
   * when Bridge calls Return Prime's register-webhook API on the
   * admin's behalf. Not involved in verifying INBOUND webhooks (RP
   * doesn't sign inbound POSTs as of 2026-10-23, per their docs).
   * Optional so a dev-mode Bridge without RP wired up still boots.
   *
   * Name mirrors RP's header spelling (`x-rp-token`) so an admin
   * grepping the .env for RP concepts hits the right line.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  RETURN_PRIME_XRP_TOKEN?: string;

  /**
   * Shared secret between Lens (ops.teev.shop) and Bridge for RP
   * webhook fan-forwarding. RP's own dispatcher drops deliveries to
   * Bridge's subscription (support ticket open), so Lens forwards
   * `request/created` + `request/refunded` to Bridge stamped with
   * `X-Lens-Secret: <this value>`.
   *
   * Validation semantics on the Bridge receiver side:
   *   - unset in env           → guard skips (open endpoint; preserves
   *                              current behaviour for safe dev + for
   *                              the direct-from-RP path if RP ever
   *                              starts delivering again)
   *   - set + header absent    → allow through (direct RP calls won't
   *                              carry this header; treat as RP)
   *   - set + header present   → must match (constant-time); mismatch
   *                              returns 401
   *
   * Rotate: edit on BOTH sides (Lens's forwarder env + here) in the
   * same deploy window to avoid a validation gap.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  LENS_FORWARD_SECRET?: string;

  /**
   * Clickpost webhook authentication key. We generate 32+ chars of
   * random entropy and the admin pastes it into Clickpost's dashboard
   * (Settings → Notifications → Webhooks → auth type: X-Api-Key).
   * Clickpost then stamps every inbound webhook with the configured
   * `X-Api-Key` header; our guard compares (constant-time) against
   * this env value and rejects mismatches as 403.
   *
   * Optional so a dev-mode Bridge without Clickpost configured boots
   * cleanly; the webhook endpoint responds 503 "not configured" until
   * both this and the admin-side dashboard setup are done.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  CLICKPOST_WEBHOOK_API_KEY?: string;

  /**
   * Shared secret for calling surma-ops internal endpoints on the same
   * EC2 box (currently: GET /api/products/image?sku=X for enriching
   * Shopify order webhooks with the first product's CDN image URL).
   *
   * Same shared-secret value lives on surma-ops as
   * SHOPIFY_WEBHOOK_INTERNAL_SECRET; we send it as
   * `X-Internal-Secret: <value>`. Optional so a dev Bridge without
   * surma-ops reachable still boots — the Shopify enrichment hop
   * silently skips when this isn't set and the webhook controller
   * emits the automation event with no `enrichments.*` field (admin's
   * rule then falls back to the template's static sample image).
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  LENS_INTERNAL_SECRET?: string;

  /**
   * Base URL for surma-ops's product-image cache endpoint. Bridge
   * calls `${LENS_PRODUCT_IMAGE_URL}?sku=<SKU>` on `orders/create` to
   * enrich the stored payload with the first line-item's CDN image URL.
   * Same box in prod (loopback) but kept configurable so a staging
   * Bridge can point at a staging surma-ops without a code change.
   *
   * Optional — when unset, Bridge skips the enrichment hop and the
   * admin's automation rule falls back to the template's static
   * header_image_fallback.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  LENS_PRODUCT_IMAGE_URL?: string;

  /**
   * Base URL for surma-ops's fulfillment-context endpoint. Bridge
   * calls `${LENS_FULFILLMENT_CONTEXT_URL}/<order-name>/fulfillment-context?fulfillment_id=<id>`
   * on `fulfillments/create` to detect split-shipment partials
   * (surma-ops has the authoritative current order state including
   * the `Split_shipment` tag that isn't present at orders/create
   * webhook time).
   *
   * Optional — when unset, Bridge still emits the generic
   * shopify.fulfillment.created event; only the derived
   * shopify.order.partially_fulfilled event is skipped.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  LENS_FULFILLMENT_CONTEXT_URL?: string;

  /**
   * Base URL for surma-ops's customer-contact endpoint. Bridge calls
   * `${LENS_CUSTOMER_CONTACT_URL}/<order-name>/customer-contact` to
   * un-mask inbound Clickpost webhooks — Clickpost's enterprise plan
   * redacts customer name / email / phone to "**********" in every
   * payload with no toggle to pass PII through, so we look the real
   * values up from surma-ops's Shopify sync by the order id Clickpost
   * does include (payload.additional.order_id).
   *
   * Optional — when unset, Bridge persists Clickpost webhooks with the
   * masks in place and automation rules on inbound phone will see an
   * empty value.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  LENS_CUSTOMER_CONTACT_URL?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Invalid environment variables:\n${errors.toString()}`);
  }

  return validated;
}
