import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  TaskKind,
  type TaskRepository,
  type TaskRowRepository,
  TaskStatus,
} from "@crystallize/tasks";
import type { SchedulerRegistry } from "@nestjs/schedule";
import type { Collection } from "mongodb";

import { createMock } from "../../../../../../test-utils/mocks";
import {
  closeTestContext,
  getTestContext,
  makeInlineRunner,
  publishTask,
} from "../../../../test-utils/test-app";
import {
  type RowProcessor,
  RowProcessorRegistry,
} from "../../../runner/processors/row-processor";
import type { ProductDoc } from "../../../runner/repositories/product.repository";
import { interruptibleSleep } from "../../../runner/utils/sleep";
import { Dispatcher } from "./dispatcher.service";
import type { InlineRunner } from "./inline-runner.service";
import type { RunnerLauncher } from "./runner-launcher.service";

/**
 * Integration tests for the inline execution path, through its real entry
 * point: Dispatcher.tick() claims from the throwaway docker Postgres and
 * routes into a real InlineRunner (real executor, repositories, processors) —
 * only the process-spawning launcher is stubbed. Covers what the dispatcher
 * unit spec cannot: the slot bookkeeping over an actual run's lifetime, the
 * shutdown drain, and crash containment.
 */
let repo: TaskRepository;
let rowRepo: TaskRowRepository;
let products: Collection<ProductDoc>;
let launched: string[];

beforeAll(async () => {
  ({ repo, rowRepo, products } = await getTestContext());
});

beforeEach(async () => {
  launched = [];
  await products.deleteMany({});
});

afterAll(async () => {
  await closeTestContext();
});

/** A dispatcher on the real repo + inline path; only the launcher is stubbed. */
function makeDispatcher(inline: InlineRunner): Dispatcher {
  const launcher = {
    get activeCount() {
      return launched.length;
    },
    launch: (taskId: string) => void launched.push(taskId),
  } as unknown as RunnerLauncher;
  return new Dispatcher(
    repo,
    launcher,
    inline,
    createMock<SchedulerRegistry>(),
    {
      pollIntervalMs: 60_000,
      maxConcurrentRunners: 8,
      maxConcurrentInline: 4,
      runnerEntrypoint: "unused-in-tests",
      runnerDbMaxConnections: 5,
      inlineRowConcurrency: 4,
    },
  );
}

/** Inline runs are fire-and-track: completion is observed via the slot count. */
async function waitForIdle(inline: InlineRunner): Promise<void> {
  while (inline.activeCount > 0) {
    await Bun.sleep(10);
  }
}

describe("InlineRunner (via Dispatcher.tick)", () => {
  it("runs a claimed light task inline to completion, then frees its slot", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "p1", price: 1 },
      { id: "p2", price: 2 },
    ]);
    const inline = makeInlineRunner();

    await makeDispatcher(inline).tick();
    // The tick returned with the run still in flight — fired, not awaited.
    expect(inline.activeCount).toBe(1);
    await waitForIdle(inline);

    const task = await repo.getTask(taskId);
    expect(task?.status).toBe(TaskStatus.COMPLETED);
    expect(task?.processedRows).toBe(2);
    expect(await products.countDocuments({})).toBe(2);
    expect(launched).toEqual([]); // light never reaches the launcher
  });

  it("routes a heavy claim to the launcher — never inline", async () => {
    const taskId = await publishTask(TaskKind.CATALOGUE_REINDEX, [
      { catalogue: "products" },
    ]);
    const inline = makeInlineRunner();

    await makeDispatcher(inline).tick();

    expect(launched).toEqual([taskId]);
    expect(inline.activeCount).toBe(0);
    // Claimed for the (stubbed) runner process; nothing has run it.
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.STARTING);
  });

  it("onApplicationShutdown drains in-flight runs and leaves their task resumable", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "slow", price: 1 },
    ]);
    let onApply!: () => void;
    const applying = new Promise<void>((r) => {
      onApply = r;
    });
    // A long external-style apply: interruptible, so the drain's abort cuts it
    // short and the row goes back untouched — the rolling-deploy case.
    const slow: RowProcessor<TaskKind.PRODUCT_PRICE_UPDATE> = {
      kind: TaskKind.PRODUCT_PRICE_UPDATE,
      apply: async (_payload, signal) => {
        onApply();
        await interruptibleSleep(60_000, signal);
      },
    };
    const inline = makeInlineRunner(new RowProcessorRegistry([slow]));

    inline.run(taskId); // what the tick does right after its claim
    await applying;
    await inline.onApplicationShutdown();

    // Same contract as the one-shot process on SIGTERM: the run is over, the
    // task is left `running` for a fresh runner to resume, no failure recorded.
    expect(inline.activeCount).toBe(0);
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.RUNNING);
    expect(await rowRepo.fetchPendingRows(taskId, 3, 10)).toHaveLength(1);
  });

  it("frees the slot when a run crashes, leaving the claimed task to the sweeper", async () => {
    const taskId = await publishTask(TaskKind.PRODUCT_PRICE_UPDATE, [
      { id: "p1", price: 1 },
    ]);
    // An empty registry: the run blows up right after its claim (no processor
    // for the kind) — a stand-in for any unexpected inline crash.
    const inline = makeInlineRunner(new RowProcessorRegistry([]));

    inline.run(taskId);
    await waitForIdle(inline);

    expect(inline.activeCount).toBe(0);
    // Claimed then orphaned — exactly what the sweeper's reclaim exists for.
    expect((await repo.getTask(taskId))?.status).toBe(TaskStatus.STARTING);
  });
});
