import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Promotes tags from a purely free-form text[] on `ticket` into a
 * managed catalogue owned by admins:
 *
 *   tag(id uuid pk, name text unique, "createdAt" timestamptz)
 *
 * Existing distinct names on `ticket.tags` are backfilled so no
 * historical row loses its tags. New tag creation moves to the
 * admin API — the ticket PATCH DTO now rejects unknown names (with
 * a specific error message pointing admins at /tags).
 *
 * Deletion policy: dropping a tag from the catalogue does NOT strip
 * it from tickets that already have it. That would silently rewrite
 * historical ticket state on admin whim; better to let the orphan
 * stay visible on old tickets and simply prevent re-adding it.
 */
export class TagCatalog1726070000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.tag (
        id         uuid          NOT NULL DEFAULT uuid_generate_v4(),
        name       text          NOT NULL,
        "createdAt" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT tag_pkey PRIMARY KEY (id),
        CONSTRAINT tag_name_unique UNIQUE (name),
        CONSTRAINT chk_tag_name_shape CHECK (name ~ '^[a-z0-9-]+$')
      )
    `);

    // Backfill: every distinct name currently attached to any ticket
    // becomes a catalogue row. ON CONFLICT DO NOTHING keeps this
    // idempotent — safe to re-run.
    await queryRunner.query(`
      INSERT INTO public.tag (name)
      SELECT DISTINCT unnest(tags) AS name
      FROM public.ticket
      WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
      ON CONFLICT (name) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.tag`);
  }
}
