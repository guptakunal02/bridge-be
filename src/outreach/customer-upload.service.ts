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

/**
 * Which CSV columns map to which Customer field. Resolved from the
 * header row (first line of the CSV) via a synonym table. Shopify's
 * customer export uses `countrycode` + `phonenumber` + `firstname` +
 * `lastname`; a hand-written CSV might use `phone` + `name`; LimeChat
 * exports use `wa_id`. All three should "just work" without the admin
 * having to pre-process the file.
 */
interface ColumnMapping {
  phoneCol: string;
  countryCodeCol: string | null;
  nameCol: string | null;
  firstNameCol: string | null;
  lastNameCol: string | null;
  emailCol: string | null;
}

/** Lowercased header names that map to each Customer field. */
const PHONE_SYNONYMS = new Set([
  'phone',
  'phonenumber',
  'phone_number',
  'mobile',
  'mobile_number',
  'mobilenumber',
  'contact',
  'contact_number',
  'contactnumber',
  'wa_id',
  'whatsapp',
  'whatsapp_number',
  'number',
  'msisdn',
]);
const COUNTRY_CODE_SYNONYMS = new Set([
  'countrycode',
  'country_code',
  'cc',
  'dialcode',
  'dial_code',
]);
const NAME_SYNONYMS = new Set([
  'name',
  'full_name',
  'fullname',
  'customer_name',
  'customername',
  'display_name',
  'displayname',
]);
const FIRST_NAME_SYNONYMS = new Set([
  'firstname',
  'first_name',
  'given_name',
  'givenname',
]);
const LAST_NAME_SYNONYMS = new Set([
  'lastname',
  'last_name',
  'surname',
  'family_name',
  'familyname',
]);
const EMAIL_SYNONYMS = new Set([
  'email',
  'email_address',
  'emailaddress',
  'mail',
  'e_mail',
]);

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
    // Column-mapping is resolved from the header row via the synonym
    // tables; csv-parse's `columns` callback fires on the first row
    // and lets us capture that mapping into a closure before data
    // rows start streaming.
    let mapping: ColumnMapping | null = null;
    const parser = createReadStream(filePath).pipe(
      parse({
        columns: (headers: string[]) => {
          const normalised = headers.map((h) => h.trim().toLowerCase());
          mapping = resolveColumnMapping(normalised);
          // csv-parse keys records by whatever we return here. Return
          // the normalised names so `record[mapping.phoneCol]` works
          // without a second lookup.
          return normalised;
        },
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
      // Resolved on first data row — if the header mapping failed
      // (no phone-like column), surface a hard error so the admin
      // sees FAILED with a clear reason instead of 100% rejected.
      if (!mapping) {
        throw new Error(
          `No phone-like column found in CSV header. Expected one of: ` +
            `${[...PHONE_SYNONYMS].slice(0, 6).join(', ')}, …`,
        );
      }
      const parsed = this.validateRow(record, mapping, currentLine, counters);
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
    mapping: ColumnMapping,
    line: number,
    counters: WorkerCounters,
  ): ParsedRow | null {
    const rawPhone = (record[mapping.phoneCol] ?? '').toString().trim();
    if (!rawPhone) {
      this.reject(counters, line, 'missing phone');
      return null;
    }
    // Country code concatenation — only when BOTH columns exist AND
    // the phone value doesn't already carry its own prefix (digits
    // length ≥ 11 implies it does). Prevents double-prefixing on
    // CSVs that redundantly ship country code alongside an E.164-
    // style number.
    const cc = mapping.countryCodeCol
      ? (record[mapping.countryCodeCol] ?? '').toString().trim()
      : '';
    const phoneDigitsOnly = CustomersService.normalizePhone(rawPhone);
    const combined =
      cc && phoneDigitsOnly.length <= 10
        ? CustomersService.normalizePhone(cc + rawPhone)
        : phoneDigitsOnly;
    if (combined.length < 10) {
      this.reject(counters, line, `invalid phone "${rawPhone}"`);
      return null;
    }

    // Name resolution: dedicated `name` column wins; otherwise fall
    // back to `firstname [+ lastname]` concatenation. Null when
    // neither exists.
    let name: string | null = null;
    if (mapping.nameCol) {
      name = this.optional(record[mapping.nameCol]);
    } else if (mapping.firstNameCol || mapping.lastNameCol) {
      const first =
        (mapping.firstNameCol
          ? (record[mapping.firstNameCol] ?? '').toString()
          : '') ?? '';
      const last =
        (mapping.lastNameCol
          ? (record[mapping.lastNameCol] ?? '').toString()
          : '') ?? '';
      const combinedName = `${first.trim()} ${last.trim()}`.trim();
      name = combinedName.length > 0 ? combinedName : null;
    }

    const email = mapping.emailCol
      ? this.optional(record[mapping.emailCol])
      : null;

    return { phone: combined, name, email };
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

/**
 * Pick the right CSV columns to drive Customer upserts from the
 * header row's synonym matches. Returns null when NO phone-like
 * column exists — the streaming pipeline then throws a hard FAILED
 * error so the admin sees a clear reason instead of a mysterious
 * 100%-rejected upload.
 */
function resolveColumnMapping(normalised: string[]): ColumnMapping | null {
  const phoneCol = normalised.find((h) => PHONE_SYNONYMS.has(h));
  if (!phoneCol) return null;
  const countryCodeCol =
    normalised.find((h) => COUNTRY_CODE_SYNONYMS.has(h)) ?? null;
  const nameCol = normalised.find((h) => NAME_SYNONYMS.has(h)) ?? null;
  const firstNameCol =
    normalised.find((h) => FIRST_NAME_SYNONYMS.has(h)) ?? null;
  const lastNameCol =
    normalised.find((h) => LAST_NAME_SYNONYMS.has(h)) ?? null;
  const emailCol = normalised.find((h) => EMAIL_SYNONYMS.has(h)) ?? null;
  return {
    phoneCol,
    countryCodeCol,
    nameCol,
    firstNameCol,
    lastNameCol,
    emailCol,
  };
}

