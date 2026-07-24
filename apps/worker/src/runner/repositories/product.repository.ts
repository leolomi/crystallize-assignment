import { MongoClientService } from "@crystallize/mongo";
import { Injectable } from "@nestjs/common";
import type { Collection } from "mongodb";

/** The product store. Business data lives in Mongo; Postgres holds task state only. */
export const PRODUCTS_COLLECTION = "products";

/** One doc per product; `_id` is the natural product id. */
export interface ProductDoc {
  _id: string;
  price: number;
  updatedAt: Date;
}

/**
 * The runner's handle on the product store. Every write is an idempotent
 * upsert of absolute state (never a delta), so the at-least-once row replay
 * after a crash converges instead of compounding — the correctness regime the
 * whole runner relies on (ADR 0003).
 */
@Injectable()
export class ProductRepository {
  constructor(private readonly mongo: MongoClientService) {}

  private get collection(): Collection<ProductDoc> {
    return this.mongo.collection<ProductDoc>(PRODUCTS_COLLECTION);
  }

  /** Set a product's price (creating the product if unknown). Idempotent. */
  async upsertPrice(id: string, price: number): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { price, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  /**
   * Keyset page over products in `_id` order — the re-index's read side.
   * Rides the built-in `_id` index, so paging never scans the collection.
   */
  async pageAfter(
    lastId: string,
    limit: number,
  ): Promise<{ id: string; price: number }[]> {
    const docs = await this.collection
      .find({ _id: { $gt: lastId } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({ id: doc._id, price: doc.price }));
  }
}
