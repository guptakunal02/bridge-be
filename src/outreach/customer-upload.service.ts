import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { parse } from 'csv-parse';
import { createReadStream, promises as fs } from 'node:fs';
import { Repository } from 'typeorm';
import { CustomerSource, CustomerUploadStatus } from '../database/enums';
import { CustomersService, type UpsertRow } from './customers.service';
import { CustomerUpload } from './entities/customer-upload.entity';
import { SegmentsService } from './segments.service';

/**
 * Batch size tuned for Postgres: an INSERT ... VALUES with ~1k
 * rows takes ~15–30ms on the current RDS tier (verified on the
 * ticket-backfill scripts). Smaller batches add round-trips;
 * larger batches saturate the single-query parameter limit
 * (PG_MAX_PARAMS = 65535, we use 4 per row → 16,383 ceiling).
 */
const UPSERT_BATCH_SIZE = 1_000;

/**
 * Progress updates on a 200k row file would otherwise write to
 * the DB 200 times. Flush less often (every 5 batches = every
 * 5k rows) so the counter advances visibly in the admin UI
 * without saturating the row.
 */
const COUNTER_FLUSH_EVERY_N_BATCHES = 5;

/** Keep the rejection log bounded so a mostly-dirty CSV doesn't bloat the row. */
const MAX_REJECTIONS_STORED = 100;

interface ParsedRow {
  phone: string;
  name: string | null;
  email: string | null;
}

interface WorkerCounters {
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  rejected: number;
  rejections: Array<{ line: number; reason: string }>;
}

/**
 * CSV upload lifecycle: create a durable job row, stream-parse
 * the file, upsert in batches, update progress counters.
 *
 * The worker never throws out of `runWorker` — any fatal error
 * is captured onto the row (`status=FAILED`, `error=...message`)
 * so the admin UI's polling endpoint always has an explanation.
 *
 * File on disk is deleted at the end (success or failure); if
 * the process dies mid-upload the file lingers in /tmp until
 * the OS cleans it. Acceptable — these are admin uploads, not
 * public writes, and the row's status column lets the admin
 * decide whether to retry.
 */
@Injectable()
export class CustomerUploadService {
  private readonly logger = new Logger(CustomerUploadService.name);

  constructor(
    @InjectRepository(CustomerUpload)
    private readonly uploads: Repository<CustomerUpload>,
    private readonly customers: CustomersService,
    private readonly segments: SegmentsService,
  ) {}

