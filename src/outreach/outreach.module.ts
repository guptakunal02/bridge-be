import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappTemplate } from '../whatsapp-inbox/entities/whatsapp-template.entity';
import { WhatsappInboxModule } from '../whatsapp-inbox/whatsapp-inbox.module';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastWorkerService } from './broadcast-worker.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerUploadsController } from './customer-uploads.controller';
import { CustomerUploadService } from './customer-upload.service';
import { Broadcast } from './entities/broadcast.entity';
import { BroadcastRecipient } from './entities/broadcast-recipient.entity';
import { Customer } from './entities/customer.entity';
import { CustomerUpload } from './entities/customer-upload.entity';
import { Segment } from './entities/segment.entity';
import { SegmentCustomer } from './entities/segment-customer.entity';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

/**
 * Marketing domain: contacts (Customer), named audiences (Segment),
 * bulk ingest (CustomerUpload), broadcasts. Opt-out behaviour is NOT
 * owned here — it's a composable automation action
 * (`opt_out_customer`) in src/automations that calls into
 * CustomersService.applyOptOut; this module exports CustomersService
 * so the automation handler can inject it.
 *
 * WhatsappInboxModule is imported (via forwardRef) because the
 * broadcast worker uses WhatsappSenderService to fire template
 * sends, and we need WhatsappTemplate entity registration here for
 * the broadcast service to load templates during snapshot. The
 * forwardRef is defensive against future circular deps if the
 * automation path pulls segments context into template rendering.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      Segment,
      SegmentCustomer,
      CustomerUpload,
      Broadcast,
      BroadcastRecipient,
      WhatsappTemplate,
    ]),
    forwardRef(() => WhatsappInboxModule),
  ],
  providers: [
    CustomersService,
    SegmentsService,
    CustomerUploadService,
    BroadcastsService,
    BroadcastWorkerService,
  ],
  controllers: [
    SegmentsController,
    CustomerUploadsController,
    CustomersController,
    BroadcastsController,
  ],
  exports: [
    CustomersService,
    SegmentsService,
    CustomerUploadService,
    BroadcastsService,
    BroadcastWorkerService,
  ],
})
export class OutreachModule {}
