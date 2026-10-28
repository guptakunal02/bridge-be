import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import type { EnvVars } from '../config/env.validation';
import {
  ChannelType,
  WhatsappTemplateCategory,
  WhatsappTemplateHeaderType,
  WhatsappTemplateStatus,
} from '../database/enums';
import { WhatsappTemplate } from './entities/whatsapp-template.entity';
import {
  extractUrlVariableName,
  type WhatsappTemplateButton,
} from './template-buttons';
import {
  convertNamedBodyToPositional,
  extractVariableReferences,
  isNullableFor,
  TEMPLATE_VARIABLES_BY_NAME,
  type VariableMappingEntry,
} from './template-variables';

/**
 * The only variables a MARKETING template may reference. Mirrors
 * the 3 optional fields a segment can map (first_name, last_name,
 * email); country_code / phone_number are never usable as body
 * variables (they're the identity key, not content).
 */
const MARKETING_ALLOWED_VARIABLES: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'email',
]);

/**
 * Hidden max-price ceiling we stamp on every MARKETING template at
 * creation time, in paisa per 1,000 deliveries (₹200/1k). Admins
 * never see or set this directly — it exists only so that broadcasts
 * can scale an effective bid via Meta's `per_message_bid_multiplier`
 * (a per-send multiplier against the template's bid_amount).
 *
 * The ceiling is deliberately above Meta's current India marketing
 * published rate (~₹1/msg, so ₹1000/1k) and above the top of the
 * reach-estimate curve we observed (~₹172/1k). A broadcast slider
 * from ₹0 (= default pricing, no multiplier) to this ceiling gives
 * the admin the whole realistic bid range at any point in time.
 *
 * When Meta raises India's published rate past this value, bump
 * the ceiling. The template authoring UI stays unchanged — admins
 * never bind to a specific bid at the template level.
 */
export const TEMPLATE_HIDDEN_CEILING_PAISA = 200_000;
import { WhatsappSenderService } from './whatsapp-sender.service';
import { TemplateVariableResolverService } from './template-variable-resolver.service';

/**
 * Shape of one entry in Meta's GET /{waba_id}/message_templates
 * response. We only consume the fields we need; Meta adds more
 * (quality_score, previous_category, …) that aren't load-bearing
 * for V1.
 */
interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: Array<{
    type: string;
    text?: string;
    format?: string;
  }>;
  // Meta populates one of these on REJECTED rows depending on the
  // reviewer path (automated vs human). Checking all three keeps us
  // from showing a blank reason to the author.
  rejected_reason?: string | null;
  reason?: string | null;
  quality_score?: {
    score?: string;
    reasons?: string[];
  };
}

interface MetaListResponse {
  data?: MetaTemplate[];
  paging?: { cursors?: { before?: string; after?: string } };
}

interface MetaCreateResponse {
  id: string;
  status: string;
  category: string;
}

interface MetaErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/**
 * Pull the human-readable rejection reason out of a Meta template
 * row. Meta's response schema is inconsistent — automated review
 * puts the reason in `rejected_reason`, human review sometimes uses
 * `reason`, and quality-paused rows carry it under `quality_score.
 * reasons[]`. We try all three so authors don't see a blank reason
 * pill when Meta did send something.
 */
function extractRejectionReason(t: MetaTemplate): string | null {
  if (t.rejected_reason && t.rejected_reason !== 'NONE') {
    return t.rejected_reason;
  }
  if (t.reason) return t.reason;
  const qsReasons = t.quality_score?.reasons;
  if (qsReasons && qsReasons.length > 0) return qsReasons.join('; ');
  return null;
}

/**
 * Count distinct `{{n}}` placeholders in a template body. Returns the
 * highest-numbered placeholder seen so we match Meta's convention of
 * "variables are 1..N without gaps." Meta rejects templates with
 * gaps (e.g. {{1}} and {{3}} but no {{2}}) so we don't validate
 * gaps here — Meta will reject on create.
 */
function countVariables(body: string): number {
  const matches = body.match(/\{\{(\d+)\}\}/g) ?? [];
  if (matches.length === 0) return 0;
  return matches
    .map((m) => Number(m.slice(2, -2)))
    .reduce((max, n) => (n > max ? n : max), 0);
}

