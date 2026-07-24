import { type ProductPriceUpdatePayload, TaskKind } from "@crystallize/tasks";
import { Injectable } from "@nestjs/common";
import { CatalogueIndexRepository } from "../repositories/catalogue-index.repository";
import { ProductRepository } from "../repositories/product.repository";
import type { RowProcessor } from "./row-processor";

/**
 * Bulk product price update. Two idempotent writes, source before projection:
 *
 *  1. upsert the price on the product store — the payload carries the absolute
 *     price, so a crash-replay converges;
 *  2. refresh the product's existing search-index docs in place (see
 *     CatalogueIndexRepository.refreshPrice for why it is deliberately not an
 *     upsert — an unindexed product enters the index via the next re-index,
 *     which also catches up any doc a crash left stale between these writes).
 */
@Injectable()
export class ProductPriceUpdateProcessor
  implements RowProcessor<TaskKind.PRODUCT_PRICE_UPDATE>
{
  readonly kind = TaskKind.PRODUCT_PRICE_UPDATE;

  constructor(
    private readonly products: ProductRepository,
    private readonly catalogueIndex: CatalogueIndexRepository,
  ) {}

  async apply({ id, price }: ProductPriceUpdatePayload): Promise<void> {
    await this.products.upsertPrice(id, price);
    await this.catalogueIndex.refreshPrice(id, price);
  }
}
