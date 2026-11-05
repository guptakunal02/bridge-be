/**
 * Emergency rollback: move +91 98716 81656 BACK from Surma Bridge WABA
 * (WHATSAPP_BUSINESS_ACCOUNT_ID) to Surma_Limechat_Netcore WABA
 * (1962688541113164) and re-register with PIN.
 *
 * Use only if migrate-phone-to-bridge-waba.ts succeeded but sends via
 * Bridge fail, OR customer comms break in some unexpected way.
 *
 * Caveat: LimeChat's send pipeline may or may not auto-resume after
 * rollback depending on their internal state. Open a LimeChat support
 * ticket in parallel if you hit this path.
 *
 * Run:
 *   pnpm rollback:phone-to-netcore              # dry run (default)
 *   pnpm rollback:phone-to-netcore --apply      # actually execute
 */
import 'dotenv/config';

const DRY_RUN = !process.argv.includes('--apply');

const DST_WABA_ID = '1962688541113164'; // Surma_Limechat_Netcore (rolling BACK to this)
const SRC_WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!; // Surma Bridge (moving OUT of this)
// Production phone +91 98716 81656 — same ID as the forward migration.
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
  requireEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', SRC_WABA_ID);
  requireEnv('NEW_WHATSAPP_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
  requireEnv('WHATSAPP_ACCESS_TOKEN', TOKEN);
  requireEnv('WHATSAPP_CLOUD_API_PIN', PIN);

  console.log(`[config] ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
  console.log(`[config] Moving FROM Bridge WABA:  ${SRC_WABA_ID}`);
  console.log(`[config] Moving BACK TO Netcore:   ${DST_WABA_ID}`);
  console.log(`[config] Phone Number ID:          ${PHONE_NUMBER_ID}`);
  console.log(`[config] Phone:                    +${COUNTRY_CODE} ${PHONE_NUMBER}`);

  await readPhoneOwner('before');

  if (DRY_RUN) {
    console.log('\n[dry-run] Would POST rollback migration:');
    console.log(`  POST /${DST_WABA_ID}/phone_numbers`);
    console.log(`  body: ${JSON.stringify({
      cc: COUNTRY_CODE,
      phone_number: PHONE_NUMBER,
      migrate_phone_number: true,
    })}`);
    console.log(`\n[dry-run] Would POST register:`);
    console.log(`  POST /${PHONE_NUMBER_ID}/register`);
    console.log(`\n[dry-run] Re-run with --apply to execute.`);
    return;
  }

  console.log('\n[step 1/2] Migrating phone BACK to Netcore WABA...');
  const migrate = await graphRequest('POST', `/${DST_WABA_ID}/phone_numbers`, {
    cc: COUNTRY_CODE,
    phone_number: PHONE_NUMBER,
    migrate_phone_number: true,
  });
  console.log(`[step 1/2] Status ${migrate.status}`);
  console.log(JSON.stringify(migrate.body, null, 2));
  if (!migrate.ok) {
    console.error('[step 1/2] ROLLBACK MIGRATION FAILED.');
    process.exit(1);
  }

  await readPhoneOwner('after rollback migrate');

  console.log('\n[step 2/2] Registering on Cloud API...');
  const register = await graphRequest('POST', `/${PHONE_NUMBER_ID}/register`, {
    messaging_product: 'whatsapp',
    pin: PIN,
  });
  console.log(`[step 2/2] Status ${register.status}`);
  console.log(JSON.stringify(register.body, null, 2));

  console.log('\n[done] Rollback complete. Verify LimeChat has auto-resumed by');
  console.log('       checking message deliveries on Surma_Limechat_Netcore WABA.');
  console.log('       If not, contact LimeChat support with Phone Number ID');
  console.log(`       ${PHONE_NUMBER_ID} and request they re-provision.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
