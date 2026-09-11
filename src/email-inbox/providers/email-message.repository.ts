import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { EmailMessage } from '../entities/email-message.entity';

/**
 * Custom repository for EmailMessage.
 *
 * Extends TypeORM's `Repository<T>` so every base method (`find`,
 * `findOne`, `save`, `update`, `delete`, `createQueryBuilder`, …) is
 * available for free. Domain-specific queries live under the
 * "Custom queries" section below.
 *
 * Registered as a provider in `EmailInboxModule` — inject with:
 *
 *   constructor(private readonly emails: EmailMessageRepository) {}
 *
 * ...and call `this.emails.find(...)` etc.
 */
@Injectable()
export class EmailMessageRepository extends Repository<EmailMessage> {
  constructor(dataSource: DataSource) {
    // Bind this repository to the EmailMessage entity using the
    // application's shared EntityManager so it participates in the
    // same transaction/connection pool as the rest of the app.
    super(EmailMessage, dataSource.createEntityManager());
  }

  // ---- Custom queries ---------------------------------------------------
  // Add custom queries here
}
