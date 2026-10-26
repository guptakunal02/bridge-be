import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { CustomerUploadStatus } from '../database/enums';
import {
  CustomerUploadService,
  MAPPABLE_FIELDS,
  type UploadMapping,
} from './customer-upload.service';
import { SegmentsService } from './segments.service';

const UPLOAD_DIR = '/tmp/bridge-uploads';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  /* already exists */
}

/**
 * Admin uploads CSVs against an existing segment through a two-step
 * flow:
 *
 *   POST /segments/:id/uploads/stage          (multipart)
 *     Parses header + first 5 data rows, suggests a mapping based
 *     on common synonyms, returns { uploadId, columns, sampleRows,
 *     suggestedMapping }. Worker is NOT started.
 *
 *   POST /segments/:id/uploads/:uploadId/start   (JSON mapping)
 *     Validates the admin's chosen mapping, stamps it onto the
 *     upload row + segment.mapped_fields, kicks the worker. Admin
 *     then polls GET /uploads/:uid for progress as before.
 *
 * The split avoids the old "guess and silently reject everything"
 * failure mode where a Shopify export's `phonenumber` + `firstname`
 * + `lastname` columns went unrecognized.
 */
@Controller('segments/:segmentId/uploads')
@AdminOnly()
export class CustomerUploadsController {
  constructor(
    private readonly uploads: CustomerUploadService,
    private readonly segments: SegmentsService,
  ) {}

  @Post('stage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          cb(null, `${stamp}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase();
        if (!name.endsWith('.csv')) {
          cb(new BadRequestException('Only .csv files are accepted'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async stage(
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    uploadId: string;
    columns: string[];
    sampleRows: Array<Record<string, string>>;
    suggestedMapping: Partial<UploadMapping>;
  }> {
    if (!file) throw new BadRequestException('file field is required');
    await this.segments.findById(segmentId); // verifies segment exists
    return this.uploads.stage({
      segmentId,
      uploadedBy: user.id,
      fileName: file.originalname,
      fileSize: file.size,
      filePath: file.path,
    });
  }

  @Post(':uploadId/start')
  async start(
    @Param('segmentId', new ParseUUIDPipe()) _segmentId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @Body() body: { mapping: UploadMapping },
  ): Promise<{
    uploadId: string;
    status: CustomerUploadStatus;
  }> {
    const mapping = body?.mapping;
    if (!mapping || typeof mapping !== 'object') {
      throw new BadRequestException('mapping object is required');
    }
    // country_code and phone_number are mandatory. Other fields are
    // optional — their presence propagates to segment.mapped_fields
    // so broadcast-time template validation can refuse mismatches.
    if (
      !mapping.country_code ||
      !mapping.phone_number ||
      typeof mapping.country_code !== 'string' ||
      typeof mapping.phone_number !== 'string'
    ) {
      throw new BadRequestException(
        'mapping.country_code and mapping.phone_number are both required',
      );
    }
    // Guard against stray keys from a buggy client — only MAPPABLE_FIELDS
    // are honoured; everything else is dropped so an admin's accidental
    // {foo: "bar"} doesn't end up persisted on the upload row.
    const sanitised: UploadMapping = {
      country_code: mapping.country_code,
      phone_number: mapping.phone_number,
      ...(mapping.first_name
        ? { first_name: String(mapping.first_name) }
        : {}),
      ...(mapping.last_name
        ? { last_name: String(mapping.last_name) }
        : {}),
      ...(mapping.email ? { email: String(mapping.email) } : {}),
    };
    const _mappable = MAPPABLE_FIELDS; // keep for compile-time check
    void _mappable;
    const row = await this.uploads.start(uploadId, sanitised);
    return { uploadId: row.id, status: row.status };
  }

  @Get()
  async list(
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
  ): Promise<
    Array<{
      id: string;
      file_name: string;
      status: CustomerUploadStatus;
      total_rows: number;
      processed_rows: number;
      succeeded_rows: number;
      skipped_rows: number;
      rejected_rows: number;
      mapping: UploadMapping | null;
      createdAt: Date;
      completed_at: Date | null;
    }>
  > {
    const rows = await this.uploads.listForSegment(segmentId);
    return rows.map((r) => ({
      id: r.id,
      file_name: r.file_name,
      status: r.status,
      total_rows: r.total_rows,
      processed_rows: r.processed_rows,
      succeeded_rows: r.succeeded_rows,
      skipped_rows: r.skipped_rows,
      rejected_rows: r.rejected_rows,
      mapping: r.mapping,
      createdAt: r.createdAt,
      completed_at: r.completed_at,
    }));
  }

  @Get(':uploadId')
  async getStatus(
    @Param('segmentId', new ParseUUIDPipe()) _segmentId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{
    id: string;
    status: CustomerUploadStatus;
    total_rows: number;
    processed_rows: number;
    succeeded_rows: number;
    skipped_rows: number;
    rejected_rows: number;
    rejections: Array<{ line: number; reason: string }>;
    mapping: UploadMapping | null;
    error: string | null;
    completed_at: Date | null;
  }> {
    const row = await this.uploads.findById(uploadId);
    if (!row) throw new NotFoundException(`Upload ${uploadId} not found`);
    return {
      id: row.id,
      status: row.status,
      total_rows: row.total_rows,
      processed_rows: row.processed_rows,
      succeeded_rows: row.succeeded_rows,
      skipped_rows: row.skipped_rows,
      rejected_rows: row.rejected_rows,
      rejections: row.rejections,
      mapping: row.mapping,
      error: row.error,
      completed_at: row.completed_at,
    };
  }
}
