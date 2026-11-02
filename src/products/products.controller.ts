import { Controller, Get, Query } from '@nestjs/common';
import {
  ProductsService,
  type ProductWithVariants,
} from './products.service';

export interface ProductListResponse {
  items: ProductWithVariants[];
  total: number;
}

/**
 * Catalogue endpoint — powers the Products sidebar tab on ticket
 * detail (and will power the composer "insert product link" affordance
 * when we add that in v2). Auth: any signed-in user (same as Tags);
 * no admin-only guard because browsing catalogue is a read-only
 * convenience for every agent.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ): Promise<ProductListResponse> {
    // Cap at 100 rows so an admin accidentally hitting ?limit=10000
    // can't drag the entire catalogue over the wire. 24 (6-wide grid
    // × 4 rows) is a reasonable UI default when the client doesn't
    // specify.
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 24));
    const offset = Math.max(0, Number(offsetRaw) || 0);
    return this.products.list({ q: q ?? null, limit, offset });
  }
}