  async create(input: {
    segmentId: string;
    uploadedBy: string;
    fileName: string;
    fileSize: number;
    filePath: string;
  }): Promise<CustomerUpload> {
    const row = this.uploads.create({
      segment_id: input.segmentId,
      uploaded_by: input.uploadedBy,
      file_name: input.fileName,
      file_size: String(input.fileSize),
      status: CustomerUploadStatus.PENDING,
    });
    const saved = await this.uploads.save(row);
    // setImmediate (not setTimeout(0)) ensures Nest finishes the
    // request-response cycle before the worker starts chewing CPU.
    // The worker owns its own error handling; any synchronous throw
    // here would crash the Node process, so wrap defensively.
    setImmediate(() => {
      void this.runWorker(saved.id, input.filePath).catch((err) => {
        this.logger.error(
          `runWorker unhandled error upload=${saved.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
    return saved;
  }

  async findById(id: string): Promise<CustomerUpload | null> {
    return this.uploads.findOne({ where: { id } });
  }

  async listForSegment(segmentId: string): Promise<CustomerUpload[]> {
    return this.uploads.find({
      where: { segment_id: segmentId },
      order: { createdAt: 'DESC' },
    });
  }

  /** The entire background job. */
  private async runWorker(uploadId: string, filePath: string): Promise<void> {
    const upload = await this.uploads.findOne({ where: { id: uploadId } });
    if (!upload) {
      this.logger.error(`runWorker: upload ${uploadId} vanished`);
      await this.safeDelete(filePath);
      return;
    }
    await this.uploads.update(uploadId, {
      status: CustomerUploadStatus.PROCESSING,
    });

    const counters: WorkerCounters = {
      total: 0,
      processed: 0,
      succeeded: 0,
      skipped: 0,
      rejected: 0,
      rejections: [],
    };

    try {
      await this.streamAndProcess(uploadId, upload.segment_id, filePath, counters);
      await this.uploads.update(uploadId, {
        status: CustomerUploadStatus.COMPLETED,
        total_rows: counters.total,
        processed_rows: counters.processed,
        succeeded_rows: counters.succeeded,
        skipped_rows: counters.skipped,
        rejected_rows: counters.rejected,
        rejections: counters.rejections,
        completed_at: new Date(),
      });
      this.logger.log(
        `upload ${uploadId} completed: ${counters.succeeded} new, ${counters.skipped} existing, ${counters.rejected} rejected`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.uploads.update(uploadId, {
        status: CustomerUploadStatus.FAILED,
        total_rows: counters.total,
        processed_rows: counters.processed,
        succeeded_rows: counters.succeeded,
        skipped_rows: counters.skipped,
        rejected_rows: counters.rejected,
        rejections: counters.rejections,
        error: msg,
        completed_at: new Date(),
      });
      this.logger.error(`upload ${uploadId} failed: ${msg}`);
    } finally {
      await this.safeDelete(filePath);
    }
  }

  /**
   * Core streaming pipeline. csv-parse pushes one record at a time;
   * we buffer until UPSERT_BATCH_SIZE then flush. Processed +
   * succeeded + skipped + rejected counters are updated per-batch
   * in-memory, and persisted every COUNTER_FLUSH_EVERY_N_BATCHES
   * batches so the admin UI's polling query sees progress without
   * doubling the DB write volume.
   */
  private async streamAndProcess(
    uploadId: string,
    segmentId: string,
    filePath: string,
    counters: WorkerCounters,
  ): Promise<void> {
    const parser = createReadStream(filePath).pipe(
      parse({
        columns: (headers: string[]) =>
          headers.map((h) => h.trim().toLowerCase()),
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
      }),
    );

    let batch: ParsedRow[] = [];
    let batchLineRange: Array<{ line: number }> = [];
    let batchesSinceFlush = 0;
    let currentLine = 1;

    for await (const record of parser) {
      currentLine += 1;
      counters.total += 1;
      const parsed = this.validateRow(record, currentLine, counters);
      if (!parsed) continue;
      batch.push(parsed);
      batchLineRange.push({ line: currentLine });

      if (batch.length >= UPSERT_BATCH_SIZE) {
        await this.flushBatch(segmentId, batch, counters);
        batch = [];
        batchLineRange = [];
        batchesSinceFlush += 1;
        if (batchesSinceFlush >= COUNTER_FLUSH_EVERY_N_BATCHES) {
          await this.persistCounters(uploadId, counters);
          batchesSinceFlush = 0;
        }
      }
    }
    if (batch.length > 0) {
      await this.flushBatch(segmentId, batch, counters);
    }
    await this.persistCounters(uploadId, counters);
  }

  /**
   * Validate ONE parsed CSV record. Returns the row ready for
   * upsert or null if rejected (with reason captured on counters,
   * truncated to MAX_REJECTIONS_STORED to keep the row small).
   *
   * Only the phone column is strictly required; name + email are
   * both optional. Phone is normalised to digits and must be
   * ≥ 10 digits — Indian numbers are 10 digits bare, 12 with
   * country code. A shorter string is almost certainly a typo
   * / stray column.
   */
  private validateRow(
    record: Record<string, string>,
    line: number,
    counters: WorkerCounters,
  ): ParsedRow | null {
    const rawPhone = (record['phone'] ?? '').toString().trim();
    if (!rawPhone) {
      this.reject(counters, line, 'missing phone');
      return null;
    }
    const normalised = CustomersService.normalizePhone(rawPhone);
    if (normalised.length < 10) {
      this.reject(counters, line, `invalid phone "${rawPhone}"`);
      return null;
    }
    const name = this.optional(record['name']);
    const email = this.optional(record['email']);
    return { phone: normalised, name, email };
  }

  private optional(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private reject(
    counters: WorkerCounters,
    line: number,
    reason: string,
  ): void {
    counters.rejected += 1;
    counters.processed += 1;
    if (counters.rejections.length < MAX_REJECTIONS_STORED) {
      counters.rejections.push({ line, reason });
    }
  }

  private async flushBatch(
    segmentId: string,
    batch: ParsedRow[],
    counters: WorkerCounters,
  ): Promise<void> {
    const upsertRows: UpsertRow[] = batch.map((r) => ({
      phone: r.phone,
      name: r.name,
      email: r.email,
    }));
    const { ids, insertedCount, updatedCount } =
      await this.customers.upsertBatch(upsertRows, CustomerSource.CSV);
    // CustomersService.upsertBatch dedupes within the batch before
    // issuing the SQL (Postgres rejects `ON CONFLICT DO UPDATE` on
    // repeated conflict keys in one VALUES list). The collapsed
    // duplicates are "redundant" rows — the admin shipped them, we
    // ran them through, and they contributed no new work. Bucket
    // them into `skipped` so the accounting adds up:
    //   processed = succeeded + skipped + rejected
    const intraBatchDupes =
      batch.length - (insertedCount + updatedCount);
    counters.succeeded += insertedCount;
    counters.skipped += updatedCount + intraBatchDupes;
    counters.processed += batch.length;
    await this.segments.addMembershipsBatch(segmentId, ids);
  }

  private async persistCounters(
    uploadId: string,
    counters: WorkerCounters,
  ): Promise<void> {
    await this.uploads.update(uploadId, {
      total_rows: counters.total,
      processed_rows: counters.processed,
      succeeded_rows: counters.succeeded,
      skipped_rows: counters.skipped,
      rejected_rows: counters.rejected,
      rejections: counters.rejections,
    });
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      // Already gone or race with another worker — harmless.
      this.logger.warn(
        `failed to unlink ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
