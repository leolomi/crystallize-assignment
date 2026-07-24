import { MongoClientService } from "@crystallize/mongo";
import { Injectable } from "@nestjs/common";
import type { Collection } from "mongodb";

/** The search-index collection both product-facing processors write to. */
export const CATALOGUE_INDEX_COLLECTION = "catalogue_index";

/** One index doc per product; `_id` is deterministic so re-runs upsert, not append. */
export interface CatalogueIndexDoc {
  _id: string; // `${catalogue}:${productId}`
  catalogue: string;
  productId: string;
  price: number;
  indexedAt: Date;
}

/**
 * The runner's handle on the catalogue search index. Owns everything the
 * processors must agree on: the document shape, the deterministic `_id` scheme
 * (`${catalogue}:${productId}`) that the re-index's idempotency rests on, and
 * the `productId` index.
 */
@Injectable()
export class CatalogueIndexRepository {
  private indexReady: Promise<unknown> | null = null;

  constructor(private readonly mongo: MongoClientService) {}

  /**
   * The collection, with its `productId` index ensured once per process —
   * `refreshPrice` does an `updateMany({ productId })` per row, which must
   * never be a collection scan. `createIndex` is idempotent; a failed attempt
   * is retried on the next call rather than poisoning the process.
   */
  private async collection(): Promise<Collection<CatalogueIndexDoc>> {
    const collection = this.mongo.collection<CatalogueIndexDoc>(
      CATALOGUE_INDEX_COLLECTION,
    );
    this.indexReady ??= collection
      .createIndex({ productId: 1 })
      .catch((err) => {
        this.indexReady = null;
        throw err;
      });
    await this.indexReady;
    return collection;
  }

  /**
   * Upsert one page of products into a catalogue's index. Deterministic `_id`s
   * make every page idempotent on its own — re-running converges on the same
   * index.
   */
  async upsertPage(
    catalogue: string,
    products: { id: string; price: number }[],
  ): Promise<void> {
    const collection = await this.collection();
    await collection.bulkWrite(
      products.map((product) => ({
        updateOne: {
          filter: { _id: `${catalogue}:${product.id}` },
          update: {
            $set: {
              catalogue,
              productId: product.id,
              price: product.price,
              indexedAt: new Date(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  /**
   * Refresh a product's price on its existing index docs, in place.
   * Deliberately NOT an upsert — a product absent from the index enters it
   * through the next catalogue re-index, which knows which catalogue(s) it
   * belongs to; the price update doesn't.
   */
  async refreshPrice(productId: string, price: number): Promise<void> {
    const collection = await this.collection();
    await collection.updateMany(
      { productId },
      { $set: { price, indexedAt: new Date() } },
    );
  }
}
