import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { type DrizzleDatabaseProvider, schema } from "@crystallize/database";
import {
  type ProductPriceUpdatePayload,
  TaskKind,
  type TaskRepository,
  type TaskRowRepository,
  TaskStatus,
} from "@crystallize/tasks";
import { eq, sql } from "drizzle-orm";
import type { Collection } from "mongodb";

import {
  closeTestContext,
  getTestContext,
  makeRunner,
  publishTask,
  rowAttempts,
  seedProducts,
} from "../../../test-utils/test-app";
import { RowProcessorRegistry } from "../processors/row-processor";
import type { CatalogueIndexDoc } from "../repositories/catalogue-index.repository";
import type { ProductDoc } from "../repositories/product.repository";

/**
 * End-to-end runner tests against the throwaway docker Postgres + Mongo: the
 * full drain (claim -> rows -> finalize), crash-resume without double-apply,
 * and the same-epoch double-runner race the `pending` guard on mark-done
 * exists for. A fresh RunnerService is built per run — like the real one-shot
 * process, its drain/stand-down state lives and dies with a single run.
 */
let repo: TaskRepository;
let rowRepo: TaskRowRepository;
let db: DrizzleDatabaseProvider;
let products: Collection<ProductDoc>;
let catalogueIndex: Collection<CatalogueIndexDoc>;

beforeAll(async () => {
  // The runner tuning (concurrency, no retry backoff, small re-index pages)
  // lives in getTestContext(), shared by every spec on this context.
  ({ repo, rowRepo, db, products, catalogueIndex } = await getTestContext());
});

/** A registry whose product-price-update processor is the given apply. */
function priceRegistry(
  apply: (
    payload: ProductPriceUpdatePayload,
    signal: AbortSignal,
  ) => Promise<void>,
): RowProcessorRegistry {
  return new RowProcessorRegistry([
    { kind: TaskKind.PRODUCT_PRICE_UPDATE, apply },
  ]);
}

// The global setup truncates Postgres between tests; Mongo is ours to clean.
beforeEach(async () => {
  await products.deleteMany({});
  await catalogueIndex.deleteMany({});
});

afterAll(async () => {
  await closeTestContext();
});

