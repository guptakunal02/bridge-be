import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, ProductVariant])],
  controllers: [ProductsController],
  providers: [ProductsService],
  // Exported so TicketsModule / CustomerOrdersService can hydrate
  // line_items[].sku → image + title for the Orders sidebar card.
  exports: [ProductsService],
})
export class ProductsModule {}
