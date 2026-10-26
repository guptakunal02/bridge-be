import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerUploadsController } from './customer-uploads.controller';
import { CustomerUploadService } from './customer-upload.service';
import { Customer } from './entities/customer.entity';
import { CustomerUpload } from './entities/customer-upload.entity';
import { Segment } from './entities/segment.entity';
import { SegmentCustomer } from './entities/segment-customer.entity';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

/**
 * Marketing-side domain: contacts (Customer), named audiences
 * (Segment), bulk ingest jobs (CustomerUpload). Opt-out behaviour
 * is NOT owned here — it's a composable automation action
 * (`opt_out_customer`) that lives in src/automations and calls
 * back into CustomersService.applyOptOut; this module just
 * exports CustomersService so the automation handler can inject
 * it.
 *
 * No forwardRef / WhatsappInboxModule import — the opt-out ack
 * message is sent via the existing `send_whatsapp_template`
 * action, which already lives in the automation dispatcher's
 * dependency graph.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      Segment,
      SegmentCustomer,
      CustomerUpload,
    ]),
  ],
  providers: [CustomersService, SegmentsService, CustomerUploadService],
  controllers: [
    SegmentsController,
    CustomerUploadsController,
    CustomersController,
  ],
  exports: [CustomersService, SegmentsService, CustomerUploadService],
})
export class OutreachModule {}
