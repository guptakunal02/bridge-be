import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes BOT a mandatory, always-available member of every team.
 *
 * Two state fixes, both idempotent:
 *
 *   1. Every team gets a team_member row for the BOT user. Teams
 *      created before autoAddBot shipped (General, early manual
 *      inserts) may be missing it; inserting with ON CONFLICT DO
 *      NOTHING is safe on teams that already have it.
 *
 *   2. Any existing BOT team_member row with paused_in_team = true
 *      is forced back to false. BOT is the system's last-resort
 *      assignee: when the member picker finds no eligible agent,
 *      the picker falls through to BOT. If BOT is paused on a team,
 *      the picker throws and ingest drops the message (which is the
 *      exact bug that cost us a day of mail on 2026-10-05 — admin
 *      toggled OOH's "Assign tickets" OFF and the per-member BOT
 *      flag ended up paused, blocking all OOH-routed ingest).
 *
 * Enforcement at the API layer (TeamsService) prevents the state
 * from regressing: removeMember + updateMember both reject writes
 * targeting the BOT user.
 *
 * Supports multiple BOT users (rare but allowed by the schema) by
 * joining via role; the loop below seeds every team × every BOT.
 */
export class BotMandatoryTeamMember1726160000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // (1) Backfill — add any missing (team, bot) membership rows.
    //     INSERT ... SELECT ... ON CONFLICT DO NOTHING handles both
    //     the "team already has BOT" case and the normal insert.
    await queryRunner.query(`
      INSERT INTO public.team_member (team_id, user_id, paused_in_team)
      SELECT t.id, u.id, false
        FROM public.team t
        CROSS JOIN public."user" u
       WHERE u.role = 'BOT'
         AND u."deactivatedAt" IS NULL
      ON CONFLICT (team_id, user_id) DO NOTHING
    `);

    // (2) State fix — force every BOT membership to unpaused.
    //     Belt-and-braces: the service layer blocks future pauses,
    //     this clears any that slipped through before.
    await queryRunner.query(`
      UPDATE public.team_member tm
         SET paused_in_team = false
        FROM public."user" u
       WHERE tm.user_id = u.id
         AND u.role = 'BOT'
         AND tm.paused_in_team = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op down migration — we're not going to re-pause BOT
    // memberships automatically, and removing the memberships
    // would reintroduce the exact bug this migration fixed.
    // If a rollback is genuinely needed, the admin can delete
    // team_member rows manually.
  }
}
