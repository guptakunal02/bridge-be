import { Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CustomersService } from './customers.service';

/**
 * Thin admin-facing surface for Customer records. V1 exposes the
 * opted-out list because that's the admin-visibility promise we
 * made in the automation design (admin wants to see who opted
 * out and why without opening the automation rule or the inbox).
 *
 * A broader "all customers" search / paginate / filter surface
 * can land here later — leaving it unbuilt until the inbound CSV
 * flow surfaces a real reason to touch raw customer rows.
 */
@Controller('customers')
@AdminOnly()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('opted-out')
  async listOptedOut(
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ): Promise<{
    rows: Array<{
      id: string;
      phone: string;
      name: string | null;
      email: string | null;
      opted_out_at: Date | null;
      opted_out_keyword: string | null;
    }>;
    total: number;
  }> {
    const limit = Math.min(500, Math.max(1, Number(limitRaw) || 50));
    const offset = Math.max(0, Number(offsetRaw) || 0);
    const { rows, total } = await this.customers.listOptedOut(limit, offset);
    return {
      rows: rows.map((c) => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        email: c.email,
        opted_out_at: c.opted_out_at,
        opted_out_keyword: c.opted_out_keyword,
      })),
      total,
    };
  }
}
