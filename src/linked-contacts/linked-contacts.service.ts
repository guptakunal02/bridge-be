import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EnvVars } from '../config/env.validation';
import { CustomerSource } from '../database/enums';
import { Customer } from '../outreach/entities/customer.entity';

/**
 * Hard timeout on the Lens call. 5s is generous for a local-sync-only
 * endpoint (Lens warm-path is ~125–130ms against indexed Shopify
 * webhook data — no live Shopify Admin API fallback) but shields
 * Bridge ingest from anything pathological. On expiry we fall through
 * to the no-op path; ticket mint continues regardless.
 */
const LENS_TIMEOUT_MS = 5000;

/**
 * Shape surma-ops returns from GET /api/customers/linked-contacts.
 * `matched: false` is a normal result (Shopify just doesn't know
 * this customer) — we treat it the same as "no linked identifiers"
 * and silently skip the upsert.
 */
interface LinkedContactsResponse {
  matched: boolean;
  source?: string;
  emails?: string[];
  phones?: string[];
  firstName?: string | null;
  lastName?: string | null;
  shopifyCustomerIds?: string[];
}

/**
 * Enriches freshly-minted tickets with Shopify's customer graph via
 * Lens. Called POST-COMMIT from the two ingest paths (email + WhatsApp)
 * so a slow or down Lens never delays ticket creation.
 *
 * On a successful lookup we upsert ONE `customer` row per returned
 * phone (anchor to the unique column) with the first email + the
 * Shopify-sourced name fields. That row is what the related-tickets
 * sidebar query joins against to surface cross-channel history.
 *
 * On any failure (no env var, timeout, non-2xx, bad JSON) we log at
 * `warn` and return — never rethrow. The ticket that triggered the
 * enrichment is already committed; failing here would be
 * user-visible noise for no gain.
 *
 * Deliberate non-feature: `matched: false` is silent. For a
 * WhatsApp-only cold prospect (no Shopify order yet) every ingest
 * would otherwise write an activity-log line that agents would learn
 * to ignore. If ops want visibility we can promote it to a server
 * log counter later.
 */
@Injectable()
export class LinkedContactsService {
  private readonly logger = new Logger(LinkedContactsService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  /**
   * Fire-and-forget enrichment. Callers should NOT await this on a
   * critical path — use `setImmediate(() => svc.enrich(...).catch(...))`
   * from the ingest sites so the HTTP response returns before this
   * runs.
   *
   *   @param ticketId  The new ticket's id. Only used for log
   *                    attribution right now; kept in the signature
   *                    so a future activity-log integration doesn't
   *                    need a caller API change.
   *   @param seed      The identifier the ticket arrived on — either
   *                    an email ("x@y.com") or a wa_id ("919820819156").
   */
  async enrich(ticketId: string, seed: string): Promise<void> {
    const baseUrl = this.config.get('LENS_LINKED_CONTACTS_URL', {
      infer: true,
    });
    const secret = this.config.get('LENS_INTERNAL_SECRET', { infer: true });
    if (!baseUrl || !secret) {
      // Feature off in this env (dev / staging without Lens). Silent —
      // this isn't a failure to log, it's a deployment-time choice.
      return;
    }

    const seedIsEmail = seed.includes('@');
    const digits = seed.replace(/\D/g, '');
    if (!seedIsEmail && digits.length < 10) {
      // Nothing useful to look up — malformed wa_id. Shouldn't happen
      // in practice; defensive guard so we don't fire a Lens call that
      // will 400 anyway.
      return;
    }
    const param = seedIsEmail
      ? `email=${encodeURIComponent(seed.trim().toLowerCase())}`
      : `phone=${encodeURIComponent(digits)}`;
    const url = `${baseUrl.replace(/\/$/, '')}?${param}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), LENS_TIMEOUT_MS);
    let data: LinkedContactsResponse;
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret },
        signal: ac.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `linked-contacts: ticket=${ticketId} seed=${seed} Lens returned ${res.status} — skipping enrichment`,
        );
        return;
      }
      data = (await res.json()) as LinkedContactsResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `linked-contacts: ticket=${ticketId} seed=${seed} Lens call failed: ${msg} — skipping enrichment`,
      );
      return;
    } finally {
      clearTimeout(t);
    }

    if (!data.matched) {
      // Shopify doesn't know this customer. Not an error; many
      // tickets are from cold prospects. Stay silent.
      return;
    }

    const emails = (data.emails ?? [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    const phones = (data.phones ?? [])
      .map((p) => p.replace(/\D/g, ''))
      .filter((p) => p.length >= 10);
    if (phones.length === 0 && emails.length === 0) return;

    await this.upsertLinks({
      ticketId,
      phones,
      emails,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      shopifyCustomerId: data.shopifyCustomerIds?.[0] ?? null,
    });
  }

  /**
   * Materialise the returned graph into the customer table. One row
   * per phone (anchor column is UNIQUE), first email attached, Shopify
   * metadata back-filled when present but never overwritten — if an
   * admin CSV already named the customer "Priya K." we keep it; we're
   * just adding the cross-channel link.
   *
   * Multi-email edge case (one phone, multiple emails on Shopify) is
   * known-limited in V1 — only the first email ends up in the customer
   * row, so the related-tickets query reaches it but not the other
   * emails. Flip to one-row-per-identifier when that becomes a real
   * problem.
   */
  private async upsertLinks(input: {
    ticketId: string;
    phones: string[];
    emails: string[];
    firstName: string | null;
    lastName: string | null;
    shopifyCustomerId: string | null;
  }): Promise<void> {
    const primaryEmail = input.emails[0] ?? null;
    for (const phone of input.phones) {
      try {
        const existing = await this.customers.findOne({
          where: { phone },
        });
        if (existing) {
          // Back-fill only what's missing. Admin-set fields win.
          let dirty = false;
          if (!existing.email && primaryEmail) {
            existing.email = primaryEmail;
            dirty = true;
          }
          if (!existing.firstName && input.firstName) {
            existing.firstName = input.firstName;
            dirty = true;
          }
          if (!existing.lastName && input.lastName) {
            existing.lastName = input.lastName;
            dirty = true;
          }
          if (!existing.shopify_customer_id && input.shopifyCustomerId) {
            existing.shopify_customer_id = input.shopifyCustomerId;
            dirty = true;
          }
          if (dirty) await this.customers.save(existing);
          continue;
        }
        const row = this.customers.create({
          phone,
          countryCode:
            phone.length === 12 && phone.startsWith('91') ? '91' : null,
          phoneNumber:
            phone.length === 12 && phone.startsWith('91')
              ? phone.slice(2)
              : phone,
          firstName: input.firstName,
          lastName: input.lastName,
          email: primaryEmail,
          source: CustomerSource.SHOPIFY_WEBHOOK,
          shopify_customer_id: input.shopifyCustomerId,
        });
        await this.customers.save(row);
      } catch (err) {
        // A failed upsert on one phone shouldn't tank the rest. Common
        // cause: a concurrent ingest just created the same phone row
        // and the UNIQUE constraint bites — safe to swallow since the
        // row we would have written already exists.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `linked-contacts: ticket=${input.ticketId} upsert phone=${phone} failed: ${msg}`,
        );
      }
    }
  }
}
