import {
  BadRequestException,
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
import { CustomerUploadService } from './customer-upload.service';
import { SegmentsService } from './segments.service';

/**
 * Where multer parks CSVs before the worker drains them. /tmp
 * is ephemeral + process-isolated — perfect for upload scratch
 * space. The worker unlinks files on completion / failure; stray
 * files from a crashed worker get OS-reaped on reboot.
 */
const UPLOAD_DIR = '/tmp/bridge-uploads';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// mkdir once at module-load time; multer's diskStorage expects
// the directory to exist before the first write. Idempotent.
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  /* already exists or race — safe to ignore */
}

/**
 * Admin uploads a CSV against an existing segment. The controller
 * handles multipart ingest + file-size guard; the worker (kicked
 * off inside `CustomerUploadService.create`) owns the parse +
 * upsert + progress loop.
 *
 * Return shape favours polling: POST returns `{uploadId}` immediately,
 * and the admin UI polls GET /uploads/:uid every ~3s until status
 * transitions to COMPLETED or FAILED. All counters are updated per
 * batch, so progress is visible before completion.
 */
@Controller('segments/:segmentId/uploads')
@AdminOnly()
export class CustomerUploadsController {
  constructor(
    private readonly uploads: CustomerUploadService,
    private readonly segments: SegmentsService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          // Timestamp + random suffix prevents collisions between
          // concurrent uploads from different admins. Original name
          // is persisted on the row for the admin UI.
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
  async upload(
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    uploadId: string;
    status: CustomerUploadStatus;
  }> {
    if (!file) throw new BadRequestException('file field is required');
    // Verify segment exists before accepting the upload — otherwise
    // the worker crashes mid-batch with an FK violation and the
    // admin sees FAILED with a confusing message. Fail loud up front.
    await this.segments.findById(segmentId);
    const upload = await this.uploads.create({
      segmentId,
      uploadedBy: user.id,
      fileName: file.originalname,
      fileSize: file.size,
      filePath: file.path,
    });
    return { uploadId: upload.id, status: upload.status };
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
      error: row.error,
      completed_at: row.completed_at,
    };
  }
}
