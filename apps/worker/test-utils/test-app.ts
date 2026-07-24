import {
  DRIZZLE_DATABASE_PROVIDER,
  type DrizzleDatabaseProvider,
  schema,
} from "@crystallize/database";
import { mongoConfig } from "@crystallize/mongo";
import {
  classifyWeight,
  DEFAULT_INLINE_THRESHOLD_ROWS,
  type TaskKind,
  TaskRepository,
  TaskRowRepository,
} from "@crystallize/tasks";
import type { INestApplicationContext } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { asc, eq } from "drizzle-orm";
import { type Collection, MongoClient } from "mongodb";

import { dispatchConfig } from "../src/dispatcher/dispatch/config/dispatch.config";
import { InlineRunner } from "../src/dispatcher/dispatch/services/inline-runner.service";
import { runnerConfig } from "../src/runner/config/runner.config";
import { RowProcessorRegistry } from "../src/runner/processors/row-processor";
import {
  CATALOGUE_INDEX_COLLECTION,
  type CatalogueIndexDoc,
} from "../src/runner/repositories/catalogue-index.repository";
import {
  PRODUCTS_COLLECTION,
  type ProductDoc,
} from "../src/runner/repositories/product.repository";
import { RunnerModule } from "../src/runner/runner.module";
import {
  RUNNER_FACTORY,
  type RunnerFactory,
  type RunnerService,
} from "../src/runner/services/runner.service";

/**
 * Shared runner harness for integration tests: one Nest application context
 * (booted lazily, so a spec can tune `process.env` first — config namespaces
 * materialize at boot), plus direct Mongo handles on the product store and the
 * search index to seed products and assert what the processors built.
 */
let ctx: INestApplicationContext | null = null;
let mongo: MongoClient | null = null;
let repo: TaskRepository;
let rowRepo: TaskRowRepository;
let db: DrizzleDatabaseProvider;
let products: Collection<ProductDoc>;
let catalogueIndex: Collection<CatalogueIndexDoc>;

export interface RunnerTestContext {
  repo: TaskRepository;
  rowRepo: TaskRowRepository;
  db: DrizzleDatabaseProvider;
  products: Collection<ProductDoc>;
  catalogueIndex: Collection<CatalogueIndexDoc>;
}

export async function getTestContext(): Promise<RunnerTestContext> {
  if (!ctx) {
    // Test-tuned runner config, applied before the context boots (config
    // namespaces materialize at boot) so every spec sharing this context gets
    // the same tuning regardless of file order: small re-index pages with a
    // real inter-page delay (a wide SIGTERM-interruption window), no retry
    // backoff. `??=` keeps a spec's own override — set before the first
    // getTestContext() call — authoritative.
    process.env.RUNNER_CONCURRENCY ??= "4";
    process.env.ROW_RETRY_BACKOFF_MS ??= "0";
    process.env.REINDEX_PAGE_SIZE ??= "10";
    process.env.REINDEX_PAGE_DELAY_MS ??= "200";

    ctx = await NestFactory.createApplicationContext(RunnerModule, {
      logger: false,
    });
    repo = ctx.get(TaskRepository);
    rowRepo = ctx.get(TaskRowRepository);
    db = ctx.get(DRIZZLE_DATABASE_PROVIDER);

    const cfg = ctx.get<ConfigType<typeof mongoConfig>>(mongoConfig.KEY);
    mongo = new MongoClient(cfg.url);
    products = mongo.db(cfg.dbName).collection<ProductDoc>(PRODUCTS_COLLECTION);
    catalogueIndex = mongo
      .db(cfg.dbName)
      .collection<CatalogueIndexDoc>(CATALOGUE_INDEX_COLLECTION);
  }
  return { repo, rowRepo, db, products, catalogueIndex };
}

export async function closeTestContext(): Promise<void> {
  await mongo?.close();
  await ctx?.close();
  mongo = null;
  ctx = null;
}

/**
 * The one-shot process in miniature: a fresh service instance per run, built
 * through the same container-owned factory the real paths use. Pass a registry
 * to substitute the processors (poison rows, gated applies) while keeping the
 * executor and repositories real.
 */
export function makeRunner(processors?: RowProcessorRegistry): RunnerService {
  if (!ctx) throw new Error("call getTestContext() first");
  return ctx.get<RunnerFactory>(RUNNER_FACTORY)({ processors });
}

/** The dispatcher's inline path, on the same real executor and repositories. */
export function makeInlineRunner(
  processors?: RowProcessorRegistry,
): InlineRunner {
  if (!ctx) throw new Error("call getTestContext() first");
  const factory = ctx.get<RunnerFactory>(RUNNER_FACTORY);
  // A processors override is threaded through the factory, so even the inline
  // path builds its runner the one way — no hand-wired RunnerService in tests.
  // Literal dispatch config: the runner test context doesn't load the
  // dispatcher's namespace, and only inlineRowConcurrency matters here.
  const dispatchCfg: ConfigType<typeof dispatchConfig> = {
    pollIntervalMs: 1000,
    maxConcurrentRunners: 3,
    maxConcurrentInline: 4,
    inlineRowConcurrency: 2,
    runnerEntrypoint: "unused-in-tests",
    runnerDbMaxConnections: 18,
  };
  return new InlineRunner(
    processors ? (overrides) => factory({ ...overrides, processors }) : factory,
    ctx.get<ConfigType<typeof runnerConfig>>(runnerConfig.KEY),
    dispatchCfg,
  );
}

/** Create a published (claimable) task with the given payload rows. */
export async function publishTask(
  kind: TaskKind,
  payloads: Record<string, unknown>[],
): Promise<string> {
  const taskId = await repo.createTask(kind);
  await rowRepo.addRows(
    taskId,
    payloads.map((payload, rowIndex) => ({ rowIndex, payload })),
  );
  await repo.setTotalRows(taskId, payloads.length);
  await repo.markPending(
    taskId,
    classifyWeight(kind, payloads.length, DEFAULT_INLINE_THRESHOLD_ROWS),
  );
  return taskId;
}

/** Seed products for the re-index to walk (padded ids: stable keyset order). */
export async function seedProducts(n: number): Promise<void> {
  await products.insertMany(
    Array.from({ length: n }, (_, i) => ({
      _id: `prod-${String(i).padStart(4, "0")}`,
      price: i + 1,
      updatedAt: new Date(),
    })),
  );
}

/** Per-row applied attempts, in row order — the no-double-apply witness. */
export function rowAttempts(taskId: string) {
  return db
    .select({ attempts: schema.taskRow.attempts })
    .from(schema.taskRow)
    .where(eq(schema.taskRow.taskId, taskId))
    .orderBy(asc(schema.taskRow.rowIndex));
}