/**
 * Fill a Meta template body's `{{1}}`, `{{2}}`, … placeholders with
 * the matching value from `variables` (1-indexed → array[0]). Used
 * both when persisting the outbound WhatsappMessage row (so the
 * agent-side thread shows the actual filled text, not raw template
 * body) and when previewing in the FE picker.
 */
export function renderTemplateBody(body: string, variables: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, num: string) => {
    const idx = Number(num) - 1;
    const v = variables[idx];
    return v === undefined || v === null ? '' : String(v);
  });
}

@Injectable()
export class WhatsappTemplatesService {
  private readonly logger = new Logger(WhatsappTemplatesService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    private readonly sender: WhatsappSenderService,
    private readonly resolver: TemplateVariableResolverService,
  ) {}

  /**
   * Return all templates for a channel, newest first. Status filter
   * is applied at the SQL layer so the picker only sees APPROVED
   * rows without a FE-side filter.
   */
  async list(
    channelId: string,
    opts: { status?: WhatsappTemplateStatus } = {},
  ): Promise<WhatsappTemplate[]> {
    await this.assertWhatsappChannel(channelId);
    const where = opts.status
      ? { channelId, status: opts.status }
      : { channelId };
    return this.templates.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Fetch all templates from Meta for the WABA tied to this channel
   * and upsert into whatsapp_template. One row per (channel, name,
   * language) — if a template exists locally, its status / category /
   * body get overwritten from Meta's authoritative copy; otherwise a
   * new row lands (with createdBy = null since it was authored in
   * Meta BM, not Bridge).
   *
   * Returns the number of rows upserted so the FE can toast
   * "Synced 12 templates".
   */
  async sync(channelId: string): Promise<{ synced: number }> {
    await this.assertWhatsappChannel(channelId);
    const wabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });

