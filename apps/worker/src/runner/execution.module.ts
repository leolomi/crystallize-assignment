import { MongoModule } from "@crystallize/mongo";
import {
  TaskModule,
  TaskRepository,
  TaskRowRepository,
} from "@crystallize/tasks";
import { Module, type Provider } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { runnerConfig } from "./config/runner.config";
import { CatalogueReindexProcessor } from "./processors/catalogue-reindex.processor";
import { ProductPriceUpdateProcessor } from "./processors/product-price-update.processor";
import {
  ROW_PROCESSORS,
  RowProcessorRegistry,
} from "./processors/row-processor";
import { CatalogueIndexRepository } from "./repositories/catalogue-index.repository";
import { ProductRepository } from "./repositories/product.repository";
import { RowExecutor } from "./services/row-executor.service";
import {
  RUNNER_FACTORY,
  type RunnerFactory,
  RunnerService,
} from "./services/runner.service";

/**
 * The ordered processor list injected into RowProcessorRegistry — one entry per
 * task kind. Add a kind's processor here.
 */
const rowProcessorsProvider: Provider = {
  provide: ROW_PROCESSORS,
  inject: [ProductPriceUpdateProcessor, CatalogueReindexProcessor],
  useFactory: (
    product: ProductPriceUpdateProcessor,
    reindex: CatalogueReindexProcessor,
  ) => [product, reindex],
};

/**
 * The curried RUNNER_FACTORY builder: the container injects the shared
 * dependencies once, and the returned RunnerFactory stamps out a fresh
 * RunnerService per task (optionally with a substituted processor registry
 * or a per-instance concurrency — see RunnerOverrides).
 */
function buildRunnerFactory(
  repo: TaskRepository,
  rowRepo: TaskRowRepository,
  executor: RowExecutor,
  processors: RowProcessorRegistry,
  config: ConfigType<typeof runnerConfig>,
): RunnerFactory {
  return (overrides) =>
    new RunnerService(
      repo,
      rowRepo,
      executor,
      overrides?.processors ?? processors,
      overrides?.concurrency === undefined
        ? config
        : { ...config, concurrency: overrides.concurrency },
    );
}

const runnerFactoryProvider: Provider = {
  provide: RUNNER_FACTORY,
  inject: [
    TaskRepository,
    TaskRowRepository,
    RowExecutor,
    RowProcessorRegistry,
    runnerConfig.KEY,
  ],
  useFactory: buildRunnerFactory,
};

/**
 * The row-execution core — processors, Mongo repositories, executor — shared by
 * the worker's two execution paths: the one-shot runner process (RunnerModule)
 * and the dispatcher's inline path for light tasks (threshold routing,
 * ADR 0006). Re-exports TaskModule so consumers can build RunnerService
 * instances without re-importing the repositories.
 *
 * RunnerService is not a provider: it holds per-run state, so it must never be
 * a shared singleton. RUNNER_FACTORY is the single container-owned construction
 * site — both execution paths (and the tests) build their fresh instances
 * through it, so a change to RunnerService's dependencies is wired in one place.
 */
@Module({
  imports: [MongoModule, TaskModule],
  providers: [
    CatalogueIndexRepository,
    ProductRepository,
    ProductPriceUpdateProcessor,
    CatalogueReindexProcessor,
    rowProcessorsProvider,
    RowProcessorRegistry,
    RowExecutor,
    runnerFactoryProvider,
  ],
  exports: [RowExecutor, RowProcessorRegistry, RUNNER_FACTORY, TaskModule],
})
export class ExecutionModule {}
