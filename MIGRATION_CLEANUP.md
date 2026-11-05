# Bridge Migration — Cleanup Inventory

One-off code + deployments added during the LimeChat → Bridge WhatsApp
phone number migration (Nov 3-5, 2026). Delete everything below once
the migration is confirmed complete and Bridge has been sending
reliably for ≥2 weeks.

## Backend scripts (bridge-be)

Delete these files:

- `src/scripts/migrate-phone-to-bridge-waba.ts` — atomic
  deregister + migrate + register sequence for +91 98716 81656
  between Surma_Limechat_Netcore WABA (1962688541113164) and Surma
  Bridge WABA (2885917015101976). Kept as safety net until post-
  migration operation is stable.
- `src/scripts/rollback-phone-to-netcore-waba.ts` — emergency
  rollback in reverse direction. Keep only if Bridge still has
  LimeChat as a parallel hot-standby.
- `src/scripts/es-code-exchange-and-migrate.ts` — exchanges a
  Facebook OAuth code for a user access token and attempts phone
  migration with it. Never actually used in production flow —
  delete once migration is verified.

## package.json pnpm scripts (bridge-be)

Remove these entries:

```json
"migrate:phone-to-bridge": "pnpm build && node dist/scripts/migrate-phone-to-bridge-waba.js",
"rollback:phone-to-netcore": "pnpm build && node dist/scripts/rollback-phone-to-netcore-waba.js",
"es:exchange": "pnpm build && node dist/scripts/es-code-exchange-and-migrate.js",
```

(Also delete `src/scripts/republish-templates-to-new-waba.ts` and
its pnpm script `republish:templates-to-new-waba` if the
Netcore WABA is retired — those templates were one-off republished
there during the migration planning phase.)

## Frontend (bridge)

Delete these files:

- `public/connect-whatsapp.html` — standalone HTML page hosting
  Meta's Facebook JS SDK for Embedded Signup flow. Served at
  https://bridge.teev.shop/connect-whatsapp.html. ES was blocked
  by Meta's Tech Provider gate so this path was abandoned.

## Vercel deployments (bridge)

No explicit teardown needed — `/connect-whatsapp.html` is a static
public asset that simply disappears when the file is removed in
the next push. Vercel auto-purges deleted static assets.

## Meta app configs (developers.facebook.com)

Clean up in Meta Developer Dashboard for Bridge app (ID
4404395859875310):

- Facebook Login for Business → Configurations:
  - Delete Config ID `1874497363550926` (the "WhatsApp embedded
    sign-up with 60-day expiry token" config). Unused post-migration.

## Meta Business Settings (business.facebook.com)

- Review `Settings → Users → Partners` on Business Portfolio
  966934798063406 — if LimeChat/Netcore is still listed as a
  Partner, confirm removal is appropriate post-migration.
- Review stale WABAs in Business Settings → WhatsApp Accounts.
  Candidates for removal if unused:
  - Surma - Bitespeed (historical BSP)
  - Surma_Zoko (historical BSP)
  - Surma_LC (historical BSP — different from Surma_Limechat_Netcore)
  - Test Messaging Account
  - Any orphaned "Surma" entries beyond the primary two
- DO NOT delete `Surma Bridge` (2885917015101976, active target).
- DO NOT delete `Surma_Limechat_Netcore` (1962688541113164) until
  Bridge has been fully sending for ≥2 weeks — keep as rollback
  option.

## Meta App Review submission

Keep the App Review submission in place — approval unlocks
whatsapp_business_messaging Advanced Access which is long-term
useful regardless of migration path chosen.

## Environment variables (bridge-be/.env)

After migration completes and is stable, the NEW_* duplicates can
collapse into the primary:

- `WHATSAPP_PHONE_NUMBER_ID` currently points to test number
  (1317591878111168 = +91 92052 41076)
- `NEW_WHATSAPP_PHONE_NUMBER_ID` points to production target
  (1265804863284631 = +91 98716 81656)

Post-migration, flip main to production number:
- `WHATSAPP_PHONE_NUMBER_ID=1265804863284631`
- Remove `NEW_WHATSAPP_PHONE_NUMBER_ID`
- Remove `NEW_WHATSAPP_BUSINESS_ACCOUNT_ID` (was the source
  Netcore WABA — no longer the target of anything)

## Post-migration verification checklist

Before deleting ANY of the above, confirm:

- [ ] Bridge successfully sends to real customers for 2+ weeks
- [ ] LimeChat billing is settled (final invoice paid)
- [ ] Netcore payment method detached from all Surma WABAs
- [ ] Bridge Mastercard is the sole payment method on Surma Bridge
      WABA
- [ ] All Bridge automation rules (shopify-webhooks, Clickpost,
      Return Prime) are firing templates successfully
- [ ] No open tickets referencing "cannot send"
- [ ] Inbox bot auto-reply count has stabilized (no more failed-send
      noise)
- [ ] Meta App Review status is APPROVED (nice-to-have, not required
      for cleanup)

## Notes on what we LEARNED (keep in memory even after cleanup)

- Meta's error 2593181 "Application does not have permission" is
  a catch-all that often means payment method ineligibility, NOT
  app permissions. Check WhatsApp Manager payment alerts first.
- Meta's error 2388103 "in use by another WhatsApp account" is a
  WABA-level ownership flag. Phone /deregister alone doesn't clear
  it. Only a successful WABA transfer OR BSP deregister clears it.
- Embedded Signup with the BSP template is designed for BSPs
  onboarding EXTERNAL businesses. Self-onboarding (same business
  on both sides) is NOT supported and hits "Surma can't onboard
  customers at the moment".
- WhatsApp Manager UI "PMA ownership conflict with BP" blocks
  linking the same phone to two WABAs under the same Business
  Portfolio simultaneously — this is a data model constraint not
  a permissions issue.
- Meta Executive Support (via Business Support Home) is the
  working channel for BSP-to-direct migration. Developer compliance
  tickets are for App Review only. Meta Executive Services (general)
  is ads-focused only.
