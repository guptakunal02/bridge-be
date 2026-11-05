/**
 * Exchange an ES auth code for a user access token, inspect what was
 * granted, then attempt phone migration with the ES-granted user token
 * (which may have elevated transfer permissions that the stale System
 * User token lacks).
 *
 * Usage:
 *   pnpm es:exchange <CODE>              # inspect only
 *   pnpm es:exchange <CODE> --migrate    # inspect + try migration
 *
 * Code expires 10 min after FB.login callback, so grab fresh.
 */
import 'dotenv/config';

const CODE = process.argv[2];
const DO_MIGRATE = process.argv.includes('--migrate');

if (!CODE || CODE.startsWith('--')) {
  console.error('Usage: pnpm es:exchange <CODE> [--migrate]');
  process.exit(1);
}

const APP_ID = process.env.WHATSAPP_APP_ID!;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET!;
const DST_WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!;
const PHONE_NUMBER_ID = process.env.NEW_WHATSAPP_PHONE_NUMBER_ID!;
const API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0';

const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

async function hit(method: 'GET' | 'POST', path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function main() {
  console.log('[1/5] Exchange code for user access token...');
  const exch = await hit(
    'GET',
    `/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${CODE}`,
  );
  console.log(`      status ${exch.status}`);
  console.log('      ' + JSON.stringify(exch.body, null, 2).replace(/\n/g, '\n      '));
  if (!exch.ok) {
    console.error('Exchange failed — code may be expired or app credentials wrong.');
    process.exit(1);
  }
  const userToken: string = exch.body.access_token;
  const expiresIn: number = exch.body.expires_in || 0;
  console.log(`      got user token (expires in ${Math.round(expiresIn / 86400)} days)\n`);

  console.log('[2/5] Debug token — what scopes + expiry?');
  const appToken = `${APP_ID}|${APP_SECRET}`;
  const debug = await hit(
    'GET',
    `/debug_token?input_token=${userToken}&access_token=${appToken}`,
  );
  console.log(`      status ${debug.status}`);
  console.log('      ' + JSON.stringify(debug.body, null, 2).replace(/\n/g, '\n      ') + '\n');

  console.log('[3/5] Who am I? (GET /me)');
  const me = await hit('GET', `/me?fields=id,name,email`, undefined, userToken);
  console.log(`      status ${me.status}`);
  console.log('      ' + JSON.stringify(me.body, null, 2).replace(/\n/g, '\n      ') + '\n');

  console.log('[4/5] GET /me/businesses');
  const biz = await hit('GET', `/me/businesses?fields=id,name`, undefined, userToken);
  console.log(`      status ${biz.status}`);
  console.log('      ' + JSON.stringify(biz.body, null, 2).replace(/\n/g, '\n      ') + '\n');

  if (!DO_MIGRATE) {
    console.log('[5/5] SKIPPED migration (re-run with --migrate to try).');
    return;
  }

  console.log('[5/5] Attempting phone migration with USER token...');
  const migrate = await hit(
    'POST',
    `/${DST_WABA_ID}/phone_numbers`,
    { cc: '91', phone_number: '9871681656', migrate_phone_number: true },
    userToken,
  );
  console.log(`      status ${migrate.status}`);
  console.log('      ' + JSON.stringify(migrate.body, null, 2).replace(/\n/g, '\n      '));

  if (migrate.ok) {
    console.log('\n>>> MIGRATION SUCCEEDED with user token!');
    console.log('>>> Now run: pnpm migrate:phone-to-bridge  (just the dry-run to confirm)');
    console.log('>>> Then register: POST /' + PHONE_NUMBER_ID + '/register with your PIN');
  } else {
    console.log('\n>>> Migration with USER token also failed. Need Meta Business Support ticket.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
