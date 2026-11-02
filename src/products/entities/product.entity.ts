import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProductVariant } from './product-variant.entity';

/**
 * One row per Shopify PRODUCT (not variant). Keyed by
 * `shopify_handle` for cheap re-imports — the CSV importer upserts
 * ON CONFLICT (shopify_handle) so re-running with a fresh export
 * updates stale fields instead of duplicating.
 *
 * The 1:N relationship with ProductVariant lets us join
 * `line_items.sku` on an order payload → variant → product and
 * recover the right title + primary image for the Orders sidebar
 * card, without re-fetching from Shopify at render time.
 */
@Entity({ name: 'product' })
@Index(['shopify_handle'], { unique: true })
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** URL slug from Shopify's product.handle. Natural upsert key. */
  @Column({ type: 'text', name: 'shopify_handle' })
  shopify_handle!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  vendor!: string | null;

  /** 'active' / 'draft' / 'archived' per the Shopify CSV Status column. */
  @Column({ type: 'text', nullable: true })
  status!: string | null;

  /** The Shopify "Type" classification string. */
  @Column({ type: 'text', nullable: true, name: 'product_type' })
  product_type!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  /** Position-1 image. Fallback used when a variant has no own image. */
  @Column({ type: 'text', nullable: true, name: 'primary_image_url' })
  primary_image_url!: string | null;

  /** All image URLs for the product, ordered by Shopify's Image Position. */
  @Column({
    type: 'text',
    array: true,
    default: () => "'{}'",
    name: 'image_urls',
  })
  image_urls!: string[];

  @Column({ type: 'text', nullable: true, name: 'body_html' })
  body_html!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => ProductVariant, (v) => v.product)
  variants!: ProductVariant[];
}
