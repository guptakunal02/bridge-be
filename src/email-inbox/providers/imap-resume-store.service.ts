import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export type ImapResumeMode = 'inbox' | 'sent';

/**
 * Persistence for the IMAP worker's "where did I leave off?" cursor
 * — one row per channel, two columns (one per folder) on
 * `channel.last_processed_inbox_uid` / `channel.last_processed_sent_uid`.
 *
 * The worker reads at `start()` to resume where it stopped last
 * time (critical: without this, every pm2 restart silently buries
 * any mail that landed in the folder while the process was down —
 * see migration 1726190000000). Updates are triggered at the END
 * of every successful drain cycle; idempotency on
 * `email_message.external_message_id` already covers the race
 * where the process crashes between message persist and this UPDATE.
 *
 * `read()` returns null for brand-new channels or ones that
 * pre-date this column — the caller falls back to the folder's
 * current `uidNext - 1` so first-boot semantics are unchanged.
 */
@Injectable()
export class ImapResumeStore {
  private readonly logger = new Logger(ImapResumeStore.name);

  constructor(
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
  ) {}

  async read(channelId: string, mode: ImapResumeMode): Promise<number | null> {
    const row = await this.channels.findOne({
      where: { id: channelId },
      select: {
        id: true,
        last_processed_inbox_uid: true,
        last_processed_sent_uid: true,
      },
    });
    if (!row) return null;
    return mode === 'sent'
      ? row.last_processed_sent_uid
      : row.last_processed_inbox_uid;
  }

  async write(
    channelId: string,
    mode: ImapResumeMode,
    uid: number,
  ): Promise<void> {
    const column =
      mode === 'sent' ? 'last_processed_sent_uid' : 'last_processed_inbox_uid';
    try {
      await this.channels.update({ id: channelId }, { [column]: uid });
    } catch (err) {
      // Non-fatal — a failed cursor write just means the worker
      // might re-process the latest batch on next boot (safe, since
      // ingest is idempotent on external_message_id). Log so a
      // persistent write failure gets noticed.
      this.logger.warn(
        `[imap:${channelId}:${mode}] cursor persist failed uid=${uid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