    // Meta paginates — V1 just grabs the first page (limit=200, Meta's
    // default max). If a merchant has 200+ templates we'll iterate
    // next_cursor in V2.
    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=200`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (netErr) {
      this.logger.error(
        `Template sync network error: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw new BadRequestException(
        'Could not reach WhatsApp to sync templates — retry in a moment',
      );
    }

    if (!res.ok) {
      const body: MetaErrorEnvelope = await res.json().catch(() => ({}));
      const msg =
        body.error?.error_user_msg ??
        body.error?.message ??
        `Meta template list failed (HTTP ${res.status})`;
      this.logger.error(`Template sync failed: ${msg}`);
      throw new BadRequestException(msg);
    }

    const payload: MetaListResponse = await res.json();
    const items = payload.data ?? [];
    let synced = 0;
    for (const t of items) {
      // Only BODY-type components carry {{n}} + the main text; HEADER
      // can be text/image/video/document, FOOTER is a short tagline,
      // BUTTONS are quick-replies / URLs. V1 picker renders BODY only.
      const bodyComp = (t.components ?? []).find((c) => c.type === 'BODY');
      const body = bodyComp?.text?.trim();
      if (!body) {
        this.logger.debug(
          `Skipping template ${t.name}/${t.language} — no BODY component text`,
        );
        continue;
      }
      const category = this.mapMetaCategory(t.category);
      const status = this.mapMetaStatus(t.status);
      if (!category) {
        this.logger.debug(
          `Skipping template ${t.name}/${t.language} — unknown category ${t.category}`,
        );
        continue;
      }
      const existing = await this.templates.findOne({
        where: { channelId, name: t.name, language: t.language },
      });
      if (existing) {
        existing.category = category;
        existing.status = status;
        // Don't clobber a locally-authored (Bridge-created) template's
        // named body + mapping. If we already have variable_mapping,
        // this row was authored here; Meta's sync returns the
        // positional body which would overwrite the human-readable
        // one. Only overwrite body + variableCount for rows that
        // were imported in the first place (variable_mapping is null).
        if (existing.variableMapping === null) {
          existing.body = body;
          existing.variableCount = countVariables(body);
        }
        existing.metaTemplateId = t.id;
        existing.rejectionReason = extractRejectionReason(t);
        await this.templates.save(existing);
      } else {
        await this.templates.save(
          this.templates.create({
            channelId,
            name: t.name,
            language: t.language,
            category,
            status,
            body,
            variableCount: countVariables(body),
            // Imported from Meta — no name metadata, treated as
            // "legacy" by the composer.
            variableMapping: null,
            metaTemplateId: t.id,
            rejectionReason: extractRejectionReason(t),
            createdBy: null,
          }),
        );
      }
      synced += 1;
    }
    this.logger.log(`Synced ${synced} templates for channel ${channelId}`);
    return { synced };
  }

  /**
   * Submit a new template to Meta + persist the local PENDING row.
   * Meta's review usually completes within a few hours; the FE
   * admin page shows PENDING → APPROVED / REJECTED after the next
   * sync pass.
   *
   * Throws CONFLICT if a (channel, name, language) row already exists
   * — Meta's own API returns 400 in that case too but we short-circuit
   * before even hitting Meta.
   */
  async create(
    channelId: string,
    createdBy: string,
    dto: {
      name: string;
      category: WhatsappTemplateCategory;
      language: string;
      body: string;
      variableMapping?: Array<{
        name: string;
        fallback?: string | null;
        example?: string | null;
        /** Default JSON path captured on the authoring UI's JSON-tree
         *  click. Automation rules inherit this as the per-variable
         *  binding path when the admin picks this template. */
        path?: string | null;
      }>;
      /** Default recipient phone JSON path (admin picked once at
       *  authoring time; every automation rule using this template
       *  inherits it). */
      recipientPhonePath?: string;
      /** Default per-event image URL path for IMAGE-header templates. */
      headerImagePath?: string;
      /** Phase 2a — visual rich fields. */
      headerType?: WhatsappTemplateHeaderType;
      headerText?: string;
      headerMediaHandle?: string;
      headerMediaUrl?: string;
      footerText?: string;
      // Accept the DTO's wider shape (type+text+optional url+optional
      // phone_number); narrowed to the discriminated union below so
      // the entity + Meta payload builder see type-safe variants.
      buttons?: Array<{
        type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
        text: string;
        url?: string;
        phone_number?: string;
      }>;
      /** Phase 2b — Max Price bid cap, paisa per 1,000 deliveries. */
      maxPriceAmount?: number;
    },
  ): Promise<WhatsappTemplate> {
    await this.assertWhatsappChannel(channelId);
    const existing = await this.templates.findOne({
      where: { channelId, name: dto.name, language: dto.language },
    });
    if (existing) {
      throw new ConflictException(
        `A template named "${dto.name}" (${dto.language}) already exists for this channel`,
      );
    }

    // ---- Named-variable validation + conversion to positional ----
    //
    // We accept the body as the author wrote it ("Hi {{first_name}},
    // order #{{order_id}} shipped.") but Meta's API wants positional
    // placeholders ("Hi {{1}}, order #{{2}} shipped."). The conversion
    // happens here so Meta sees the shape it expects and the local
    // row keeps the human-readable version + an ordered mapping.
    const bodyRefs = extractVariableReferences(dto.body);
    // URL buttons may also carry one variable each (Meta cap). Pull
    // the names so they land in variableMapping alongside body
    // variables — the admin's automation rule binds all of them the
    // same way (variable_bindings[name] = JSON path).
    const buttonUrlVarNames: string[] = [];
    for (const b of dto.buttons ?? []) {
      if (b.type === 'URL' && typeof b.url === 'string') {
        const v = extractUrlVariableName(b.url);
        if (v) buttonUrlVarNames.push(v);
      }
    }
    const refs: string[] = [];
    const seenRef = new Set<string>();
    for (const n of [...bodyRefs, ...buttonUrlVarNames]) {
      if (!seenRef.has(n)) {
        seenRef.add(n);
        refs.push(n);
      }
    }
    // Marketing templates have NO ticket context when sent — they go
    // out through broadcasts targeting segments, and the only data a
    // segment carries is the 5 Customer fields mapped at upload time.
    // Enforce registry membership + the segment-safe subset.
    //
    // UTILITY templates skip the registry check entirely: admin's
    // automation rule binds each {{name}} to a JSON path at rule-
    // creation time (see action.variable_bindings), so names can be
    // anything the author wants (order_name, tracking_url, status,
    // etc.) — the registry is only meaningful for ticket-context
    // auto-resolution, which doesn't apply to event-bound sends.
    if (dto.category === WhatsappTemplateCategory.MARKETING) {
      for (const name of refs) {
        const v = TEMPLATE_VARIABLES_BY_NAME[name];
        if (!v) {
          throw new BadRequestException(
            `Unknown variable "{{${name}}}" in marketing template. ` +
              `Use first_name, last_name, or email — the segment-safe fields.`,
          );
        }
        if (!MARKETING_ALLOWED_VARIABLES.has(name)) {
          throw new BadRequestException(
            `Variable {{${name}}} isn't allowed in marketing templates. ` +
              `Marketing templates can only use first_name, last_name, email — ` +
              `the fields that come from a segment's uploaded CSV.`,
          );
        }
      }
    }

    const providedByName = new Map(
      (dto.variableMapping ?? []).map(
        (m) =>
          [m.name, {
            fallback: m.fallback ?? null,
            example: m.example ?? null,
            path: m.path ?? null,
          }] as const,
      ),
    );
    const orderedMapping: VariableMappingEntry[] = refs.map((name) => {
      const v = TEMPLATE_VARIABLES_BY_NAME[name];
      const provided = providedByName.get(name);
      const providedFallback = provided?.fallback ?? null;
      const providedExample = provided?.example ?? null;
      const providedPath = provided?.path?.trim() || null;
      if (v) {
        // Registry variable (customer/ticket field). Enforce the
        // nullable-fallback rule so a template whose placeholder may
        // resolve to null at send time has a safe default.
        const nullable = isNullableFor(v, 'WHATSAPP');
        if (nullable && (!providedFallback || !providedFallback.trim())) {
          throw new BadRequestException(
            `Variable {{${name}}} may be null on some WhatsApp tickets — a fallback is required.`,
          );
        }
        return {
          name,
          fallback: nullable ? providedFallback!.trim() : null,
          example: providedExample?.trim() || null,
          path: providedPath,
        };
      }
      // Non-registry (UTILITY event-bound) variable: carry whatever
      // the admin provided; no fallback requirement, since the rule's
      // header_image_fallback + variable_bindings handle resolution.
      return {
        name,
        fallback: providedFallback?.trim() || null,
        example: providedExample?.trim() || null,
        path: providedPath,
      };
    });
    const { positionalBody } = convertNamedBodyToPositional(dto.body);

    const wabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

    // ---- Validate the Phase 2a visual-rich fields ----
    const headerType = dto.headerType ?? WhatsappTemplateHeaderType.NONE;
    if (
      headerType === WhatsappTemplateHeaderType.IMAGE &&
      (!dto.headerMediaHandle || !dto.headerMediaUrl)
    ) {
      throw new BadRequestException(
        'Image headers require both headerMediaHandle and headerMediaUrl (upload the sample first via POST /media)',
      );
    }
    if (
      headerType === WhatsappTemplateHeaderType.TEXT &&
      (!dto.headerText || !dto.headerText.trim())
    ) {
      throw new BadRequestException(
        'headerText is required when headerType is TEXT',
      );
    }
    const rawButtons = dto.buttons ?? [];
    const phoneButtonCount = rawButtons.filter(
      (b) => b.type === 'PHONE_NUMBER',
    ).length;
    if (phoneButtonCount > 1) {
      throw new BadRequestException(
        'Only one PHONE_NUMBER button is allowed per template',
      );
    }
    // Max price is MARKETING-only AND admin-invisible — we stamp a
    // hidden ceiling (TEMPLATE_HIDDEN_CEILING_PAISA) on every MARKETING
    // template so broadcasts can scale an effective bid via the
    // per_message_bid_multiplier knob at send time. Admin never sees
    // this value in the template authoring UI; the bidding UX lives
    // entirely on the broadcast.
    //
    // UTILITY and AUTHENTICATION categories don't get the ceiling —
    // Meta doesn't honour optimization_spec for them, and they send
    // through the Cloud API (/messages), not /marketing_messages.
    const applyHiddenCeiling =
      dto.category === WhatsappTemplateCategory.MARKETING;
    // Reject if a DTO still carries a maxPriceAmount — the field is
    // deprecated after the broadcast-level pricing pivot. Clear
    // signal to any legacy caller.
    if (dto.maxPriceAmount !== undefined) {
      throw new BadRequestException(
        'Max price can no longer be set on templates. ' +
          'Pricing is picked per broadcast — leave this field off.',
      );
    }
    // Narrow DTO → discriminated union. Validator already enforced
    // the shape per `type`; this cast is safe.
    const buttons: WhatsappTemplateButton[] = rawButtons.map((b) => {
      if (b.type === 'URL') {
        if (!b.url) {
          throw new BadRequestException(
            `URL button "${b.text}" is missing a url`,
          );
        }
        // Keep the admin's named form in storage ("...?awb={{awb}}")
        // for round-tripping to the authoring UI. The Meta payload
        // builder converts to {{1}} + example separately; the send-
        // time handler uses url_variable_name to look up the resolved
        // variable value and pass it as a Meta button parameter.
        const urlVariableName = extractUrlVariableName(b.url);
        return {
          type: 'URL',
          text: b.text,
          url: b.url,
          url_variable_name: urlVariableName,
        };
      }
      if (b.type === 'PHONE_NUMBER') {
        if (!b.phone_number) {
          throw new BadRequestException(
            `PHONE_NUMBER button "${b.text}" is missing a phone_number`,
          );
        }
        return {
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number,
        };
      }
      return { type: 'QUICK_REPLY', text: b.text };
    });

    // ---- Compose the Meta components array ----
    const components: Array<Record<string, unknown>> = [];
    if (headerType === WhatsappTemplateHeaderType.TEXT) {
      components.push({ type: 'HEADER', format: 'TEXT', text: dto.headerText });
    } else if (headerType === WhatsappTemplateHeaderType.IMAGE) {
      components.push({
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [dto.headerMediaHandle] },
      });
    }
    components.push(
      bodyRefs.length > 0
        ? {
            type: 'BODY',
            text: positionalBody,
            // Meta's reviewer uses `example.body_text` to understand
            // what each {{n}} will be filled with — without it the
            // template looks ambiguous ("Hi {{1}}") and the reviewer
            // tends to reject under TAG_CONTENT_MISMATCH or
            // INCORRECT_CATEGORY. Prefer the author's real-event-
            // derived `example` (populated by the authoring UI's
            // JSON-tree click → captures the actual event value);
            // fall back to the admin's fallback string; finally to
            // "sample". body_text is a 2D array: one example set,
            // N values matching N positional slots.
            //
            // Only body-referenced variables go here — URL button
            // variables also live in orderedMapping (for persistence
            // + send-time binding) but Meta validates the example
            // count against the body placeholder count. Including the
            // URL variable would make the array longer than
            // positionalBody's {{n}} count and Meta rejects with a
            // confusing "missing expected field(s) (example)".
            example: {
              body_text: [
                bodyRefs.map((name) => {
                  const m = orderedMapping.find((e) => e.name === name);
                  return m?.example ?? m?.fallback ?? 'sample';
                }),
              ],
            },
          }
        : { type: 'BODY', text: positionalBody },
    );
    if (dto.footerText && dto.footerText.trim()) {
      components.push({ type: 'FOOTER', text: dto.footerText.trim() });
    }
    if (buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        // Meta accepts type strings in lowercase for buttons —
        // url / phone_number / quick_reply — distinct from the
        // top-level TYPE string on components ("HEADER" / "BUTTONS")
        // which stays uppercase. Not consistent, but documented.
        buttons: buttons.map((b) => {
          if (b.type === 'URL') {
            const varName = extractUrlVariableName(b.url);
            if (varName) {
              // Meta: dynamic URL buttons are declared with a {{1}}
              // placeholder (not the admin's named form) and MUST
              // include an `example` showing the fully-substituted
              // URL. Reviewers use the example to approve the shape;
              // at send time we pass the resolved value as a button
              // parameter (see sender.sendTemplate).
              const positionalUrl = b.url.replace(
                /\{\{[a-z_][a-z0-9_]*\}\}/g,
                '{{1}}',
              );
              const mapEntry = orderedMapping.find((m) => m.name === varName);
              const exampleValue =
                mapEntry?.example ?? mapEntry?.fallback ?? 'sample';
              const exampleUrl = positionalUrl.replace('{{1}}', exampleValue);
              return {
                type: 'URL',
                text: b.text,
                url: positionalUrl,
                example: [exampleUrl],
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
        }),
      });
    }

    const payload: Record<string, unknown> = {
      name: dto.name,
      language: dto.language,
      category: dto.category,
      components,
    };
    // Marketing templates ALWAYS go out with the hidden ceiling in
    // optimization_spec. This is what wires every marketing template
    // into Meta's auction + unlocks the broadcast-level multiplier
    // at send time. UTILITY / AUTHENTICATION templates omit it (Meta
    // doesn't honour the field for those categories).
    if (applyHiddenCeiling) {
      payload.optimization_spec = {
        bid_amount: TEMPLATE_HIDDEN_CEILING_PAISA,
        bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
      };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      this.logger.error(
        `Template create network error: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw new BadRequestException(
        'Could not reach WhatsApp to submit template — retry in a moment',
      );
    }

    if (!res.ok) {
      const body: MetaErrorEnvelope = await res.json().catch(() => ({}));
      const msg =
        body.error?.error_user_msg ??
        body.error?.message ??
        `Meta template create failed (HTTP ${res.status})`;
      this.logger.warn(`Template create rejected: ${msg}`);
      throw new BadRequestException(msg);
    }

    const metaResp: MetaCreateResponse = await res.json();
    const status = this.mapMetaStatus(metaResp.status);
    const category = this.mapMetaCategory(metaResp.category) ?? dto.category;

    const row = await this.templates.save(
      this.templates.create({
        channelId,
        name: dto.name,
        language: dto.language,
        category,
        status,
        // Store the named body + ordered mapping. The composer's
        // slash picker renders this (so authors see "{{first_name}}"
        // not "{{1}}"); the sendTemplate flow uses the mapping to
        // resolve + fill positional params against the real ticket.
        body: dto.body,
        variableCount: orderedMapping.length,
        variableMapping:
          orderedMapping.length > 0 ? orderedMapping : null,
        metaTemplateId: metaResp.id,
        rejectionReason: null,
        headerType,
        headerText:
          headerType === WhatsappTemplateHeaderType.TEXT
            ? (dto.headerText ?? null)
            : null,
        headerMediaHandle:
          headerType === WhatsappTemplateHeaderType.IMAGE
            ? (dto.headerMediaHandle ?? null)
            : null,
        headerMediaUrl:
          headerType === WhatsappTemplateHeaderType.IMAGE
            ? (dto.headerMediaUrl ?? null)
            : null,
        footerText: dto.footerText?.trim() || null,
        buttons: buttons.length > 0 ? buttons : null,
        // Persisted ceiling matches what we sent to Meta so the
        // broadcast path can read it as the multiplier's divisor.
        maxPriceAmount: applyHiddenCeiling
          ? String(TEMPLATE_HIDDEN_CEILING_PAISA)
          : null,
        recipientPhonePath: dto.recipientPhonePath?.trim() || null,
        headerImagePath:
          headerType === WhatsappTemplateHeaderType.IMAGE
            ? (dto.headerImagePath?.trim() || null)
            : null,
        createdBy,
      }),
    );
    this.logger.log(
      `Submitted template ${dto.name}/${dto.language} to Meta — id=${metaResp.id} status=${status}`,
    );
    return row;
  }

  /**
   * Fetch an APPROVED template by id — used by the ticket's
   * send-template path to resolve name + language + variableCount
   * before calling the sender. Throws 404 if not found, 400 if not
   * usable (status !== APPROVED).
   */
  async findSendable(id: string): Promise<WhatsappTemplate> {
    const row = await this.templates.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Template not found');
    if (row.status !== WhatsappTemplateStatus.APPROVED) {
      throw new BadRequestException(
        `Template "${row.name}" is ${row.status} — only APPROVED templates can be sent`,
      );
    }
    return row;
  }

  /**
   * Fire a test send of an APPROVED template to an arbitrary phone
   * number — used by the admin's "Send test" affordance on the
   * template detail page.
   *
   * Important differences from the ticket send-template flow:
   *   * No ticket resolution — recipient wa_id comes straight from
   *     the admin's input, normalized to digits.
   *   * Variable values come entirely from the DTO (overrides first,
   *     then the template's stored fallback). We don't walk ticket
   *     + customer-orders state because there IS no ticket.
   *   * No persistence — the test send doesn't show up in any inbox,
   *     doesn't log a whatsapp_message row. We just log the attempt
   *     to the service logger for audit.
   *
   * Legacy templates (variable_mapping null) use positional overrides
   * keyed as "1", "2", … so admins can still test imported templates.
   */
  async testSend(
    templateId: string,
    channelId: string,
    actorId: string,
    phoneNumber: string,
    overrides: Record<string, string>,
  ): Promise<{ wamid: string }> {
    const template = await this.findSendable(templateId);
    if (template.channelId !== channelId) {
      throw new BadRequestException(
        'Template belongs to a different WhatsApp channel',
      );
    }

    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new BadRequestException(
        'Phone number must have 7–15 digits (E.164-ish). Include country code.',
      );
    }

    let variables: string[];
    if (template.variableMapping && template.variableMapping.length > 0) {
      // Named mapping — resolution order per variable:
      //   1. Admin's explicit override (non-empty input)
      //   2. Phone-based auto-resolve from the ops DB (so a real
      //      customer's first_name / last_name / order_id lands
      //      automatically when the admin leaves the input blank)
      //   3. Template fallback (what the author wrote at create time)
      //   4. Reject if the variable is non-nullable and we're out of
      //      options
      // Only invoke the resolver if at least ONE variable actually
      // needs it — avoids a wasted ops-DB round trip when every
      // variable has an override.
      const needingResolve = template.variableMapping
        .filter((m) => {
          const o = overrides[m.name];
          return !(o !== undefined && o.trim().length > 0);
        })
        .map((m) => m.name);
      const resolved =
        needingResolve.length > 0
          ? await this.resolver.resolveForPhone(digits, needingResolve)
          : {};
      variables = template.variableMapping.map((m) => {
        const o = overrides[m.name];
        if (o !== undefined && o.trim().length > 0) return o;
        const r = resolved[m.name];
        if (r !== undefined && r !== null && r !== '') return r;
        if (m.fallback !== null) return m.fallback;
        throw new BadRequestException(
          `Variable "${m.name}" is non-nullable — provide an override for the test send`,
        );
      });
    } else {
      // Legacy positional — overrides keyed by "1", "2", …
      variables = Array.from({ length: template.variableCount }).map((_, i) => {
        const o = overrides[String(i + 1)];
        if (o !== undefined && o.trim().length > 0) return o;
        throw new BadRequestException(
          `Provide a value for {{${i + 1}}} to test this legacy template`,
        );
      });
    }

    this.logger.log(
      `Test template send actor=${actorId} template=${template.name} to=${digits} vars=${variables.length}`,
    );

    const { wamid } = await this.sender.sendTemplate(
      digits,
      template.name,
      template.language,
      variables,
      template.headerMediaUrl,
      {
        useMarketingEndpoint: template.maxPriceAmount !== null,
      },
    );
    return { wamid };
  }

  private async assertWhatsappChannel(channelId: string): Promise<void> {
    const channel = await this.channels.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.WHATSAPP) {
      throw new BadRequestException(
        'Templates are only available on WhatsApp channels',
      );
    }
  }

  private mapMetaCategory(input: string): WhatsappTemplateCategory | null {
    const normalized = input?.toUpperCase();
    if (normalized === 'UTILITY') return WhatsappTemplateCategory.UTILITY;
    if (normalized === 'MARKETING') return WhatsappTemplateCategory.MARKETING;
    if (normalized === 'AUTHENTICATION') {
      return WhatsappTemplateCategory.AUTHENTICATION;
    }
    return null;
  }

  private mapMetaStatus(input: string): WhatsappTemplateStatus {
    const normalized = input?.toUpperCase();
    switch (normalized) {
      case 'APPROVED':
        return WhatsappTemplateStatus.APPROVED;
      case 'REJECTED':
        return WhatsappTemplateStatus.REJECTED;
      case 'PAUSED':
        return WhatsappTemplateStatus.PAUSED;
      case 'DISABLED':
        return WhatsappTemplateStatus.DISABLED;
      case 'PENDING':
      case 'IN_APPEAL':
      case 'PENDING_DELETION':
      default:
        return WhatsappTemplateStatus.PENDING;
    }
  }
}
