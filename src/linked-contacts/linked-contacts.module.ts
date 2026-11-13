import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from '../outreach/entities/customer.entity';
import { LinkedContactsService } from './linked-contacts.service';

/**
 * Cross-channel customer identity enrichment. Thin service wrapping a
 * Lens (surma-ops) HTTP call + an upsert into the customer table —
 * imported by the two ingest modules (email + whatsapp) so a freshly
 * minted ticket's phone/email can be linked to its Shopify twin for
 * the related-tickets sidebar.
 *
 * The Customer repo is injected via TypeOrmModule.forFeature here
 * (rather than depending on OutreachModule) to keep the dependency
 * graph tight — OutreachModule carries campaign / audience plumbing
 * we don't need on the ingest path.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Customer])],
  providers: [LinkedContactsService],
  exports: [LinkedContactsService],
})
export class LinkedContactsModule {}
