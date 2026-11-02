/**
 * One-off migration — resubmits every Bridge WhatsApp template to a
 * DIFFERENT WABA (the Surma_Limechat_Netcore one that owns the main
 * number +91 98716 81656), with "bridge_" prefix on the name to avoid
 * colliding with Netcore's existing templates on that WABA.
 *
 * How to run (local, against prod DB):
 *   pnpm republish:templates-to-new-waba              # dry run (default)
 *   pnpm republish:templates-to-new-waba --apply      # actually submit
 *
 * On success, each row:
 *   - name prepended with "bridge_"
 *   - meta_template_id replaced with the new WABA's assigned id
 *   - status reset to PENDING (Meta's approval webhook flips it to
 *     APPROVED when the review completes, same path as normal authoring)
 *
 * Idempotent: skips rows whose name already starts with "bridge_" so
 * re-runs are safe. If Meta's response is 4xx (duplicate name,
 * category mismatch, etc.) the row is left untouched and we move on
 * to the next template.
 *
 * IMAGE headers: downloads the stored S3 image, uploads via Meta's
 * resumable upload API against WHATSAPP_APP_ID, gets a new handle,
 * threads it into the template submission. The old handle is scoped
 * to the previous WABA and would be rejected by Meta's reviewer.
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');
const RATE_LIMIT_MS = 10_000; // 10s between submissions — safe for a cold WABA

interface Button {
  type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
  text: string;
  url?: string;
  phone_number?: string;
  button_id?: string;
}

interface VariableMapping {
  name: string;
  path?: string | null;
  example?: string | null;
  fallback?: string | null;
}

interface Row {
  id: string;
  number: string;
  name: string;
  category: string;
  language: string;
  body: string;
  variable_mapping: VariableMapping[] | null;
  header_type: string;
  header_text: string | null;
  header_media_url: string | null;
  footer_text: string | null;
  buttons: Button[] | null;
  max_price_amount: string | null;
}

/**
 * Mirror of the service's positional-body conversion. Rewrites named
 * placeholders ({{first_name}}) to positional ({{1}}) and returns the
 * ORDERED list of names so we can build Meta's example.body_text in
 * the same positional order the reviewer sees.
 */
function toPositionalBody(
  body: string,
  mapping: VariableMapping[],
): { positional: string; refs: string[] } {
  const refs: string[] = [];
  const seen = new Set<string>();
  const positional = body.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (_, name) => {
    if (!seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
    const idx = refs.indexOf(name) + 1;
    return `{{${idx}}}`;
  });
  // Fall back to pass-through for templates that already use positional
  // {{1}} form (older rows). Mapping names should still align by
  // position in that case.
  if (refs.length === 0) {
    const nums: string[] = [];
    body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
      if (!nums.includes(n)) nums.push(n);
      return _;
    });
    nums.sort((a, b) => Number(a) - Number(b));
    for (const n of nums) {
      const m = mapping[Number(n) - 1];
      refs.push(m?.name ?? `v${n}`);
    }
    return { positional: body, refs };
  }
  return { positional, refs };
}

