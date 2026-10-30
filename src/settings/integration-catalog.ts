import type { IntegrationPlatform } from './settings.controller';

/**
 * Static catalog of outbound HTTP calls Bridge makes PER integration
 * platform. Rendered on the Integrations page under each card so an
 * admin (or a future-us) can see at a glance "which API endpoints are
 * we hitting, why, and what env vars gate them".
 *
 * This is deliberately hand-authored, not derived from runtime
 * instrumentation. The purpose is documentary — the moment we add a
 * new outbound call, we also add it here (one grep away from the
 * fetch site). Keeping it adjacent to the controller means the single
 * source of truth is in BE code, not duplicated on the FE.
 */
export interface ApiCallCatalogEntry {
  /** HTTP method. Shown as a pill in the UI. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path or URL shape. Query params may be ellipsised for readability. */
  path: string;
  /** One-line human summary of what the call does + where/when. */
  purpose: string;
  /** Env vars whose absence would disable this call (soft-off) or
   *  cause a boot-time validation failure (hard-off). Shown as pills. */
  envVars: string[];
}

/**
 * The catalog, keyed by platform. `whatsapp` is the heaviest surface
 * because Bridge is fundamentally a WhatsApp CRM; shopify / clickpost
 * are empty because those platforms only PUSH to Bridge, Bridge never
 * calls them directly (reads go through Lens / surma-ops).
 */
export const INTEGRATION_API_CALLS: Record<
  IntegrationPlatform,
  ApiCallCatalogEntry[]
> = {
  shopify: [],
  returnprime: [],
  clickpost: [],
  lens: [
    {
      method: 'GET',
      path: '/api/products/image?sku={SKU}',
      purpose:
        "Enriches each incoming orders/create webhook with the first line-item's CDN image URL (used by template headers). Loopback call to surma-ops. Falls back silently if the SKU is unknown or surma-ops is down.",
      envVars: ['LENS_PRODUCT_IMAGE_URL', 'LENS_INTERNAL_SECRET'],
    },
    {
      method: 'GET',
      path: '/api/orders/{order_name}/fulfillment-context?fulfillment_id={id}',
      purpose:
        'Detects split-shipment partials on each fulfillments/create webhook — surma-ops is the oracle for the Split_shipment tag + fulfillment count. Drives the shopify.order.partially_fulfilled automation event.',
      envVars: ['LENS_FULFILLMENT_CONTEXT_URL', 'LENS_INTERNAL_SECRET'],
    },
  ],
  whatsapp: [
    {
      method: 'POST',
      path: '/{phone_number_id}/messages',
      purpose:
        'Send a WhatsApp message — text reply, template send, interactive button payload. Hit on every outbound send from inbox agents, broadcasts, and automation actions.',
      envVars: [
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_GRAPH_API_VERSION',
      ],
    },
    {
      method: 'POST',
      path: '/{phone_number_id}/media',
      purpose:
        'Upload a binary file (image / video / document) directly to the phone number for inline media sends.',
      envVars: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'GET',
      path: '/{media_id}',
      purpose:
        'Resolve a signed download URL for inbound media (customer sent us an image / audio / document). Step 1 of the two-step Meta media fetch; step 2 is a GET on the signed URL for the bytes.',
      envVars: ['WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'GET',
      path: '/{waba_id}/message_templates?limit=200',
      purpose:
        'List + sync approved templates from Meta into Bridge\'s whatsapp_template table. Runs on template-authoring page loads and on broadcast setup.',
      envVars: ['WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'POST',
      path: '/{waba_id}/message_templates',
      purpose:
        'Submit a newly-authored template to Meta for approval (admin → Templates → Create). Payload includes header / body / footer / buttons + max-price optimization spec where set.',
      envVars: ['WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'POST',
      path: '/{app_id}/uploads',
      purpose:
        'Start a Meta Resumable Upload session for a template header image. The returned upload id is pushed as a handle on the template submit.',
      envVars: ['WHATSAPP_APP_ID', 'WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'POST',
      path: '/{upload_id}',
      purpose:
        'Push the image bytes to the Resumable Upload session (single chunk, file_offset=0). Uses Meta\'s "Authorization: OAuth" quirk, not Bearer.',
      envVars: ['WHATSAPP_ACCESS_TOKEN'],
    },
    {
      method: 'GET',
      path: '/{waba_id}/reachestimate?targeting_spec=…&date_interval=…',
      purpose:
        'Fetch Meta\'s reach estimate for a MARKETING template at a given max-price. Drives the slider in the broadcast + template-authoring UIs.',
      envVars: ['WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN'],
    },
  ],
};

/**
 * Static catalog of inbound webhook topics PER platform where we don't
 * have a dedicated audit table (whatsapp today). For audited platforms,
 * the real stats come from each service's `topicStats()`; this constant
 * is only consulted when the DB has nothing to say.
 */
export interface WebhookTopicCatalogEntry {
  topic: string;
  purpose: string;
}

export const INTEGRATION_WEBHOOK_TOPICS: Record<
  IntegrationPlatform,
  WebhookTopicCatalogEntry[]
> = {
  shopify: [],
  returnprime: [],
  clickpost: [],
  lens: [],
  whatsapp: [
    {
      topic: 'messages',
      purpose:
        'Inbound customer messages (text / media / location / interactive button replies). Lands in Bridge inbox as a new ticket or appended to an existing thread.',
    },
    {
      topic: 'statuses',
      purpose:
        'Delivery lifecycle updates for messages Bridge has sent — sent → delivered → read → failed. Powers the broadcast analytics + per-message delivery indicators.',
    },
    {
      topic: 'message_template_status_update',
      purpose:
        'Template approval lifecycle from Meta — PENDING / APPROVED / REJECTED / DISABLED. Keeps whatsapp_template.status in sync so authors see verdicts without manually re-syncing.',
    },
  ],
};
