import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { parse } from 'csv-parse';
import { createReadStream, promises as fs } from 'node:fs';
import { Repository } from 'typeorm';
import { CustomerSource, CustomerUploadStatus } from '../database/enums';
import { CustomersService, type UpsertRow } from './customers.service';
import { CustomerUpload } from './entities/customer-upload.entity';
import { SegmentsService } from './segments.service';

/**
 * Batch size tuned for Postgres: an INSERT ... VALUES with ~1k rows
 * takes ~15–30ms on the current RDS tier. Smaller batches add
 * round-trips; larger ones saturate PG_MAX_PARAMS (65535 ÷ 7 cols/row
 * ≈ 9,300 ceiling).
 */
const UPSERT_BATCH_SIZE = 1_000;
const COUNTER_FLUSH_EVERY_N_BATCHES = 5;
const MAX_REJECTIONS_STORED = 100;

/** Number of CSV data rows returned by the `stage` call for preview. */
const SAMPLE_ROWS_FOR_STAGE = 5;

/**
 * The shape of the mapping the admin posts to the `start` endpoint.
 * Both country_code and phone_number are mandatory — the service
 * rejects a start call missing either. The other three are optional;
 * their presence lives on `segment.mappedFields` so the broadcast
 * flow can later refuse templates that reference a field this
 * segment doesn't carry.
 */
