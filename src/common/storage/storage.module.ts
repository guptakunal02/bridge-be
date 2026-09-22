import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { S3StorageService } from './s3-storage.service';

/**
 * File / object storage — currently a single S3 backend for email
 * attachments. Global because callers across every feature module
 * (email ingest, future outbound-reply attachments, etc.) will need
 * to reach it without importing the module ceremony each time.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [S3StorageService],
  exports: [S3StorageService],
})
export class StorageModule {}