describe("RunnerService.run", () => {
  it("drains a pending task to completion (manual fire claims it itself)", async () => {
    const taskId = await publishTask(
      TaskKind.PRODUCT_PRICE_UPDATE,
      Array.from({ length: 5 }, (_, i) => ({ id: `prod-${i}`, price: i + 1 })),
    );

    await makeRunner().run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(task?.processedRows).toBe(5);
    expect(await products.countDocuments({})).toBe(5);
    // Every row applied exactly once.
    const attempts = await rowAttempts(taskId);
    expect(attempts.every((r) => r.attempts === 1)).toBe(true);
  });

  it("resumes a crashed run without re-applying committed rows", async () => {
    const taskId = await publishTask(
      TaskKind.PRODUCT_PRICE_UPDATE,
      Array.from({ length: 4 }, (_, i) => ({ id: `prod-${i}`, price: i + 1 })),
    );

    // Simulate a predecessor that crashed mid-job: it claimed the task,
    // committed rows 0-1 (ledger flip only — if the resume re-applied them,
    // products WOULD appear), and died without finalizing.
    const epoch = await repo.claimPending(taskId);
    expect(epoch).not.toBeNull();
    const owner = { taskId, epoch: epoch as number };
    await repo.markRunning(owner, 99999);
    const rows = await rowRepo.fetchPendingRows(taskId, 3, 10);
    await rowRepo.markRowDone(rows[0].id, owner);
    await rowRepo.markRowDone(rows[1].id, owner);

    await makeRunner().run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(task?.processedRows).toBe(4);
    // Only rows 2-3 were (re)applied — the done rows were never re-selected.
    const applied = await products.find({}).toArray();
    expect(applied.map((p) => p._id).sort()).toEqual(["prod-2", "prod-3"]);
    const attempts = await rowAttempts(taskId);
    expect(attempts.every((r) => r.attempts === 1)).toBe(true);
  });

  it("applies every row exactly once even when two same-epoch runners race", async () => {
    const taskId = await publishTask(
      TaskKind.PRODUCT_PRICE_UPDATE,
      Array.from({ length: 30 }, (_, i) => ({ id: `prod-${i}`, price: i + 1 })),
    );
    // Claimed once (dispatcher path) — then two runner processes for the same
    // claim, e.g. a manual re-fire racing the dispatcher's still-live runner.
    expect(await repo.claimPending(taskId)).not.toBeNull();

    await Promise.all([makeRunner().run(taskId), makeRunner().run(taskId)]);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(await products.countDocuments({})).toBe(30);
    // The `pending` guard on mark-done: a raced row settles once — the loser's
    // flip misses and the row is skipped, so no row records two applied
    // attempts. (Both racers may run the effect, which is why it must be
    // idempotent.)
    const attempts = await rowAttempts(taskId);
    expect(attempts.every((r) => r.attempts === 1)).toBe(true);
  });

  it("refuses a failed task (replay goes through the retry endpoint)", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "prod-0", price: 1 },
    ]);
    await repo.claimPending(taskId);
    await repo.markFailed(taskId, "poison");

    await makeRunner().run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.FAILED);
    expect(await products.countDocuments({})).toBe(0);
  });

  it("rebuilds the search index from the product store (long external kind)", async () => {
    await seedProducts(15); // 2 pages at REINDEX_PAGE_SIZE=10

    const taskId = await publishTask(TaskKind.CATALOGUE_REINDEX, [
      { catalogue: "products" },
    ]);
    await makeRunner().run(taskId);

    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.COMPLETED);
    // One index doc per seeded product, in the requested catalogue.
    expect(await catalogueIndex.countDocuments({ catalogue: "products" })).toBe(
      15,
    );
  });

  it("price update refreshes the product's index docs, without upserting strangers", async () => {
    await seedProducts(5);
    // Build the index first, so the price update has docs to refresh.
    const reindexId = await publishTask(TaskKind.CATALOGUE_REINDEX, [
      { catalogue: "products" },
    ]);
    await makeRunner().run(reindexId);

    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "prod-0000", price: 100 },
      { id: "prod-0003", price: 300 },
      { id: "prod-9999", price: 999 }, // not in the index
    ]);
    await makeRunner().run(taskId);
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.COMPLETED);

    // The product store holds the new prices (source of truth)…
    expect((await products.findOne({ _id: "prod-0000" }))?.price).toBe(100);
    expect((await products.findOne({ _id: "prod-9999" }))?.price).toBe(999);
    // …and the search index was refreshed in place…
    expect(
      (await catalogueIndex.findOne({ productId: "prod-0000" }))?.price,
    ).toBe(100);
    expect(
      (await catalogueIndex.findOne({ productId: "prod-0003" }))?.price,
    ).toBe(300);
    // …but never upserted: an unindexed product waits for the next re-index.
    expect(await catalogueIndex.findOne({ productId: "prod-9999" })).toBeNull();
    expect(await catalogueIndex.countDocuments({})).toBe(5);
  });

  it("SIGTERM mid-reindex leaves the row pending; the re-run converges idempotently", async () => {
    await seedProducts(50); // 5 pages x 200ms delay ≈ a 1s+ run
    const taskId = await publishTask(TaskKind.CATALOGUE_REINDEX, [
      { catalogue: "products" },
    ]);

    // What main.ts does on SIGTERM, mid-run: the AbortSignal cuts the page
    // loop short and the row goes back untouched.
    const runner = makeRunner();
    const run = runner.run(taskId);
    await Bun.sleep(150);
    runner.requestDrain();
    await run;

    const interrupted = await repo.getTask(taskId);
    expect(interrupted?.status).toBe(TaskStatus.RUNNING); // resumable, not finalized
    expect(await rowRepo.fetchPendingRows(taskId, 3, 10)).toHaveLength(1);

    // A fresh runner re-runs the WHOLE re-index (at-least-once) — and the
    // deterministic _ids make that convergent: 50 docs, no dupes.
    await makeRunner().run(taskId);
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.COMPLETED);
    expect(await catalogueIndex.countDocuments({ catalogue: "products" })).toBe(
      50,
    );
  });
});

