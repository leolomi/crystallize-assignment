import { type CatalogueReindexPayload, TaskKind } from "@crystallize/tasks";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { runnerConfig } from "../config/runner.config";
import { CatalogueIndexRepository } from "../repositories/catalogue-index.repository";
import { ProductRepository } from "../repositories/product.repository";
import { interruptibleSleep } from "../utils/sleep";
import type { RowProcessor } from "./row-processor";

/**
 * Catalogue re-index: a single-row task that rebuilds the search index from
 * the product store, page by page (Mongo -> Mongo: `products` is the source,
 * `catalogue_index` the per-catalogue projection).
 *
 * The rebuild is idempotent — every doc is an upsert under a deterministic
 * `_id` (`catalogue:productId`) — so the at-least-once replay after a crash
 * converges on the same index. A crash between the effect and mark-done
 * simply re-runs the whole re-index (coarse but safe, see ADR 0005).
 *
 * The work is interruptible between pages: on SIGTERM the AbortSignal fires,
 * the page loop throws, and the row is left pending for the next runner to
 * re-run — the rolling-deploy case for a long external job. The inter-page
 * delay (REINDEX_PAGE_DELAY_MS) throttles the rebuild and keeps that
 * interruption window comfortable in the demo.
 */
@Injectable()
export class CatalogueReindexProcessor
  implements RowProcessor<TaskKind.CATALOGUE_REINDEX>
{
  readonly kind = TaskKind.CATALOGUE_REINDEX;
  private readonly log = new Logger(CatalogueReindexProcessor.name);

  constructor(
    private readonly products: ProductRepository,
    private readonly catalogueIndex: CatalogueIndexRepository,
    @Inject(runnerConfig.KEY)
    private readonly config: ConfigType<typeof runnerConfig>,
  ) {}

  async apply(
    { catalogue }: CatalogueReindexPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const { reindexPageSize, reindexPageDelayMs } = this.config;
    this.log.log(
      `Reindexing catalogue [${catalogue}] (pages of ${reindexPageSize})…`,
    );

    let lastId = "";
    let indexed = 0;
    for (;;) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");

      const page = await this.products.pageAfter(lastId, reindexPageSize);
      if (page.length === 0) break;

      await this.catalogueIndex.upsertPage(catalogue, page);
      indexed += page.length;
      lastId = page[page.length - 1].id;

      // Throttle between pages — also the SIGTERM interruption seam.
      if (reindexPageDelayMs > 0) {
        await interruptibleSleep(reindexPageDelayMs, signal);
      }
    }

    this.log.log(
      `Reindex of [${catalogue}] complete (${indexed} products indexed)`,
    );
  }
}
