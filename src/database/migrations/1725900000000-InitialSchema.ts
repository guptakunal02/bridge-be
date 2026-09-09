import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline migration — drops the legacy Prisma-managed schema (if
 * present) and creates the new 5-table TypeORM schema:
 *   user, channel, ticket, email_message, ticket_activity_log
 *
 * Safe to run on both:
 *   - a prod DB still carrying Prisma tables (they get dropped)
 *   - a fresh empty DB (the DROP IF EXISTS statements are no-ops)
 *
 * Not safe to re-run on a DB already at this schema — TypeORM's
 * `migrations` table tracks that so it only ever runs once.
 */
export class InitialSchema1725900000000 implements MigrationInterface {
  name = 'InitialSchema1725900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- Drop legacy Prisma schema ----------
    const legacyTables = [
      'MessageAttachment',
      'Message',
      'Conversation',
      'Contact',
      'EmailChallenge',
      'UserChannel',
      'Invitation',
      'RefreshToken',
      'Channel',
      'User',
      '_prisma_migrations',
    ];
    for (const t of legacyTables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }

    const legacyEnums = [
      'AgentRole',
      'AgentStatus',
      'UserRole',
      'UserStatus',
      'ChannelType',
      'ChannelStatus',
      'ConversationStatus',
      'MessageDirection',
      'MessageAuthorType',
      'MessageType',
      'MessageDeliveryStatus',
    ];
    for (const e of legacyEnums) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${e}" CASCADE`);
    }

    // ---------- Extensions ----------
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ---------- Enums ----------
    await queryRunner.query(
      `CREATE TYPE public.user_role_enum AS ENUM ('MEMBER', 'ADMIN', 'BOT')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.user_status_enum AS ENUM ('ONLINE', 'AWAY', 'OFFLINE')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.channel_type_enum AS ENUM ('INSTAGRAM', 'WHATSAPP', 'EMAIL')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.channel_status_enum AS ENUM ('CONNECTED', 'DISCONNECTED')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.ticket_status_enum AS ENUM ('OPEN', 'IN_FOLLOWUP', 'WAITING', 'RESOLVED')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.ticket_channel_type_enum AS ENUM ('INSTAGRAM', 'WHATSAPP', 'EMAIL')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.email_message_type_enum AS ENUM ('SENT', 'RECEIVED')`,
    );
    await queryRunner.query(`
      CREATE TYPE public.ticket_activity_log_event_enum AS ENUM (
        'CREATED', 'ASSIGNED_TO_BOT', 'ASSIGNED_TO_AGENT', 'REASSIGNED_TO_AGENT',
        'PUT_INTO_FOLLOWUP', 'PUT_INTO_WAITING', 'MARKED_RESOLVED', 'REOPENED',
        'NOTES_ADDED', 'SENT_BACK_TO_QUEUE'
      )
    `);

    // ---------- user ----------
    await queryRunner.query(`
      CREATE TABLE public."user" (
        id                       uuid                    NOT NULL DEFAULT uuid_generate_v4(),
        "googleSub"              text,
        email                    text,
        name                     text                    NOT NULL,
        phone                    text,
        "photoUrl"               text,
        role                     user_role_enum          NOT NULL DEFAULT 'MEMBER',
        status                   user_status_enum        NOT NULL DEFAULT 'OFFLINE',
        "isApproved"             boolean                 NOT NULL DEFAULT false,
        "lastSeenAt"             timestamptz,
        "deactivatedAt"          timestamptz,
        "refreshTokenHash"       text,
        "refreshTokenExpiresAt"  timestamptz,
        "createdAt"              timestamptz             NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT user_pkey PRIMARY KEY (id),
        CONSTRAINT user_googleSub_uniq UNIQUE ("googleSub"),
        CONSTRAINT user_email_uniq UNIQUE (email)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX user_role_isApproved_deactivatedAt_idx
        ON public."user" (role, "isApproved", "deactivatedAt")
    `);

    // ---------- channel ----------
    await queryRunner.query(`
      CREATE TABLE public.channel (
        id                       uuid                    NOT NULL DEFAULT uuid_generate_v4(),
        type                     channel_type_enum       NOT NULL,
        "displayName"            text                    NOT NULL,
        inbox_contact            text,
        credentials_encrypted    text,
        "credentialsVerifiedAt"  timestamptz,
        status                   channel_status_enum     NOT NULL DEFAULT 'DISCONNECTED',
        "createdAt"              timestamptz             NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT channel_pkey PRIMARY KEY (id),
        CONSTRAINT channel_displayName_uniq UNIQUE ("displayName")
      )
    `);

    // ---------- ticket ----------
    await queryRunner.query(`
      CREATE TABLE public.ticket (
        id                       bigserial               NOT NULL,
        channel_id               uuid                    NOT NULL,
        channel_type             ticket_channel_type_enum NOT NULL,
        assignee                 uuid                    NOT NULL,
        status                   ticket_status_enum      NOT NULL,
        is_reopened              boolean                 NOT NULL DEFAULT false,
        refund_related           boolean                 NOT NULL DEFAULT false,
        thread_key               text                    NOT NULL,
        "createdAt"              timestamptz             NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz             NOT NULL DEFAULT now(),
        "deletedAt"              timestamptz,
        CONSTRAINT ticket_pkey PRIMARY KEY (id),
        CONSTRAINT ticket_channel_thread_key_unique UNIQUE (channel_id, thread_key),
        CONSTRAINT ticket_channel_fk FOREIGN KEY (channel_id)
          REFERENCES public.channel(id) ON DELETE CASCADE,
        CONSTRAINT ticket_assignee_fk FOREIGN KEY (assignee)
          REFERENCES public."user"(id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX ticket_assignee_status_idx ON public.ticket (assignee, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ticket_status_updatedAt_idx" ON public.ticket (status, "updatedAt")`,
    );

    // ---------- email_message ----------
    await queryRunner.query(`
      CREATE TABLE public.email_message (
        id                       uuid                    NOT NULL DEFAULT uuid_generate_v4(),
        "channelId"              uuid                    NOT NULL,
        subject                  text,
        type                     email_message_type_enum NOT NULL,
        content                  text                    NOT NULL,
        sender                   text,
        receiver                 text[]                  NOT NULL DEFAULT '{}',
        ticket_id                bigint                  NOT NULL,
        external_message_id      text                    NOT NULL,
        "createdAt"              timestamptz             NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz             NOT NULL DEFAULT now(),
        "deletedAt"              timestamptz,
        CONSTRAINT email_message_pkey PRIMARY KEY (id),
        CONSTRAINT email_message_external_uniq UNIQUE (external_message_id),
        CONSTRAINT email_message_channel_fk FOREIGN KEY ("channelId")
          REFERENCES public.channel(id) ON DELETE CASCADE,
        CONSTRAINT email_message_ticket_fk FOREIGN KEY (ticket_id)
          REFERENCES public.ticket(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "email_message_channelId_createdAt_idx" ON public.email_message ("channelId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "email_message_ticket_createdAt_idx" ON public.email_message (ticket_id, "createdAt")`,
    );

    // ---------- ticket_activity_log ----------
    await queryRunner.query(`
      CREATE TABLE public.ticket_activity_log (
        id                       uuid                    NOT NULL DEFAULT uuid_generate_v4(),
        ticket_id                bigint                  NOT NULL,
        event                    ticket_activity_log_event_enum,
        log                      text,
        "createdAt"              timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT ticket_activity_log_pkey PRIMARY KEY (id),
        CONSTRAINT ticket_activity_log_ticket_fk FOREIGN KEY (ticket_id)
          REFERENCES public.ticket(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ticket_activity_log_ticket_createdAt_idx"
         ON public.ticket_activity_log (ticket_id, "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.ticket_activity_log CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.email_message CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.ticket CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.channel CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public."user" CASCADE`);

    const enums = [
      'ticket_activity_log_event_enum',
      'email_message_type_enum',
      'ticket_channel_type_enum',
      'ticket_status_enum',
      'channel_status_enum',
      'channel_type_enum',
      'user_status_enum',
      'user_role_enum',
    ];
    for (const e of enums) {
      await queryRunner.query(`DROP TYPE IF EXISTS public.${e} CASCADE`);
    }
  }
}
