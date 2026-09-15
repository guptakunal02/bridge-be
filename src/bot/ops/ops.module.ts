import { Module } from '@nestjs/common';
import { OpsReadService } from './ops-read.service';

/**
 * Isolates the ops (surma_common_ops) read layer. Anything that
 * needs order/customer lookups depends on this module; nothing else
 * ever touches the ops DataSource directly.
 */
@Module({
  providers: [OpsReadService],
  exports: [OpsReadService],
})
export class OpsModule {}
