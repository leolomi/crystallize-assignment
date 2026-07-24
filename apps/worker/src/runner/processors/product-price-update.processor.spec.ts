import { describe, expect, it } from "bun:test";

import { createMock } from "../../../../../test-utils/mocks";
import type { CatalogueIndexRepository } from "../repositories/catalogue-index.repository";
import type { ProductRepository } from "../repositories/product.repository";
import { ProductPriceUpdateProcessor } from "./product-price-update.processor";

/**
 * Pins the ONE invariant the runner integration tests cannot observe: the
 * write ORDER. Source before projection — inverted, the final state would be
 * identical (both writes land), but a crash between the two would leave the
 * index AHEAD of the product store instead of behind it. Behind is healed by
 * the next re-index; ahead never is.
 */
describe("ProductPriceUpdateProcessor.apply", () => {
  it("writes the product store before refreshing the index", async () => {
    const products = createMock<ProductRepository>();
    const catalogueIndex = createMock<CatalogueIndexRepository>();
    const processor = new ProductPriceUpdateProcessor(products, catalogueIndex);

    await processor.apply({ id: "p1", price: 9.99 });

    expect(products.upsertPrice).toHaveBeenCalledWith("p1", 9.99);
    expect(catalogueIndex.refreshPrice).toHaveBeenCalledWith("p1", 9.99);
    expect(products.upsertPrice.mock.invocationCallOrder[0]).toBeLessThan(
      catalogueIndex.refreshPrice.mock.invocationCallOrder[0],
    );
  });
});
