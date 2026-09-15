import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bot / conversational-flow schema.
 *
 *   bot_flow
 *     - a named entry point that starts when its trigger fires and
 *       optional trigger_conditions match
 *     - first_step_id is the entry point step (nullable while the
 *       admin is drafting a flow that has no steps yet)
 *
 *   bot_step
 *     - one node in the flow. `position` drives the FE render order
 *       and the runtime's default fall-through for linear step types
 *       (message / function); explicit navigation lives in `config`
 *       for question / branch (see BotStepType docs)
 *     - config JSONB stores everything type-specific — text bodies,
 *       option → nextStepId maps, function inputs, branch condition
 *       trees, handoff team target
 *
 *   bot_session
 *     - one row per active bot-driven conversation, keyed by
 *       ticket_id (UNIQUE — a ticket has at most one live session)
 *     - variables JSONB is the runtime's mutable state; each function
 *       output or captured answer lands here under the flow-defined
 *       key
 */
export class BotFlowSchema1726020000000 implements MigrationInterface {
  name = 'BotFlowSchema1726020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE public.bot_trigger_enum AS ENUM (
        'ticket.created',
        'ticket.message.received',
        'ticket.tag.added'
      )`,
    );
    await queryRunner.query(
      `CREATE TYPE public.bot_step_type_enum AS ENUM (
        'message', 'question', 'function', 'branch', 'handoff'
      )`,
    );
    await queryRunner.query(
      `CREATE TYPE public.bot_session_status_enum AS ENUM (
        'active', 'completed', 'handoff', 'failed'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE public.bot_flow (
        id                    uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
        name                  text                    NOT NULL,
        description           text,
        trigger               bot_trigger_enum        NOT NULL,
        trigger_conditions    jsonb,
        is_active             boolean                 NOT NULL DEFAULT true,
        first_step_id         uuid,
        "createdAt"           timestamptz             NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz             NOT NULL DEFAULT NOW(),
        CONSTRAINT bot_flow_name_uniq UNIQUE (name)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX bot_flow_trigger_active_idx ON public.bot_flow (trigger, is_active)`,
    );

    await queryRunner.query(`
      CREATE TABLE public.bot_step (
        id           uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
        flow_id      uuid                 NOT NULL,
        position     integer              NOT NULL,
        type         bot_step_type_enum   NOT NULL,
        config       jsonb                NOT NULL DEFAULT '{}',
        "createdAt"  timestamptz          NOT NULL DEFAULT NOW(),
        "updatedAt"  timestamptz          NOT NULL DEFAULT NOW(),
        CONSTRAINT bot_step_flow_fk FOREIGN KEY (flow_id)
          REFERENCES public.bot_flow (id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX bot_step_flow_position_idx ON public.bot_step (flow_id, position)`,
    );

    // first_step_id has to point at a bot_step; add the FK after the
    // step table exists. ON DELETE SET NULL so deleting the entry
    // step leaves the flow orphan-able rather than cascading the flow.
    await queryRunner.query(
      `ALTER TABLE public.bot_flow
         ADD CONSTRAINT bot_flow_first_step_fk
         FOREIGN KEY (first_step_id) REFERENCES public.bot_step (id) ON DELETE SET NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE public.bot_session (
        id                uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_id         bigint                      NOT NULL,
        flow_id           uuid                        NOT NULL,
        current_step_id   uuid,
        variables         jsonb                       NOT NULL DEFAULT '{}',
        status            bot_session_status_enum     NOT NULL DEFAULT 'active',
        "startedAt"       timestamptz                 NOT NULL DEFAULT NOW(),
        "updatedAt"       timestamptz                 NOT NULL DEFAULT NOW(),
        CONSTRAINT bot_session_ticket_uniq UNIQUE (ticket_id),
        CONSTRAINT bot_session_ticket_fk FOREIGN KEY (ticket_id)
          REFERENCES public.ticket (id) ON DELETE CASCADE,
        CONSTRAINT bot_session_flow_fk FOREIGN KEY (flow_id)
          REFERENCES public.bot_flow (id) ON DELETE CASCADE,
        CONSTRAINT bot_session_step_fk FOREIGN KEY (current_step_id)
          REFERENCES public.bot_step (id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX bot_session_status_idx ON public.bot_session (status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.bot_session CASCADE`);
    await queryRunner.query(
      `ALTER TABLE public.bot_flow DROP CONSTRAINT IF EXISTS bot_flow_first_step_fk`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.bot_step CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.bot_flow CASCADE`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS public.bot_session_status_enum`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS public.bot_step_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS public.bot_trigger_enum`);
  }
}
