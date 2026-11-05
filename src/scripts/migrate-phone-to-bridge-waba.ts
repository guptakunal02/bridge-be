/**
 * One-shot: migrate +91 98716 81656 from the Surma_Limechat_Netcore WABA
 * (1962688541113164) into the Surma Bridge WABA (WHATSAPP_BUSINESS_ACCOUNT_ID
 * in .env), then re-register on Cloud API so Bridge can send immediately.
 *
 * Both WABAs live in the same Business Portfolio (966934798063406) so the
 * documented same-BP flow applies — no OTP, no 7-day cooldown, Phone Number
 * ID preserved.
 *
 * Run:
 *   pnpm migrate:phone-to-bridge              # dry run (default)
 *   pnpm migrate:phone-to-bridge --apply      # actually execute
 *
 * Reversible via scripts/rollback-phone-to-netcore-waba.ts.
 */
import 'dotenv/config';

const DRY_RUN = !process.argv.includes('--apply');

const SRC_WABA_ID = '1962688541113164'; // Surma_Limechat_Netcore
const DST_WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!; // Surma Bridge
// Production phone +91 98716 81656 lives here — NOT the test phone.
const PHONE_NUMBER_ID = process.env.NEW_WHATSAPP_PHONE_NUMBER_ID!;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const PIN = process.env.WHATSAPP_CLOUD_API_PIN!;
const API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0';
const COUNTRY_CODE = '91';
const PHONE_NUMBER = '9871681656';

const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

async function graphRequest(method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = `${GRAPH}${path}`;
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function readPhoneOwner(label: string) {
  const r = await graphRequest(
    'GET',
    `/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating`,
  );
  console.log(`\n[${label}] GET /${PHONE_NUMBER_ID} -> ${r.status}`);
  console.log(JSON.stringify(r.body, null, 2));
  return r;
}

async function main() {
  requireEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', DST_WABA_ID);
  requireEnv('NEW_WHATSAPP_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
  requireEnv('WHATSAPP_ACCESS_TOKEN', TOKEN);
  requireEnv('WHATSAPP_CLOUD_API_PIN', PIN);

  console.log(`[config] ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
  console.log(`[config] Source WABA (Netcore): ${SRC_WABA_ID}`);
  console.log(`[config] Target WABA (Bridge):  ${DST_WABA_ID}`);
  console.log(`[config] Phone Number ID:       ${PHONE_NUMBER_ID}`);
  console.log(`[config] Phone:                 +${COUNTRY_CODE} ${PHONE_NUMBER}`);
  console.log(`[config] API version:           ${API_VERSION}`);

  await readPhoneOwner('before');

  if (DRY_RUN) {
    console.log('\n[dry-run] Would fire ATOMIC sequence (no delay between):');
    console.log(`  1. POST /${PHONE_NUMBER_ID}/deregister`);
    console.log(`  2. POST /${DST_WABA_ID}/phone_numbers`);
    console.log(`     body: ${JSON.stringify({ cc: COUNTRY_CODE, phone_number: PHONE_NUMBER, migrate_phone_number: true })}`);
    console.log(`  3. POST /${PHONE_NUMBER_ID}/register`);
    console.log(`     body: {"messaging_product":"whatsapp","pin":"<PIN>"}`);
    console.log('\n[dry-run] Re-run with --apply to execute atomically.');
    console.log('[dry-run] Rationale: LimeChat\'s monitor re-registers the phone within');
    console.log('[dry-run] seconds of deregister. Firing all 3 calls back-to-back wins the race.');
    return;
  }

  const t0 = process.hrtime.bigint();

  console.log('\n[step 1/4] Deregistering phone from current app...');
  const dereg = await graphRequest('POST', `/${PHONE_NUMBER_ID}/deregister`);
  console.log(`[step 1/4] Status ${dereg.status}`);
  console.log(JSON.stringify(dereg.body, null, 2));
  if (!dereg.ok) {
    console.error('[step 1/4] DEREGISTER FAILED — aborting.');
    process.exit(1);
  }

  console.log('\n[step 2/4] Migrating phone to Surma Bridge WABA...');
  const migrate = await graphRequest('POST', `/${DST_WABA_ID}/phone_numbers`, {
    cc: COUNTRY_CODE,
    phone_number: PHONE_NUMBER,
    migrate_phone_number: true,
  });
  console.log(`[step 2/4] Status ${migrate.status}`);
  console.log(JSON.stringify(migrate.body, null, 2));
  if (!migrate.ok) {
    console.error('[step 2/4] MIGRATION FAILED.');
    console.error('           LimeChat\'s monitor may have re-registered already.');
    console.error('           If so, retry — or they beat us. Phone stays on Netcore WABA.');
    process.exit(1);
  }

  console.log('\n[step 3/4] Registering on Cloud API under Bridge app...');
  const register = await graphRequest('POST', `/${PHONE_NUMBER_ID}/register`, {
    messaging_product: 'whatsapp',
    pin: PIN,
  });
  console.log(`[step 3/4] Status ${register.status}`);
  console.log(JSON.stringify(register.body, null, 2));
  if (!register.ok) {
    console.error('[step 3/4] REGISTER FAILED. Phone migrated but not registered.');
    console.error('           Fix manually, or run rollback script.');
    process.exit(1);
  }

  const t1 = process.hrtime.bigint();
  console.log(`\n[step 4/4] Atomic burst completed in ${Number(t1 - t0) / 1_000_000} ms`);

  await readPhoneOwner('after full sequence');

  console.log('\n[step 3/3] Migration + register complete.');
  console.log('           Send a test template to your own number to verify.');
  console.log('           If anything misbehaves, run:');
  console.log('             pnpm rollback:phone-to-netcore --apply');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
