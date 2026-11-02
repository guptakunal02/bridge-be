import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductVariant } from './entities/product-variant.entity';

/**
 * Shape returned to the Products sidebar tab + used internally for
 * line-item hydration on the Orders sidebar. We ship variants
 * flattened under the product (consistent with Shopify's own payload
 * shape) so the FE renders one card per product + a variant picker.
 */
export interface ProductWithVariants {
  id: string;
  shopify_handle: string;
  title: string;
  vendor: string | null;
  status: string | null;
  product_type: string | null;
  tags: string[];
  primary_image_url: string | null;
  image_urls: string[];
  variants: Array<{
    id: string;
    sku: string;
    option_value: string | null;
    price: string | null;
    compare_at_price: string | null;
    inventory_qty: number | null;
    variant_image_url: string | null;
  }>;
}

/**
 * Hydrated line-item used by customer-orders. Keyed by SKU so the
 * caller can zip into the order's line_items[] array without having
 * to know anything about the catalog table shapes.
 */
export interface LineItemHydration {
  sku: string;
  productId: string;
  productHandle: string;
  productTitle: string;
  variantOption: string | null;
  imageUrl: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(ProductVariant)
    private readonly variants: Repository<ProductVariant>,
  ) {}

  /**
   * Search by title (ILIKE %q%) OR by SKU (ILIKE %q%). Keeps the
   * Products tab's single input box simple — the admin types either
   * a word from the product name or a partial SKU and the right rows
   * surface. ACTIVE status only by default so draft / archived SKUs
   * don't clutter the catalogue.
   *
   * Pagination: offset-based keyed by `offset` + `limit`. Cheap for
   * the catalogue sizes Surma has (~2k products). We'll switch to
   * keyset if the catalogue grows past 50k.
   */
  async list(input: {
    q?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ items: ProductWithVariants[]; total: number }> {
    const q = input.q?.trim();
    const qb = this.products
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.variants', 'v')
      .orderBy('p.title', 'ASC')
      .addOrderBy('v.sku', 'ASC')
      .take(input.limit)
      .skip(input.offset);
    if (q && q.length > 0) {
      // Match product title OR any variant SKU on this product.
      qb.andWhere(
        '(p.title ILIKE :q OR EXISTS (' +
          'SELECT 1 FROM product_variant pv ' +
          'WHERE pv.product_id = p.id AND pv.sku ILIKE :q))',
        { q: `%${q}%` },
      );
    }
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => this.toResponse(r)),
      total,
    };
  }

  /**
   * Batched variant lookup by SKU. Used by customer-orders.service to
   * hydrate line_items on the Orders sidebar card — one query per
   * ticket detail render regardless of how many line items the order
   * has.
   */
  async hydrateLineItemsBySku(
    skus: string[],
  ): Promise<Map<string, LineItemHydration>> {
    const unique = Array.from(new Set(skus.filter((s) => s.trim().length > 0)));
    if (unique.length === 0) return new Map();
    const rows = await this.variants.find({
      where: { sku: In(unique) },
      relations: { product: true },
    });
    const out = new Map<string, LineItemHydration>();
    for (const v of rows) {
      out.set(v.sku, {
        sku: v.sku,
        productId: v.product.id,
        productHandle: v.product.shopify_handle,
        productTitle: v.product.title,
        variantOption: v.option_value,
        imageUrl: v.variant_image_url ?? v.product.primary_image_url ?? null,
      });
    }
    return out;
  }

  private toResponse(p: Product): ProductWithVariants {
    return {
      id: p.id,
      shopify_handle: p.shopify_handle,
      title: p.title,
      vendor: p.vendor,
      status: p.status,
      product_type: p.product_type,
      tags: p.tags,
      primary_image_url: p.primary_image_url,
      image_urls: p.image_urls,
      variants: (p.variants ?? []).map((v) => ({
        id: v.id,
        sku: v.sku,
        option_value: v.option_value,
        price: v.price,
        compare_at_price: v.compare_at_price,
        inventory_qty: v.inventory_qty,
        variant_image_url: v.variant_image_url,
      })),
    };
  }
}
