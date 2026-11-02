import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Product } from './product.entity';

/**
 * One row per Shopify VARIANT. The `sku` is the join key with order
 * webhook payloads — `line_items[].sku` on orders/create matches
 * `product_variant.sku` here, giving us the right title + image on
 * the Orders sidebar card without a Shopify API call.
 *
 * Cascade-deletes with its parent product so the one-time CSV
 * importer can re-run cleanly: dropping a product's variant that no
 * longer exists on Shopify's side is handled implicitly by the
 * importer's upsert-and-reconcile step.
 */
@Entity({ name: 'product_variant' })
@Index(['sku'], { unique: true })
@Index(['product_id'])
export class ProductVariant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'product_id' })
  product_id!: string;

  @ManyToOne(() => Product, (p) => p.variants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  /** Shopify variant SKU — natural upsert key, join target from orders. */
  @Column({ type: 'text' })
  sku!: string;

  /**
   * Shopify's "Option1 Value" — in Surma's catalogue this is always the
   * size (XS / S / M / …). Other option names (Color, Material) could
   * land here too if Surma adds them later; we store the raw value and
   * let the FE label it generically ("Variant" / "Option").
   */
  @Column({ type: 'text', nullable: true, name: 'option_value' })
  option_value!: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  price!: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    name: 'compare_at_price',
  })
  compare_at_price!: string | null;

  @Column({ type: 'integer', nullable: true, name: 'inventory_qty' })
  inventory_qty!: number | null;

  /** Variant-specific image. Falls back to Product.primary_image_url. */
  @Column({ type: 'text', nullable: true, name: 'variant_image_url' })
  variant_image_url!: string | null;

  @Column({ type: 'text', nullable: true })
  barcode!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