/**
 * The failure path, driven by substituted processors on the real executor and
 * ledger: retries, the dead-letter cap, the `failed` finalization, and the
 * retry cycle that re-pends only the dead-lettered rows.
 */
describe("RunnerService.run — row failures", () => {
  it("dead-letters a row that exhausts its attempts and marks the task failed", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "ok-1", price: 1 },
      { id: "poison", price: 2 },
      { id: "ok-2", price: 3 },
    ]);
    const registry = priceRegistry(async ({ id }) => {
      if (id === "poison") throw new Error("boom");
    });

    await makeRunner(registry).run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.FAILED);
    expect(task?.error).toBe("1 row(s) exhausted retries");
    // The healthy rows completed; the poison row burned ROW_MAX_ATTEMPTS (3)
    // attempts, then landed in the DLQ with its last error.
    expect(await rowRepo.countRows(taskId)).toEqual({
      total: 3,
      done: 2,
      failed: 1,
      pending: 0,
    });
    expect(await rowRepo.fetchFailedRows(taskId, 10, 0)).toEqual([
      {
        rowIndex: 1,
        payload: { id: "poison", price: 2 },
        error: "boom",
        attempts: 3,
      },
    ]);
  });

  it("retries a transiently failing row within the same run and completes", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "flaky", price: 1 },
      { id: "ok", price: 2 },
    ]);
    let failures = 0;
    const registry = priceRegistry(async ({ id }) => {
      if (id === "flaky" && failures++ === 0) throw new Error("transient");
    });

    await makeRunner(registry).run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(task?.processedRows).toBe(2);
    // One recorded failure + the successful attempt — never dead-lettered.
    expect((await rowAttempts(taskId)).map((r) => r.attempts)).toEqual([2, 1]);
  });

  it("after retryFailed, a fresh run replays only the dead-lettered row to completion", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "poison", price: 1 },
      { id: "ok", price: 2 },
    ]);
    const poisoned = priceRegistry(async ({ id }) => {
      if (id === "poison") throw new Error("boom");
    });
    await makeRunner(poisoned).run(taskId);
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.FAILED);

    expect(await repo.retryFailed(taskId)).toEqual({
      outcome: "retried",
      retriedRows: 1,
    });

    // The replay (the row's cause is fixed: every apply now succeeds).
    await makeRunner(priceRegistry(async () => {})).run(taskId);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(task?.processedRows).toBe(2);
    expect(await rowRepo.fetchFailedRows(taskId, 10, 0)).toEqual([]);
    // The re-pended row was applied once (attempts were reset by the retry);
    // the already-done row kept its single attempt — it was never re-run.
    expect((await rowAttempts(taskId)).map((r) => r.attempts)).toEqual([1, 1]);
  });

  it("stands down without finalizing when the sweeper reclaims the task mid-run", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    // Applies block on a gate — the window in which the "sweeper" (us, in
    // SQL) advances the epoch, exactly what a reclaim of a frozen-but-alive
    // runner does.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let onFirstApply!: () => void;
    const applying = new Promise<void>((r) => {
      onFirstApply = r;
    });
    const registry = priceRegistry(async () => {
      onFirstApply();
      await gate;
    });

    const run = makeRunner(registry).run(taskId);
    await applying;
    await db
      .update(schema.task)
      .set({ epoch: sql`${schema.task.epoch} + 1` })
      .where(eq(schema.task.id, taskId));
    release();
    await run;

    // The first fenced write missed -> the runner stood down: not finalized
    // (still `running`, for the new owner to resume), nothing checkpointed,
    // and no failed attempt recorded — a lost claim is not a row failure.
    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.RUNNING);
    expect(task?.processedRows).toBe(0);
    expect(await rowRepo.fetchPendingRows(taskId, 3, 10)).toHaveLength(2);
    expect((await rowAttempts(taskId)).map((r) => r.attempts)).toEqual([0, 0]);
  });
});