export interface UploadMapping {
  country_code: string;
  phone_number: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export const MAPPABLE_FIELDS = [
  'country_code',
  'phone_number',
  'first_name',
  'last_name',
  'email',
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/**
 * Synonym tables for the SUGGESTED default mapping — not for actual
 * column resolution. The admin's explicit choice at the mapping step
 * is what the worker uses. Keeping these around means a reasonable
 * CSV (Shopify export, Bridge-authored, LimeChat export) auto-populates
 * sensible defaults; admin confirms with one click.
 */
const SYNONYMS: Record<MappableField, Set<string>> = {
  phone_number: new Set([
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
  ]),
  country_code: new Set([
    'countrycode',
    'country_code',
    'cc',
    'dialcode',
    'dial_code',
  ]),
  first_name: new Set([
    'firstname',
    'first_name',
    'given_name',
    'givenname',
    'name',
  ]),
  last_name: new Set([
    'lastname',
    'last_name',
    'surname',
    'family_name',
    'familyname',
  ]),
  email: new Set([
    'email',
    'email_address',
    'emailaddress',
    'mail',
    'e_mail',
  ]),
};

interface ParsedRow {
  phone: string;
  countryCode: string | null;
  phoneNumber: string | null;
  firstName: string | null;
  lastName: string | null;
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

export interface StageResult {
  uploadId: string;
  columns: string[];
  sampleRows: Array<Record<string, string>>;
  suggestedMapping: Partial<UploadMapping>;
}

/**
 * CSV upload lifecycle:
 *
 *   stage(file)       → creates upload row (status=PENDING, mapping=NULL),
 *                       parses the header + first 5 data rows, suggests a
 *                       mapping from synonyms. Admin UI renders the mapping
 *                       dialog with these defaults pre-selected.
 *   start(uploadId,
 *         mapping)    → validates mapping, stamps it onto the upload row,
 *                       updates segment.mappedFields, kicks the worker.
 *   worker reads the mapping and streams the file in 1k-row batches.
 *
 * Decoupling file-upload from column-selection prevents the earlier
 * failure mode where a Shopify export rejected every row because the
 * worker inferred the wrong column. The admin now explicitly tells us
 * which column is which.
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

  /**
   * File lands; we parse the header + first few data rows so the
   * admin UI can show a mapping dialog without a second upload. The
   * worker is NOT started yet.
   */
  async stage(input: {
    segmentId: string;
    uploadedBy: string;
    fileName: string;
    fileSize: number;
    filePath: string;
  }): Promise<StageResult> {
    const { columns, sampleRows } = await this.readHeaderAndSample(
      input.filePath,
    );
    const suggestedMapping = suggestMapping(columns);
    const row = this.uploads.create({
      segment_id: input.segmentId,
      uploaded_by: input.uploadedBy,
      file_name: input.fileName,
      file_size: String(input.fileSize),
      status: CustomerUploadStatus.PENDING,
      // mapping stays NULL until `start` is called. The admin UI uses
      // (status=PENDING + mapping=NULL) as the "staged, waiting for
      // mapping" signal.
    });
    const saved = await this.uploads.save(row);
    // Stash file path on an in-memory map keyed by uploadId. Simpler
    // than carrying it on the DB row (which would need a new column
    // and the path is only valid for the brief stage→start window).
    this.pendingFilePaths.set(saved.id, input.filePath);
    return {
      uploadId: saved.id,
      columns,
      sampleRows,
      suggestedMapping,
    };
  }

  /**
   * Admin confirms the mapping; worker starts.
   */
  async start(
    uploadId: string,
    mapping: UploadMapping,
  ): Promise<CustomerUpload> {
    const upload = await this.uploads.findOne({ where: { id: uploadId } });
    if (!upload) throw new NotFoundException(`Upload ${uploadId} not found`);
    if (upload.mapping) {
      throw new BadRequestException(
        `Upload ${uploadId} already started — mapping is immutable`,
      );
    }
    const filePath = this.pendingFilePaths.get(uploadId);
    if (!filePath) {
      // Process restart between stage and start would land here —
      // the in-memory map is gone. Fail cleanly; admin re-uploads.
      await this.uploads.update(uploadId, {
        status: CustomerUploadStatus.FAILED,
        error: 'Upload file not found (server restarted between stage and start — please re-upload)',
        completed_at: new Date(),
      });
      throw new BadRequestException(
        'Upload file not found — please re-upload',
      );
    }
    this.pendingFilePaths.delete(uploadId);

    await this.uploads.update(uploadId, { mapping });

    // Compute which optional fields the admin chose + persist to
    // segment.mapped_fields so broadcast can later verify templates.
    const chosenOptionalFields = (['first_name', 'last_name', 'email'] as const)
      .filter((f) => Boolean(mapping[f]));
    await this.segments.setMappedFields(upload.segment_id, [
      'country_code',
      'phone_number',
      ...chosenOptionalFields,
    ]);

    setImmediate(() => {
      void this.runWorker(uploadId, filePath, mapping).catch((err) => {
        this.logger.error(
          `runWorker unhandled error upload=${uploadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
    return (await this.uploads.findOne({ where: { id: uploadId } }))!;
  }

  /** Pending file paths — see stage() for why this is in-memory. */
  private readonly pendingFilePaths = new Map<string, string>();

  async findById(id: string): Promise<CustomerUpload | null> {
    return this.uploads.findOne({ where: { id } });
  }

  async listForSegment(segmentId: string): Promise<CustomerUpload[]> {
    return this.uploads.find({
      where: { segment_id: segmentId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Read just the header + first few data rows for the mapping
   * dialog preview. Streams; terminates early once SAMPLE_ROWS_FOR_STAGE
   * data rows have been collected — doesn't load the full file.
   */
  private async readHeaderAndSample(filePath: string): Promise<{
    columns: string[];
    sampleRows: Array<Record<string, string>>;
  }> {
    let columns: string[] = [];
    const sampleRows: Array<Record<string, string>> = [];
    const parser = createReadStream(filePath).pipe(
      parse({
        columns: (headers: string[]) => {
          columns = headers.map((h) => h.trim());
          return headers.map((h) => h.trim());
        },
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
      }),
    );
    for await (const record of parser) {
      sampleRows.push(record as Record<string, string>);
      if (sampleRows.length >= SAMPLE_ROWS_FOR_STAGE) break;
    }
    parser.destroy();
    if (columns.length === 0) {
      throw new BadRequestException('CSV has no header row');
    }
    return { columns, sampleRows };
  }

  /** Background job that uses the admin-chosen mapping. */
  private async runWorker(
    uploadId: string,
    filePath: string,
    mapping: UploadMapping,
  ): Promise<void> {
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
      await this.streamAndProcess(
        uploadId,
        upload.segment_id,
        filePath,
        mapping,
        counters,
      );
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

  private async streamAndProcess(
    uploadId: string,
    segmentId: string,
    filePath: string,
    mapping: UploadMapping,
    counters: WorkerCounters,
  ): Promise<void> {
    const parser = createReadStream(filePath).pipe(
      parse({
        columns: (headers: string[]) => headers.map((h) => h.trim()),
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
      }),
    );

    let batch: ParsedRow[] = [];
    let batchesSinceFlush = 0;
    let currentLine = 1;

    for await (const record of parser) {
      currentLine += 1;
      counters.total += 1;
      const parsed = this.validateRow(record, mapping, currentLine, counters);
      if (!parsed) continue;
      batch.push(parsed);

      if (batch.length >= UPSERT_BATCH_SIZE) {
        await this.flushBatch(segmentId, batch, counters);
        batch = [];
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

  private validateRow(
    record: Record<string, string>,
    mapping: UploadMapping,
    line: number,
    counters: WorkerCounters,
  ): ParsedRow | null {
    const rawCountryCode = (record[mapping.country_code] ?? '')
      .toString()
      .trim();
    const rawPhoneNumber = (record[mapping.phone_number] ?? '')
      .toString()
      .trim();
    if (!rawPhoneNumber) {
      this.reject(counters, line, 'missing phone_number');
      return null;
    }
    const countryCode = rawCountryCode.replace(/\D/g, '') || null;
    const phoneNumberDigits = rawPhoneNumber.replace(/\D/g, '');
    if (phoneNumberDigits.length < 7) {
      // 7 is the shortest reasonable phone (some African countries);
      // Indian is 10. Below this is almost certainly a stray column.
      this.reject(counters, line, `invalid phone_number "${rawPhoneNumber}"`);
      return null;
    }
    // Combined phone is `country_code || phone_number`. If the admin
    // didn't map country_code OR the cell is blank, fall back to the
    // phone_number alone — Phase 3 broadcast will skip these when
    // sending via Meta (which requires the country prefix).
    const combinedPhone = countryCode
      ? countryCode + phoneNumberDigits
      : phoneNumberDigits;

    const firstName = mapping.first_name
      ? this.optional(record[mapping.first_name])
      : null;
    const lastName = mapping.last_name
      ? this.optional(record[mapping.last_name])
      : null;
    const email = mapping.email
      ? this.optional(record[mapping.email])
      : null;

    return {
      phone: combinedPhone,
      countryCode,
      phoneNumber: phoneNumberDigits,
      firstName,
      lastName,
      email,
    };
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
      countryCode: r.countryCode,
      phoneNumber: r.phoneNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
    }));
    const { ids, insertedCount, updatedCount } =
      await this.customers.upsertBatch(upsertRows, CustomerSource.CSV);
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
      this.logger.warn(
        `failed to unlink ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Best-guess mapping based on CSV header name synonyms. The admin's
 * explicit confirmation (or override) at the mapping step is what
 * the worker actually uses — this just makes the common case
 * one-click.
 *
 * Precedence note: the `first_name` synonym set includes `name`,
 * which also legitimately maps to a full-name column. If the CSV has
 * both `name` AND `firstname`, we prefer `firstname` (precedence by
 * synonym-set order within each field).
 */
function suggestMapping(columns: string[]): Partial<UploadMapping> {
  const lower = columns.map((c) => c.toLowerCase());
  const pickOne = (field: MappableField): string | undefined => {
    const synonyms = SYNONYMS[field];
    const idx = lower.findIndex((h) => synonyms.has(h));
    return idx >= 0 ? columns[idx] : undefined;
  };
  const suggested: Partial<UploadMapping> = {};
  const cc = pickOne('country_code');
  if (cc) suggested.country_code = cc;
  const ph = pickOne('phone_number');
  if (ph) suggested.phone_number = ph;
  const fn = pickOne('first_name');
  if (fn) suggested.first_name = fn;
  const ln = pickOne('last_name');
  if (ln) suggested.last_name = ln;
  const em = pickOne('email');
  if (em) suggested.email = em;
  return suggested;
}