async function uploadImageToNewWaba(
  imageUrl: string,
  env: {
    appId: string;
    token: string;
    version: string;
  },
): Promise<string> {
  // Download the image to a buffer first (we need Content-Length).
  const dl = await fetch(imageUrl);
  if (!dl.ok) throw new Error(`image download failed: HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  const type = dl.headers.get('content-type') ?? 'image/jpeg';
  // Step 1: start resumable upload session against WHATSAPP_APP_ID.
  const sessionUrl =
    `https://graph.facebook.com/${env.version}/${env.appId}/uploads` +
    `?file_name=header.jpg&file_length=${buf.length}` +
    `&file_type=${encodeURIComponent(type)}`;
  const sess = await fetch(sessionUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}` },
  });
  const sessJson = (await sess.json()) as { id?: string; error?: unknown };
  if (!sess.ok || !sessJson.id) {
    throw new Error(`upload session failed: ${JSON.stringify(sessJson)}`);
  }
  // Step 2: push file bytes to the session, get back the handle `h`.
  const uploadUrl = `https://graph.facebook.com/${env.version}/${sessJson.id}`;
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.token}`,
      'Content-Type': type,
      file_offset: '0',
    },
    body: new Uint8Array(buf),
  });
  const upJson = (await up.json()) as { h?: string; error?: unknown };
  if (!up.ok || !upJson.h) {
    throw new Error(`upload push failed: ${JSON.stringify(upJson)}`);
  }
  return upJson.h;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const wabaId = process.env.NEW_WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const appId = process.env.WHATSAPP_APP_ID;
  const version = process.env.WHATSAPP_GRAPH_API_VERSION ?? 'v22.0';
  if (!dbUrl || !wabaId || !token || !appId) {
    console.error(
      'Missing env — need DATABASE_URL, NEW_WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_ID',
    );
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} republish-templates-to-new-waba ` +
      `(target_waba=${wabaId}, version=${version})`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query<Row>(`
    SELECT id::text, number::text, name, category, language, body,
           variable_mapping, header_type,
           header_text, header_media_url, footer_text, buttons,
           max_price_amount
    FROM whatsapp_template
    WHERE status NOT IN ('REJECTED', 'DISABLED')
      AND name NOT LIKE 'bridge\_%' ESCAPE '\'
    ORDER BY number::int ASC
  `);
  console.log(`\n${rows.length} templates to republish\n`);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const newName = `bridge_${row.name}`;
    const mapping = row.variable_mapping ?? [];
    const { positional, refs } = toPositionalBody(row.body, mapping);

    const components: Array<Record<string, unknown>> = [];

    // HEADER
    if (row.header_type === 'TEXT' && row.header_text) {
      components.push({ type: 'HEADER', format: 'TEXT', text: row.header_text });
    } else if (row.header_type === 'IMAGE' && row.header_media_url) {
      if (DRY_RUN) {
        components.push({
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['<would-upload>'] },
        });
      } else {
        try {
          const h = await uploadImageToNewWaba(row.header_media_url, {
            appId,
            token,
            version,
          });
          components.push({
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: [h] },
          });
        } catch (e) {
          console.log(
            `  #${row.number} ${row.name} — IMAGE upload failed: ${
              e instanceof Error ? e.message : String(e)
            } — skipping template`,
          );
          failed++;
          continue;
        }
      }
    }

    // BODY — with example.body_text when positional refs exist
    if (refs.length > 0) {
      components.push({
        type: 'BODY',
        text: positional,
        example: {
          body_text: [
            refs.map((name) => {
              const m = mapping.find((x) => x.name === name);
              return m?.example?.toString().trim() ||
                m?.fallback?.toString().trim() ||
                'sample';
            }),
          ],
        },
      });
    } else {
      components.push({ type: 'BODY', text: positional });
    }

    // FOOTER
    if (row.footer_text && row.footer_text.trim()) {
      components.push({ type: 'FOOTER', text: row.footer_text.trim() });
    }

    // BUTTONS
    if (row.buttons && row.buttons.length > 0) {
      const btnPayload = row.buttons.map((b) => {
        if (b.type === 'URL') {
          const dynamic = (b.url ?? '').match(/\{\{[a-z_][a-z0-9_]*\}\}/);
          if (dynamic) {
            const positionalUrl = (b.url ?? '').replace(
              /\{\{[a-z_][a-z0-9_]*\}\}/g,
              '{{1}}',
            );
            const varName = dynamic[0].replace(/[{}]/g, '');
            const m = mapping.find((x) => x.name === varName);
            const exampleValue =
              m?.example?.toString() ?? m?.fallback?.toString() ?? 'sample';
            return {
              type: 'URL',
              text: b.text,
              url: positionalUrl,
              example: [positionalUrl.replace('{{1}}', exampleValue)],
            };
          }
          return { type: 'URL', text: b.text, url: b.url };
        }
        if (b.type === 'PHONE_NUMBER') {
          return {
            type: 'PHONE_NUMBER',
            text: b.text,
            phone_number: b.phone_number,
          };
        }
        return { type: 'QUICK_REPLY', text: b.text };
      });
      components.push({ type: 'BUTTONS', buttons: btnPayload });
    }

    const payload: Record<string, unknown> = {
      name: newName,
      language: row.language,
      category: row.category,
      components,
    };
    if (row.category === 'MARKETING' && row.max_price_amount) {
      payload.optimization_spec = {
        bid_amount: Math.round(parseFloat(row.max_price_amount) * 100),
        bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
      };
    }

    if (DRY_RUN) {
      console.log(
        `  would submit [#${row.number}] ${row.name} → ${newName} ` +
          `(${row.category}, ${row.language}, header=${row.header_type}, ` +
          `buttons=${row.buttons?.length ?? 0}, refs=${refs.length})`,
      );
      ok++;
      continue;
    }

    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as {
        id?: string;
        error?: {
          message?: string;
          error_user_msg?: string;
          error_subcode?: number;
        };
      };
      if (!res.ok || !body.id) {
        const msg =
          body.error?.error_user_msg ??
          body.error?.message ??
          `HTTP ${res.status}`;
        console.log(`  [FAIL] #${row.number} ${row.name}: ${msg}`);
        failed++;
      } else {
        await client.query(
          `UPDATE whatsapp_template
             SET name = $1, meta_template_id = $2, status = 'PENDING',
                 "updatedAt" = NOW()
           WHERE id = $3`,
          [newName, body.id, row.id],
        );
        console.log(
          `  [OK]   #${row.number} ${row.name} → ${newName} (meta_id=${body.id})`,
        );
        ok++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [ERR]  #${row.number} ${row.name}: ${msg}`);
      failed++;
    }

    // Rate-limit between submissions to stay well under Meta's ceiling.
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  console.log(
    `\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} Done. ok=${ok} failed=${failed} total=${rows.length}`,
  );
  if (DRY_RUN) console.log('Re-run with --apply to actually submit.');
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
